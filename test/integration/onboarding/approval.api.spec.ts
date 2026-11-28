// Aprovação automática do onboarding: cliente, senha, conta e vínculo numa transação. PactumJS e PostgreSQL real.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaReconciliationReader } from '../../../src/reconciliation/adapters/prisma-reconciliation.reader.js';
import { ReconciliationService } from '../../../src/reconciliation/application/reconciliation.service.js';
import { withAuditFailure } from '../administration/support.js';
import { Browser, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';

const CPF = '529.982.247-25';
const OTHER_CPF = '111.444.777-35';
const INSUFFICIENT_PRIVILEGE = '42501';

describe('aprovação do onboarding (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let ws: { id: string; alias: string };

  const body = (overrides: Record<string, unknown> = {}) => ({
    alias: ws.alias, name: 'Ana Fictícia', cpf: CPF, birthDate: '1990-05-17', email: `ana-${randomUUID()}@example.test`,
    phone: '(11) 98765-4321', password: PASSWORD, ...overrides,
  });
  async function submit(json: unknown): Promise<Reply> {
    const browser = new Browser(server.url);
    await browser.send('GET', '/csrf');
    return browser.api('POST', '/onboarding/requests', json);
  }
  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }
  /** Tudo o que a aprovação cria neste workspace. */
  async function created() {
    const where = { workspaceId: ws.id };
    return {
      identities: await h.db.client.userIdentity.count({ where }),
      accounts: await h.db.client.account.count({ where }),
      links: await h.db.client.customerAccount.count({ where }),
      requests: await h.db.client.onboardingRequest.count({ where }),
      audits: await h.db.client.auditRecord.count({ where: { ...where, operation: 'ONBOARDING_APPROVE' } }),
    };
  }
  const NOTHING = { identities: 0, accounts: 0, links: 0, requests: 0, audits: 0 };

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
  });

  beforeEach(async () => {
    const alias = `t-${randomUUID()}`;
    const row = await h.db.client.workspace.create({ data: { alias }, select: { id: true } });
    ws = { id: row.id, alias };
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  it('cria cliente ativo, senha da solicitação, conta comum de saldo zero e vínculo; o login funciona em seguida', async () => {
    const sent = body();
    const reply = await submit(sent);
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ status: 'APPROVED' });
    const request = await h.db.client.onboardingRequest.findUniqueOrThrow({ where: { id: reply.body['requestId'] as string } });
    expect(request.status).toBe('APPROVED');
    expect(request.identityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs((request.decidedAt?.getTime() ?? 0) - request.createdAt.getTime())).toBeLessThan(5_000);
    const identity = await h.db.client.userIdentity.findUniqueOrThrow({ where: { id: request.identityId ?? '' } });
    expect(identity).toMatchObject({ profile: 'CUSTOMER', status: 'ACTIVE', workspaceId: ws.id, email: (sent.email).toLowerCase() });
    const credential = await h.db.client.passwordCredential.findUniqueOrThrow({ where: { identityId: identity.id } });
    expect(credential.hash).toBe(request.passwordHash);
    expect(credential.invalidatedAt).toBeNull();
    const link = await h.db.client.customerAccount.findUniqueOrThrow({ where: { identityId: identity.id } });
    const account = await h.db.client.account.findUniqueOrThrow({ where: { id: link.accountId } });
    expect(account).toMatchObject({ workspaceId: ws.id, kind: 'STANDARD', status: 'ACTIVE', balanceCents: 0n });
    expect(await h.db.client.paymentOperation.count({ where: { workspaceId: ws.id } })).toBe(0);
    expect(await h.db.client.ledgerEntry.count({ where: { workspaceId: ws.id } })).toBe(0);
    expect(await created()).toEqual({ identities: 1, accounts: 1, links: 1, requests: 1, audits: 1 });

    const customer = new Browser(server.url);
    const login = await customer.login({ alias: ws.alias, email: sent.email }, PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ identityId: identity.id, profile: 'CUSTOMER', workspaceId: ws.id, passwordChangeRequired: false });
  });

  it('sem aprovação não há login: solicitação recusada não cria cliente', async () => {
    const sent = body({ birthDate: '2020-01-01' });
    problem(await submit(sent), 422, 'ONBOARDING_UNDERAGE');
    expect(await created()).toEqual(NOTHING);
    const login = await new Browser(server.url).login({ alias: ws.alias, email: sent.email }, PASSWORD);
    expect(login.status).toBe(401);
  });

  it('auditoria ONBOARDING_APPROVE com ator SYSTEM, sem dados pessoais', async () => {
    const sent = body();
    const reply = await submit(sent);
    const records = await h.db.client.auditRecord.findMany({ where: { workspaceId: ws.id } });
    expect(records).toMatchObject([
      {
        actorType: 'SYSTEM', actorIdentityId: null, actorProfile: null, operation: 'ONBOARDING_APPROVE',
        resourceType: 'ONBOARDING_REQUEST', resourceId: reply.body['requestId'], result: 'CHANGED',
      },
    ]);
    expect(JSON.stringify(records)).not.toMatch(new RegExp(`52998224725|${sent.email}|98765|Ana`, 'i'));
  });

  it('a reconciliação do workspace continua consistente com a conta nova', async () => {
    await submit(body());
    await submit(body({ cpf: OTHER_CPF }));
    const report = await new ReconciliationService(new PrismaReconciliationReader(h.app.client)).reconcile(ws.id);
    expect(report).toMatchObject({ accountCount: 2, operationCount: 0, consistent: true });
  });

  describe('atomicidade', () => {
    /** Trigger do dono que faz a inserção numa tabela falhar só para este workspace. */
    async function failing(table: string, condition: string, work: () => Promise<void>): Promise<void> {
      await h.db.client.$executeRawUnsafe(`
        CREATE FUNCTION "test_approval_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condition} THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END $$`);
      await h.db.client.$executeRawUnsafe(
        `CREATE TRIGGER "test_approval_failure" BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION "test_approval_failure"()`,
      );
      try {
        await work();
      } finally {
        await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_approval_failure"() CASCADE');
      }
    }

    it.each([
      ['identidade', 'user_identity', 'NEW."workspace_id" = $WS'],
      ['credencial', 'password_credential', 'EXISTS (SELECT 1 FROM "user_identity" WHERE "id" = NEW."identity_id" AND "workspace_id" = $WS)'],
      ['conta', 'account', 'NEW."workspace_id" = $WS'],
      ['vínculo', 'customer_account', 'NEW."workspace_id" = $WS'],
      ['solicitação', 'onboarding_request', 'NEW."workspace_id" = $WS'],
    ])('falha na %s não deixa nada gravado', async (_label, table, condition) => {
      await failing(table, condition.replaceAll('$WS', `'${ws.id}'::uuid`), async () => {
        problem(await submit(body()), 503, 'TEMPORARY_UNAVAILABLE');
      });
      expect(await created()).toEqual(NOTHING);
      expect((await submit(body())).status).toBe(201);
    });

    it('falha na auditoria ou no commit não deixa nada gravado', async () => {
      await withAuditFailure(h, 'ONBOARDING_APPROVE', async () => {
        problem(await submit(body()), 503, 'TEMPORARY_UNAVAILABLE');
      });
      expect(await created()).toEqual(NOTHING);
      await h.db.client.$executeRawUnsafe(`
        CREATE FUNCTION "test_approval_commit"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."workspace_id" = '${ws.id}'::uuid THEN RAISE EXCEPTION 'falha no commit'; END IF; RETURN NEW; END $$`);
      await h.db.client.$executeRawUnsafe(
        'CREATE CONSTRAINT TRIGGER "test_approval_commit" AFTER INSERT ON "customer_account" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "test_approval_commit"()',
      );
      try {
        problem(await submit(body()), 503, 'TEMPORARY_UNAVAILABLE');
      } finally {
        await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_approval_commit"() CASCADE');
      }
      expect(await created()).toEqual(NOTHING);
    });
  });

  describe('concorrência e conflitos', () => {
    it.each(['cpf', 'email'] as const)('vinte submissões simultâneas com o mesmo %s: um cliente, uma conta, um vínculo', async (field) => {
      const shared = body();
      const replies = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          submit(field === 'cpf' ? { ...shared, email: `p${i}-${randomUUID()}@example.test` } : { ...shared, cpf: i % 2 === 0 ? CPF : OTHER_CPF }),
        ),
      );
      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      replies.filter((r) => r.status !== 201).forEach((r) => problem(r, 409, 'ONBOARDING_DUPLICATE'));
      expect(await created()).toEqual({ identities: 1, accounts: 1, links: 1, requests: 1, audits: 1 });
    });

    it('e-mail de cliente criado pela linha de comando dá 409 email e não cria nada', async () => {
      const email = `cli-${randomUUID()}@example.test`;
      await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email, workspaceId: ws.id } });
      const reply = await submit(body({ email }));
      problem(reply, 409, 'ONBOARDING_DUPLICATE');
      expect(reply.body['errors']).toEqual([{ field: 'email' }]);
      expect(await created()).toEqual({ ...NOTHING, identities: 1 });
    });
  });

  describe('proteções no banco', () => {
    const asRuntime = (sql: Promise<unknown>) => sqlState(sql);

    it('a execução só cria cliente ativo com workspace; o dono continua criando facilitador', async () => {
      const email = () => `x-${randomUUID()}@example.test`;
      expect(await asRuntime(h.app.client.$executeRaw`
        INSERT INTO "user_identity" ("status", "profile", "email") VALUES ('ACTIVE', 'FACILITATOR', ${email()})`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await asRuntime(h.app.client.$executeRaw`
        INSERT INTO "user_identity" ("status", "profile", "email", "workspace_id") VALUES ('DISABLED', 'CUSTOMER', ${email()}, ${ws.id}::uuid)`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await asRuntime(h.app.client.$executeRaw`
        INSERT INTO "user_identity" ("status", "profile", "email") VALUES ('ACTIVE', 'CUSTOMER', ${email()})`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await asRuntime(h.app.client.$executeRaw`
        INSERT INTO "user_identity" ("id", "status", "profile", "email", "workspace_id") VALUES (gen_random_uuid(), 'ACTIVE', 'CUSTOMER', ${email()}, ${ws.id}::uuid)`)).toBe(INSUFFICIENT_PRIVILEGE);
      const facilitator = await h.facilitator();
      expect(facilitator.id).toEqual(expect.any(String));
      expect(await h.db.client.userIdentity.count({ where: { workspaceId: ws.id } })).toBe(0);
    });

    it('a execução só cria senha de cliente', async () => {
      const facilitator = await h.facilitator({ password: null });
      const hash = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`;
      expect(await asRuntime(h.app.client.$executeRaw`
        INSERT INTO "password_credential" ("identity_id", "hash") VALUES (${facilitator.id}::uuid, ${hash})`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await asRuntime(h.app.client.$executeRaw`
        INSERT INTO "password_credential" ("identity_id", "hash") VALUES (gen_random_uuid(), ${hash})`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await h.db.client.passwordCredential.count({ where: { identityId: facilitator.id } })).toBe(0);
    });

    it('vínculo: único por cliente e por conta, mesmo workspace, só conta comum, imutável', async () => {
      const reply = await submit(body());
      const request = await h.db.client.onboardingRequest.findUniqueOrThrow({ where: { id: reply.body['requestId'] as string } });
      const identityId = request.identityId ?? '';
      const link = await h.db.client.customerAccount.findUniqueOrThrow({ where: { identityId } });
      const contra = await h.db.client.account.create({ data: { workspaceId: ws.id, kind: 'CONTRA' } });
      const spare = await h.db.client.account.create({ data: { workspaceId: ws.id, kind: 'STANDARD' } });
      const other = await h.db.client.workspace.create({ data: { alias: `t-${randomUUID()}` } });
      const foreign = await h.db.client.account.create({ data: { workspaceId: other.id, kind: 'STANDARD' } });
      const second = await h.customer();
      const link2 = (identity: string, workspace: string, account: string) =>
        asRuntime(h.app.client.$executeRaw`
          INSERT INTO "customer_account" ("identity_id", "workspace_id", "account_id") VALUES (${identity}::uuid, ${workspace}::uuid, ${account}::uuid)`);
      expect(await link2(identityId, ws.id, spare.id)).toBe('23505');
      // Conta livre de outro workspace: a chave composta impede misturar workspaces.
      expect(await link2(second.id, second.workspaceId ?? '', spare.id)).toBe('23503');
      expect(await link2(second.id, ws.id, spare.id)).toBe('23503');
      expect(await link2(second.id, other.id, foreign.id)).toBe('23503');
      const customerB = await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email: `b-${randomUUID()}@example.test`, workspaceId: ws.id } });
      expect(await link2(customerB.id, ws.id, contra.id)).toBe('23514');
      expect(await link2(customerB.id, ws.id, link.accountId)).toBe('23505');
      const facilitator = await h.facilitator();
      // O trigger recusa quem não é cliente antes mesmo da chave estrangeira.
      expect(await link2(facilitator.id, ws.id, spare.id)).toBe('23514');
      for (const sql of ['UPDATE "customer_account" SET "account_id" = "account_id"', 'DELETE FROM "customer_account"', 'TRUNCATE "customer_account"']) {
        expect(await sqlState(h.db.client.$executeRawUnsafe(sql)), sql).toBe('23001');
      }
    });
  });
});
