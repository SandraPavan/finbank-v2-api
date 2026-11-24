// Papel de execução: atributos, privilégios exatos e recusas por privilégio no PostgreSQL real.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TEST_RUNTIME_USER } from './global-setup.js';
import { balanceOf, counts, fundedWorkspace, type Harness, harness, opKey, sqlState } from './payment-execution/support.js';

const GROUP = 'finbank_runtime';
const INSUFFICIENT_PRIVILEGE = '42501';

describe('papel de execução no PostgreSQL', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'), inject('appDatabaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  it('a aplicação conecta como usuário de execução sem atributos administrativos', async () => {
    const [who] = await h.app.client.$queryRaw<{ user: string }[]>`SELECT current_user::text AS "user"`;
    expect(who?.user).toBe(TEST_RUNTIME_USER);

    const roles = await h.db.client.$queryRaw<
      { name: string; login: boolean; superuser: boolean; createrole: boolean; createdb: boolean; replication: boolean; bypassrls: boolean }[]
    >`
      SELECT rolname::text AS "name", rolcanlogin AS "login", rolsuper AS "superuser", rolcreaterole AS "createrole",
             rolcreatedb AS "createdb", rolreplication AS "replication", rolbypassrls AS "bypassrls"
        FROM pg_roles WHERE rolname IN (${TEST_RUNTIME_USER}, ${GROUP}) ORDER BY rolname`;
    const restricted = { superuser: false, createrole: false, createdb: false, replication: false, bypassrls: false };
    expect(roles).toEqual([
      { name: TEST_RUNTIME_USER, login: true, ...restricted },
      { name: GROUP, login: false, ...restricted },
    ]);

    const [member] = await h.db.client.$queryRaw<{ member: boolean }[]>`
      SELECT pg_has_role(${TEST_RUNTIME_USER}, ${GROUP}, 'MEMBER') AS "member"`;
    expect(member?.member).toBe(true);
  });

  it('o papel de execução não é dono de nenhum objeto', async () => {
    const [owned] = await h.db.client.$queryRaw<{ total: number }[]>`
      SELECT (
        (SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname IN (${TEST_RUNTIME_USER}, ${GROUP}))
      + (SELECT count(*) FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname IN (${TEST_RUNTIME_USER}, ${GROUP}))
      + (SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE r.rolname IN (${TEST_RUNTIME_USER}, ${GROUP}))
      + (SELECT count(*) FROM pg_type t JOIN pg_roles r ON r.oid = t.typowner WHERE r.rolname IN (${TEST_RUNTIME_USER}, ${GROUP}))
      )::int AS "total"`;
    expect(owned?.total).toBe(0);
  });

  it('os privilégios correspondem exatamente à matriz aprovada', async () => {
    const tables = await h.db.client.$queryRaw<{ grant: string }[]>`
      SELECT c.relname || ':' || a.privilege_type AS "grant"
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) a
        JOIN pg_roles r ON r.oid = a.grantee
       WHERE c.relnamespace = 'public'::regnamespace AND r.rolname = ${GROUP}
       ORDER BY 1`;
    expect(tables.map((t) => t.grant)).toEqual([
      'account:INSERT',
      'account:SELECT',
      'ledger_entry:INSERT',
      'ledger_entry:SELECT',
      'payment_operation:INSERT',
      'payment_operation:SELECT',
      'user_identity:SELECT',
      'workspace:SELECT',
      'workspace_membership:SELECT',
    ]);

    const columns = await h.db.client.$queryRaw<{ grant: string }[]>`
      SELECT c.relname || '.' || at.attname || ':' || a.privilege_type AS "grant"
        FROM pg_attribute at
        JOIN pg_class c ON c.oid = at.attrelid
        CROSS JOIN LATERAL aclexplode(at.attacl) a
        JOIN pg_roles r ON r.oid = a.grantee
       WHERE c.relnamespace = 'public'::regnamespace AND r.rolname = ${GROUP}
       ORDER BY 1`;
    expect(columns.map((c) => c.grant)).toEqual(['account.balance_cents:UPDATE']);

    const [publicGrants] = await h.db.client.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS "total"
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 0`;
    expect(publicGrants?.total).toBe(0);

    const [schema] = await h.db.client.$queryRaw<{ usage: boolean; create: boolean }[]>`
      SELECT has_schema_privilege(${GROUP}, 'public', 'USAGE') AS "usage",
             has_schema_privilege(${GROUP}, 'public', 'CREATE') AS "create"`;
    expect(schema).toEqual({ usage: true, create: false });
  });

  it('o usuário de login não tem privilégios diretos e só pertence ao papel de grupo', async () => {
    const [direct] = await h.db.client.$queryRaw<{ total: number }[]>`
      SELECT (
        (SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = ${TEST_RUNTIME_USER})
      + (SELECT count(*) FROM pg_attribute t CROSS JOIN LATERAL aclexplode(t.attacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = ${TEST_RUNTIME_USER})
      + (SELECT count(*) FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = ${TEST_RUNTIME_USER})
      + (SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = ${TEST_RUNTIME_USER})
      )::int AS "total"`;
    expect(direct?.total).toBe(0);

    const memberships = await h.db.client.$queryRaw<{ name: string }[]>`
      SELECT g.rolname::text AS "name"
        FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
        JOIN pg_roles u ON u.oid = m.member
       WHERE u.rolname = ${TEST_RUNTIME_USER}
       ORDER BY 1`;
    expect(memberships.map((m) => m.name)).toEqual([GROUP]);
  });

  describe('recusas por privilégio (42501) sem efeito', () => {
    async function scenario(): Promise<{ workspaceId: string; a: string; operationId: string }> {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const [a, b] = ws.accounts as [string, string];
      const moved = await h.service.execute({
        workspaceId: ws.workspaceId,
        operationKey: opKey(),
        debitAccountId: a,
        creditAccountId: b,
        amountCents: 10n,
      });
      return { workspaceId: ws.workspaceId, a, operationId: moved.operationId };
    }

    type Ctx = Awaited<ReturnType<typeof scenario>>;
    const raw = (sql: string) => () => h.app.client.$executeRawUnsafe(sql);

    it.each<[string, (ctx: Ctx) => () => Promise<unknown>]>([
      ['desligar triggers do ledger', () => raw('ALTER TABLE "ledger_entry" DISABLE TRIGGER ALL')],
      ['desligar o trigger de identidade da conta', () => raw('ALTER TABLE "account" DISABLE TRIGGER "account_identity_immutable"')],
      ['criar tabela', () => raw('CREATE TABLE "tabela_extra" ("id" int)')],
      ['remover tabela', () => raw('DROP TABLE "ledger_entry"')],
      ['truncar o ledger', () => raw('TRUNCATE "ledger_entry"')],
      ['criar papel', () => raw('CREATE ROLE "papel_extra"')],
      ['desligar triggers da sessão', () => raw('SET session_replication_role = replica')],
      ['ler o controle de migrações', () => () => h.app.client.$queryRawUnsafe('SELECT * FROM "_prisma_migrations"')],
      ['inserir workspace', () => raw('INSERT INTO "workspace" DEFAULT VALUES')],
      ['alterar o alias do workspace', () => raw(`UPDATE "workspace" SET "alias" = 'outro-alias'`)],
      ['inserir identidade', () => raw(`INSERT INTO "user_identity" ("status", "profile", "email") VALUES ('ACTIVE', 'FACILITATOR', 'x@y')`)],
      ['alterar identidade', () => raw(`UPDATE "user_identity" SET "status" = 'ACTIVE'`)],
      ['apagar identidade', () => raw('DELETE FROM "user_identity"')],
      ['truncar identidades', () => raw('TRUNCATE "user_identity" CASCADE')],
      ['inserir vínculo', (c) => () => h.app.client.$executeRaw`INSERT INTO "workspace_membership" ("workspace_id", "identity_id", "role", "status") VALUES (${c.workspaceId}::uuid, gen_random_uuid(), 'FACILITATOR', 'ACTIVE')`],
      ['alterar vínculo', () => raw(`UPDATE "workspace_membership" SET "role" = 'FACILITATOR'`)],
      ['apagar vínculo', () => raw('DELETE FROM "workspace_membership"')],
      ['truncar vínculos', () => raw('TRUNCATE "workspace_membership"')],
      ['alterar lançamento', (c) => () => h.app.client.$executeRaw`UPDATE "ledger_entry" SET "amount_cents" = "amount_cents" WHERE "operation_id" = ${c.operationId}::uuid`],
      ['apagar lançamento', (c) => () => h.app.client.$executeRaw`DELETE FROM "ledger_entry" WHERE "operation_id" = ${c.operationId}::uuid`],
      ['alterar operação', (c) => () => h.app.client.$executeRaw`UPDATE "payment_operation" SET "amount_cents" = 1 WHERE "id" = ${c.operationId}::uuid`],
      ['apagar operação', (c) => () => h.app.client.$executeRaw`DELETE FROM "payment_operation" WHERE "id" = ${c.operationId}::uuid`],
      ['alterar o tipo da conta', (c) => () => h.app.client.$executeRaw`UPDATE "account" SET "kind" = 'CONTRA' WHERE "id" = ${c.a}::uuid`],
      ['alterar o workspace da conta', (c) => () => h.app.client.$executeRaw`UPDATE "account" SET "workspace_id" = "workspace_id" WHERE "id" = ${c.a}::uuid`],
      ['apagar conta', (c) => () => h.app.client.$executeRaw`DELETE FROM "account" WHERE "id" = ${c.a}::uuid`],
    ])('%s', async (_label, statement) => {
      const ctx = await scenario();
      const before = await counts(h, ctx.workspaceId);
      expect(await sqlState(statement(ctx)())).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await counts(h, ctx.workspaceId)).toEqual(before);
      const account = await h.db.client.account.findUniqueOrThrow({ where: { id: ctx.a } });
      expect(account).toMatchObject({ kind: 'STANDARD', workspaceId: ctx.workspaceId, balanceCents: 90n });
    });
  });

  it('o saldo continua alterável pela execução (necessário ao PaymentExecution; detectado pela reconciliação)', async () => {
    const ws = await fundedWorkspace(h, [100n]);
    const [a] = ws.accounts as [string];
    await h.app.client.$executeRaw`UPDATE "account" SET "balance_cents" = "balance_cents" + 1 WHERE "id" = ${a}::uuid`;
    expect(await balanceOf(h, a)).toBe(101n);
    const report = await h.reconciliation.reconcile(ws.workspaceId);
    expect(report.divergences).toContainEqual({ type: 'BALANCE_MISMATCH', accountId: a, recordedCents: 101n, ledgerCents: 100n });
  });
});
