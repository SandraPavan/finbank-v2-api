// Crédito educacional por HTTP: PactumJS, PaymentExecution real e PostgreSQL real.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { creditOperationKey } from '../../../src/bank-account/adapters/prisma-educational-credit.store.js';
import { PrismaPaymentExecutionStore } from '../../../src/payment-execution/adapters/prisma-payment-execution.store.js';
import { PaymentExecutionService } from '../../../src/payment-execution/application/payment-execution.service.js';
import { PrismaReconciliationReader } from '../../../src/reconciliation/adapters/prisma-reconciliation.reader.js';
import { ReconciliationService } from '../../../src/reconciliation/application/reconciliation.service.js';
import { withAuditFailure } from '../administration/support.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';

const REASON = 'Saldo inicial do exercício de PIX';

describe('crédito educacional por HTTP (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let pe: PaymentExecutionService;
  let f: Person;
  let desk: Browser;
  let alice: Person;
  let account: string;

  const path = (p: Person = alice) => `/facilitator/workspaces/${p.workspaceId}/customers/${p.id}/account/educational-credits`;
  const credit = (amount: unknown = '150.00', key = `chave-${randomUUID()}`, options: { browser?: Browser; person?: Person; justification?: unknown; headers?: Record<string, string> } = {}) =>
    (options.browser ?? desk).api('POST', path(options.person), { amount, justification: options.justification ?? REASON }, { 'idempotency-key': key, ...options.headers });
  const balance = async (id = account) => (await h.db.client.account.findUniqueOrThrow({ where: { id } })).balanceCents;
  const ws = () => alice.workspaceId ?? '';
  const totals = async () => ({
    operations: await h.db.client.paymentOperation.count({ where: { workspaceId: ws() } }),
    entries: await h.db.client.ledgerEntry.count({ where: { workspaceId: ws() } }),
    records: await h.db.client.educationalCredit.count({ where: { workspaceId: ws() } }),
    audits: await h.db.client.auditRecord.count({ where: { workspaceId: ws(), operation: 'EDUCATIONAL_CREDIT' } }),
    balance: await balance(),
  });

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function withAccount(person: Person): Promise<string> {
    const opened = await pe.openAccount(person.workspaceId, 'STANDARD');
    await h.db.client.customerAccount.create({ data: { identityId: person.id, workspaceId: person.workspaceId ?? '', accountId: opened.id } });
    return opened.id;
  }

  async function facilitatorOf(person: Person): Promise<{ facilitator: Person; browser: Browser }> {
    const facilitator = await h.facilitator();
    await h.db.client.workspaceMembership.create({ data: { workspaceId: person.workspaceId ?? '', identityId: facilitator.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    const browser = new Browser(server.url);
    expect((await browser.login(facilitator, PASSWORD)).status).toBe(200);
    return { facilitator, browser };
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    pe = new PaymentExecutionService(new PrismaPaymentExecutionStore(h.app.client));
  });

  beforeEach(async () => {
    alice = await h.customer();
    account = await withAccount(alice);
    ({ facilitator: f, browser: desk } = await facilitatorOf(alice));
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  it('crédito válido: dupla entrada da contrapartida para a conta, registro, auditoria sem justificativa e reconciliação', async () => {
    expect(await h.db.client.account.count({ where: { workspaceId: ws(), kind: 'CONTRA' } })).toBe(0);
    const started = Date.now();
    const reply = await credit('150.00', 'credito-inicial-01');
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ workspaceId: ws(), customerId: alice.id, accountId: account, amount: '150.00', replayed: false });
    const contra = await h.db.client.account.findFirstOrThrow({ where: { workspaceId: ws(), kind: 'CONTRA' } });
    const operation = await h.db.client.paymentOperation.findUniqueOrThrow({ where: { id: reply.body['operationId'] as string } });
    expect(operation).toMatchObject({ type: 'EDUCATIONAL_CREDIT', debitAccountId: contra.id, creditAccountId: account, amountCents: 15_000n, operationKey: creditOperationKey(f.id, 'credito-inicial-01') });
    const entries = await h.db.client.ledgerEntry.findMany({ where: { operationId: operation.id }, orderBy: { amountCents: 'asc' } });
    expect(entries.map((e) => [e.accountId, e.amountCents])).toEqual([[contra.id, -15_000n], [account, 15_000n]]);
    expect(await balance()).toBe(15_000n);
    expect(await balance(contra.id)).toBe(-15_000n);
    const record = await h.db.client.educationalCredit.findUniqueOrThrow({ where: { id: reply.body['creditId'] as string } });
    expect(record).toMatchObject({ operationId: operation.id, accountId: account, amountCents: 15_000n, justification: REASON, createdBy: f.id });
    expect(Math.abs(record.createdAt.getTime() - started)).toBeLessThan(60_000);
    const audits = await h.db.client.auditRecord.findMany({ where: { workspaceId: ws(), operation: 'EDUCATIONAL_CREDIT' } });
    expect(audits).toMatchObject([{ actorIdentityId: f.id, resourceType: 'EDUCATIONAL_CREDIT', resourceId: record.id }]);
    expect(JSON.stringify(audits)).not.toMatch(/Saldo inicial|150/);
    const report = await new ReconciliationService(new PrismaReconciliationReader(h.app.client)).reconcile(ws());
    expect(report).toMatchObject({ consistent: true, operationCount: 1 });
  });

  it.each<[string, unknown]>([['sem duas casas', '150'], ['uma casa', '1.5'], ['três casas', '1.505'], ['negativo', '-1.00'], ['zero', '0.00'], ['notação científica', '1e3'], ['número JSON', 150], ['vírgula', '1,00']])(
    'valor %s: 400 com o campo, sem eco nem efeito',
    async (_label, amount) => {
      const before = await totals();
      const reply = await credit(amount);
      problem(reply, 400, 'VALIDATION_ERROR');
      expect(reply.body['errors']).toEqual([{ field: 'amount' }]);
      expect(await totals()).toEqual(before);
    },
  );

  describe('limites (L6)', () => {
    it('R$ 1.000,00 por crédito: exatamente aceito, um centavo a mais 422', async () => {
      expect((await credit('1000.00')).status).toBe(201);
      const reply = await credit('1000.01');
      problem(reply, 422, 'CREDIT_LIMIT_EXCEEDED');
      expect(reply.body['errors']).toEqual([{ field: 'amount' }]);
    });

    it('R$ 10.000,00 acumulados por conta: até o teto aceito, além dele 422 sem efeito', async () => {
      for (let i = 0; i < 10; i += 1) {
        expect((await credit('1000.00')).status).toBe(201);
      }
      const before = await totals();
      problem(await credit('0.01'), 422, 'CREDIT_LIMIT_EXCEEDED');
      expect(await totals()).toEqual(before);
      expect(await balance()).toBe(1_000_000n);
    });

    it('vinte créditos simultâneos perto do teto não o ultrapassam', async () => {
      for (let i = 0; i < 9; i += 1) {
        await credit('1000.00');
      }
      await credit('500.00');
      const replies = await Promise.all(Array.from({ length: 20 }, () => credit('100.00')));
      expect(replies.filter((r) => r.status === 201)).toHaveLength(5);
      replies.filter((r) => r.status !== 201).forEach((r) => problem(r, 422, 'CREDIT_LIMIT_EXCEEDED'));
      expect(await balance()).toBe(1_000_000n);
    });

    it('os limites seguem a configuração', async () => {
      const small = await startApp({ COOKIE_TRANSPORT: 'local-http', EDUCATIONAL_CREDIT_MAX_PER_OPERATION: '50.00', EDUCATIONAL_CREDIT_MAX_PER_ACCOUNT: '60.00' });
      try {
        const browser = new Browser(small.url);
        await browser.login(f, PASSWORD);
        problem(await credit('50.01', `chave-${randomUUID()}`, { browser }), 422, 'CREDIT_LIMIT_EXCEEDED');
        expect((await credit('50.00', `chave-${randomUUID()}`, { browser })).status).toBe(201);
        problem(await credit('10.01', `chave-${randomUUID()}`, { browser }), 422, 'CREDIT_LIMIT_EXCEEDED');
        expect((await credit('10.00', `chave-${randomUUID()}`, { browser })).status).toBe(201);
      } finally {
        await small.app.close();
      }
    });
  });

  describe('idempotência', () => {
    it('mesma chave e conteúdo devolvem o original sem nova operação nem auditoria; conteúdo diferente 409', async () => {
      const first = await credit('150.00', 'credito-repetido-01');
      const after = await totals();
      const again = await credit('150.00', 'credito-repetido-01');
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ...first.body, replayed: true });
      expect(await totals()).toEqual(after);
      problem(await credit('151.00', 'credito-repetido-01'), 409, 'IDEMPOTENCY_CONFLICT');
      problem(await credit('150.00', 'credito-repetido-01', { justification: 'Outra justificativa qualquer' }), 409, 'IDEMPOTENCY_CONFLICT');
      const bob = await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email: `bob-${randomUUID()}@example.test`, workspaceId: ws() } });
      const bobPerson = { id: bob.id, email: bob.email, workspaceId: ws(), alias: alice.alias };
      await withAccount(bobPerson);
      problem(await credit('150.00', 'credito-repetido-01', { person: bobPerson }), 409, 'IDEMPOTENCY_CONFLICT');
      expect(await totals()).toEqual(after);
    });

    it('vinte repetições simultâneas executam uma vez; a mesma chave de outro facilitador é outra intenção', async () => {
      const replies = await Promise.all(Array.from({ length: 20 }, () => credit('150.00', 'credito-paralelo-01')));
      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      expect(replies.filter((r) => r.status === 200)).toHaveLength(19);
      expect(new Set(replies.map((r) => r.body['creditId'])).size).toBe(1);
      expect((await totals()).operations).toBe(1);
      const other = await facilitatorOf(alice);
      expect((await credit('150.00', 'credito-paralelo-01', { browser: other.browser })).status).toBe(201);
      expect((await totals()).operations).toBe(2);
    });

    it('a repetição vale mesmo depois de bloqueio da conta e de um limite menor', async () => {
      const first = await credit('1000.00', 'credito-antes-01');
      await desk.api('POST', `/facilitator/workspaces/${ws()}/customers/${alice.id}/account/block`, { justification: 'Bloqueio para o exercício' });
      expect((await credit('1000.00', 'credito-antes-01')).body).toEqual({ ...first.body, replayed: true });
      const small = await startApp({ COOKIE_TRANSPORT: 'local-http', EDUCATIONAL_CREDIT_MAX_PER_OPERATION: '10.00', EDUCATIONAL_CREDIT_MAX_PER_ACCOUNT: '10.00' });
      try {
        const browser = new Browser(small.url);
        await browser.login(f, PASSWORD);
        expect((await credit('1000.00', 'credito-antes-01', { browser })).body).toMatchObject({ replayed: true });
      } finally {
        await small.app.close();
      }
    });
  });

  describe('conta e contrapartida', () => {
    it('conta bloqueada: 409 sem efeito', async () => {
      await credit('10.00');
      await desk.api('POST', `/facilitator/workspaces/${ws()}/customers/${alice.id}/account/block`, { justification: 'Bloqueio para o exercício' });
      const before = await totals();
      problem(await credit('10.00'), 409, 'ACCOUNT_BLOCKED');
      expect(await totals()).toEqual(before);
    });

    it('workspace sem contrapartida a ganha uma única vez sob créditos simultâneos', async () => {
      const replies = await Promise.all(Array.from({ length: 10 }, () => credit('10.00')));
      expect(replies.every((r) => r.status === 201)).toBe(true);
      expect(await h.db.client.account.count({ where: { workspaceId: ws(), kind: 'CONTRA' } })).toBe(1);
      expect(await balance()).toBe(10_000n);
    });
  });

  it('falha no registro, na auditoria ou no commit desfaz o crédito inteiro', async () => {
    await credit('10.00');
    const before = await totals();
    const failing = async (sql: string, work: () => Promise<void>) => {
      await h.db.client.$executeRawUnsafe(`
        CREATE FUNCTION "test_credit_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."workspace_id" = '${ws()}'::uuid THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END $$`);
      await h.db.client.$executeRawUnsafe(sql);
      try {
        await work();
      } finally {
        await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_credit_failure"() CASCADE');
      }
    };
    await failing('CREATE TRIGGER "test_credit_failure" BEFORE INSERT ON "educational_credit" FOR EACH ROW EXECUTE FUNCTION "test_credit_failure"()', async () => {
      problem(await credit('20.00'), 503, 'TEMPORARY_UNAVAILABLE');
    });
    await withAuditFailure(h, 'EDUCATIONAL_CREDIT', async () => {
      problem(await credit('20.00'), 503, 'TEMPORARY_UNAVAILABLE');
    });
    await failing(
      'CREATE CONSTRAINT TRIGGER "test_credit_failure" AFTER INSERT ON "educational_credit" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "test_credit_failure"()',
      async () => {
        problem(await credit('20.00'), 503, 'TEMPORARY_UNAVAILABLE');
      },
    );
    expect(await totals()).toEqual(before);
  });

  describe('acesso', () => {
    it('cliente 403, sem sessão 401, sem CSRF 403, sem vínculo e alheio 404, sem chave 400, arquivado 409', async () => {
      const customer = new Browser(server.url);
      await customer.login(alice, PASSWORD);
      problem(await credit('10.00', `chave-${randomUUID()}`, { browser: customer }), 403, 'ACCESS_DENIED');
      problem(await call(server.url, 'POST', `/api/v1${path()}`, { json: { amount: '10.00', justification: REASON } }), 401, 'AUTH_SESSION_REQUIRED');
      problem(await credit('10.00', `chave-${randomUUID()}`, { headers: { 'x-csrf-token': '' } }), 403, 'CSRF_VALIDATION_FAILED');
      const stranger = await h.facilitator();
      const strangerBrowser = new Browser(server.url);
      await strangerBrowser.login(stranger, PASSWORD);
      problem(await credit('10.00', `chave-${randomUUID()}`, { browser: strangerBrowser }), 404, 'RESOURCE_NOT_FOUND');
      const outsider = await h.customer();
      await withAccount(outsider);
      problem(await desk.api('POST', `/facilitator/workspaces/${ws()}/customers/${outsider.id}/account/educational-credits`, { amount: '10.00', justification: REASON }, { 'idempotency-key': `chave-${randomUUID()}` }), 404, 'RESOURCE_NOT_FOUND');
      const noAccount = await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email: `sem-${randomUUID()}@example.test`, workspaceId: ws() } });
      problem(await desk.api('POST', `/facilitator/workspaces/${ws()}/customers/${noAccount.id}/account/educational-credits`, { amount: '10.00', justification: REASON }, { 'idempotency-key': `chave-${randomUUID()}` }), 404, 'RESOURCE_NOT_FOUND');
      const missingKey = await desk.api('POST', path(), { amount: '10.00', justification: REASON });
      problem(missingKey, 400, 'VALIDATION_ERROR');
      expect(missingKey.body['errors']).toEqual([{ field: 'Idempotency-Key' }]);
      await h.db.client.workspace.update({ where: { id: ws() }, data: { status: 'ARCHIVED' } });
      problem(await credit('10.00'), 409, 'WORKSPACE_ARCHIVED');
      expect((await totals()).operations).toBe(0);
    });
  });

  it('no banco: registro imutável também para o dono e sempre igual à operação do núcleo', async () => {
    const reply = await credit('10.00', 'credito-banco-01');
    for (const sql of [`UPDATE "educational_credit" SET "justification" = 'outra justificativa'`, 'DELETE FROM "educational_credit"', 'TRUNCATE "educational_credit"']) {
      expect(await sqlState(h.db.client.$executeRawUnsafe(sql)), sql).toBe('23001');
    }
    const operationId = reply.body['operationId'] as string;
    expect(await sqlState(h.app.client.$executeRaw`
      INSERT INTO "educational_credit" ("workspace_id", "operation_id", "account_id", "amount_cents", "justification", "created_by", "operation_key")
      VALUES (${ws()}::uuid, ${operationId}::uuid, ${account}::uuid, 999, ${REASON}, ${f.id}::uuid, ${creditOperationKey(f.id, 'credito-banco-01')})`)).toBe('23514');
  });
});
