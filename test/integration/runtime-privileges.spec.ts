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
      'account_status_change:SELECT',
      'authentication_control:DELETE',
      'authentication_control:INSERT',
      'authentication_control:SELECT',
      'customer_account:SELECT',
      'educational_config_revision:SELECT',
      'ledger_entry:INSERT',
      'ledger_entry:SELECT',
      'onboarding_policy_revision:SELECT',
      'onboarding_request:SELECT',
      'password_credential:SELECT',
      'payment_operation:INSERT',
      'payment_operation:SELECT',
      'simulation_clock_revision:SELECT',
      'temporary_credential:SELECT',
      'user_identity:SELECT',
      'user_session:INSERT',
      'user_session:SELECT',
      'workspace:SELECT',
      'workspace_enrollment_code:SELECT',
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
    expect(columns.map((c) => c.grant)).toEqual([
      'account.balance_cents:UPDATE',
      'account.status:UPDATE',
      'account_status_change.account_id:INSERT',
      'account_status_change.changed_by:INSERT',
      'account_status_change.from_status:INSERT',
      'account_status_change.justification:INSERT',
      'account_status_change.to_status:INSERT',
      'account_status_change.workspace_id:INSERT',
      'audit_record.actor_identity_id:INSERT',
      'audit_record.actor_profile:INSERT',
      'audit_record.actor_type:INSERT',
      'audit_record.correlation_id:INSERT',
      'audit_record.operation:INSERT',
      'audit_record.resource_id:INSERT',
      'audit_record.resource_type:INSERT',
      'audit_record.result:INSERT',
      'audit_record.workspace_id:INSERT',
      'authentication_control.expires_at:UPDATE',
      'authentication_control.failures:UPDATE',
      'authentication_control.restricted_until:UPDATE',
      'authentication_control.window_started_at:UPDATE',
      'customer_account.account_id:INSERT',
      'customer_account.identity_id:INSERT',
      'customer_account.workspace_id:INSERT',
      'educational_config_revision.catalog_version:INSERT',
      'educational_config_revision.created_by:INSERT',
      'educational_config_revision.enabled_defect_ids:INSERT',
      'educational_config_revision.lab_code_hash:INSERT',
      'educational_config_revision.mode:INSERT',
      'educational_config_revision.preset:INSERT',
      'educational_config_revision.revision:INSERT',
      'educational_config_revision.workspace_id:INSERT',
      'onboarding_policy_revision.created_by:INSERT',
      'onboarding_policy_revision.mode:INSERT',
      'onboarding_policy_revision.revision:INSERT',
      'onboarding_policy_revision.workspace_id:INSERT',
      'onboarding_request.birth_date:INSERT',
      'onboarding_request.business_date:INSERT',
      'onboarding_request.clock_revision:INSERT',
      'onboarding_request.cpf:INSERT',
      'onboarding_request.decided_at:INSERT',
      'onboarding_request.decided_at:UPDATE',
      'onboarding_request.email:INSERT',
      'onboarding_request.identity_id:INSERT',
      'onboarding_request.identity_id:UPDATE',
      'onboarding_request.name:INSERT',
      'onboarding_request.password_hash:INSERT',
      'onboarding_request.phone:INSERT',
      'onboarding_request.policy_revision:INSERT',
      'onboarding_request.status:INSERT',
      'onboarding_request.status:UPDATE',
      'onboarding_request.status_credential_expires_at:INSERT',
      'onboarding_request.status_credential_hash:INSERT',
      'onboarding_request.workspace_id:INSERT',
      'password_credential.hash:INSERT',
      'password_credential.hash:UPDATE',
      'password_credential.identity_id:INSERT',
      'password_credential.invalidated_at:UPDATE',
      'password_credential.updated_at:UPDATE',
      'simulation_clock_revision.business_date:INSERT',
      'simulation_clock_revision.created_by:INSERT',
      'simulation_clock_revision.revision:INSERT',
      'simulation_clock_revision.workspace_id:INSERT',
      'temporary_credential.consumed_at:UPDATE',
      'temporary_credential.expires_at:INSERT',
      'temporary_credential.hash:INSERT',
      'temporary_credential.identity_id:INSERT',
      'temporary_credential.revoked_at:UPDATE',
      'user_identity.email:INSERT',
      'user_identity.profile:INSERT',
      'user_identity.status:INSERT',
      'user_identity.status:UPDATE',
      'user_identity.workspace_id:INSERT',
      'user_session.idle_expires_at:UPDATE',
      'user_session.last_activity_at:UPDATE',
      'user_session.revoked_at:UPDATE',
      'workspace_enrollment_code.code_hash:INSERT',
      'workspace_enrollment_code.created_by:INSERT',
      'workspace_enrollment_code.revision:INSERT',
      'workspace_enrollment_code.workspace_id:INSERT',
    ]);

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
      ['alterar o e-mail da identidade', () => raw(`UPDATE "user_identity" SET "email" = 'x@y'`)],
      ['alterar o perfil da identidade', () => raw(`UPDATE "user_identity" SET "profile" = 'FACILITATOR'`)],
      ['ler a auditoria', () => () => h.app.client.$queryRawUnsafe('SELECT * FROM "audit_record"')],
      ['alterar a auditoria', () => raw(`UPDATE "audit_record" SET "result" = 'CHANGED'`)],
      ['apagar a auditoria', () => raw('DELETE FROM "audit_record"')],
      ['truncar a auditoria', () => raw('TRUNCATE "audit_record"')],
      ['escolher o instante da auditoria', () => raw(`INSERT INTO "audit_record" ("occurred_at") VALUES (now())`)],
      ['desligar o trigger de estado', () => raw('ALTER TABLE "user_identity" DISABLE TRIGGER ALL')],
      ['apagar identidade', () => raw('DELETE FROM "user_identity"')],
      ['truncar identidades', () => raw('TRUNCATE "user_identity" CASCADE')],
      ['inserir vínculo', (c) => () => h.app.client.$executeRaw`INSERT INTO "workspace_membership" ("workspace_id", "identity_id", "role", "status") VALUES (${c.workspaceId}::uuid, gen_random_uuid(), 'FACILITATOR', 'ACTIVE')`],
      ['alterar vínculo', () => raw(`UPDATE "workspace_membership" SET "role" = 'FACILITATOR'`)],
      ['apagar vínculo', () => raw('DELETE FROM "workspace_membership"')],
      ['truncar vínculos', () => raw('TRUNCATE "workspace_membership"')],
      ['mudar o assunto do contador', () => raw(`UPDATE "authentication_control" SET "subject_hash" = repeat('a', 64)`)],
      ['truncar contadores', () => raw('TRUNCATE "authentication_control"')],
      ['criar credencial', () => raw(`INSERT INTO "password_credential" ("identity_id", "hash") VALUES (gen_random_uuid(), 'x')`)],
      ['apagar credencial', () => raw('DELETE FROM "password_credential"')],
      ['mover credencial', () => raw('UPDATE "password_credential" SET "identity_id" = gen_random_uuid()')],
      ['alterar revisão educacional', () => raw(`UPDATE "educational_config_revision" SET "mode" = 'STUDENT'`)],
      ['apagar revisão educacional', () => raw('DELETE FROM "educational_config_revision"')],
      ['truncar revisões educacionais', () => raw('TRUNCATE "educational_config_revision"')],
      ['escolher o instante da revisão', () => raw(`INSERT INTO "educational_config_revision" ("created_at") VALUES (now())`)],
      ['alterar revisão do relógio', () => raw(`UPDATE "simulation_clock_revision" SET "business_date" = DATE '2030-01-01'`)],
      ['apagar revisão do relógio', () => raw('DELETE FROM "simulation_clock_revision"')],
      ['truncar revisões do relógio', () => raw('TRUNCATE "simulation_clock_revision"')],
      ['escolher o instante da revisão do relógio', () => raw(`INSERT INTO "simulation_clock_revision" ("created_at") VALUES (now())`)],
      ['escolher o identificador da revisão do relógio', () => raw(`INSERT INTO "simulation_clock_revision" ("id") VALUES (gen_random_uuid())`)],
      ['mudar a modalidade do workspace', () => raw(`UPDATE "workspace" SET "modality" = 'SHARED'`)],
      ['alterar código de inscrição', () => raw(`UPDATE "workspace_enrollment_code" SET "code_hash" = NULL`)],
      ['apagar código de inscrição', () => raw('DELETE FROM "workspace_enrollment_code"')],
      ['truncar códigos de inscrição', () => raw('TRUNCATE "workspace_enrollment_code"')],
      ['escolher o instante do código', () => raw(`INSERT INTO "workspace_enrollment_code" ("created_at") VALUES (now())`)],
      ['alterar dado cadastral da solicitação', () => raw(`UPDATE "onboarding_request" SET "cpf" = '00000000000'`)],
      ['estender a credencial de consulta', () => raw(`UPDATE "onboarding_request" SET "status_credential_expires_at" = now()`)],
      ['alterar revisão da política', () => raw(`UPDATE "onboarding_policy_revision" SET "mode" = 'MANUAL'`)],
      ['apagar solicitação de abertura', () => raw('DELETE FROM "onboarding_request"')],
      ['escolher o instante da solicitação', () => raw(`INSERT INTO "onboarding_request" ("created_at") VALUES (now())`)],
      ['alterar vínculo de conta', () => raw(`UPDATE "customer_account" SET "account_id" = "account_id"`)],
      ['apagar vínculo de conta', () => raw('DELETE FROM "customer_account"')],
      ['alterar histórico de estado da conta', () => raw(`UPDATE "account_status_change" SET "justification" = 'outra justificativa'`)],
      ['apagar histórico de estado da conta', () => raw('DELETE FROM "account_status_change"')],
      ['escolher o instante do histórico', () => raw(`INSERT INTO "account_status_change" ("changed_at") VALUES (now())`)],
      ['apagar credencial temporária', () => raw('DELETE FROM "temporary_credential"')],
      ['estender credencial temporária', () => raw(`UPDATE "temporary_credential" SET "expires_at" = now()`)],
      ['trocar o hash da temporária', () => raw(`UPDATE "temporary_credential" SET "hash" = 'x'`)],
      ['mover credencial temporária', () => raw('UPDATE "temporary_credential" SET "identity_id" = gen_random_uuid()')],
      ['mudar o escopo da sessão', () => raw(`UPDATE "user_session" SET "scope" = 'NORMAL'`)],
      ['apagar sessão', () => raw('DELETE FROM "user_session"')],
      ['truncar sessões', () => raw('TRUNCATE "user_session"')],
      ['estender o prazo absoluto', () => raw(`UPDATE "user_session" SET "absolute_expires_at" = now() + interval '1 day'`)],
      ['mudar a identidade da sessão', () => raw('UPDATE "user_session" SET "identity_id" = gen_random_uuid()')],
      ['mudar o segredo da sessão', () => raw(`UPDATE "user_session" SET "token_hash" = repeat('a', 64)`)],
      ['desligar o trigger da sessão', () => raw('ALTER TABLE "user_session" DISABLE TRIGGER ALL')],
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
