// Bloqueio e desbloqueio de conta pelo facilitador: PactumJS, PaymentExecution real e PostgreSQL real.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaPaymentExecutionStore } from '../../../src/payment-execution/adapters/prisma-payment-execution.store.js';
import { PaymentExecutionService } from '../../../src/payment-execution/application/payment-execution.service.js';
import { withAuditFailure } from '../administration/support.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';
import { rejection, sqlState } from '../payment-execution/support.js';

const REASON = 'Suspeita de uso indevido no exercício';

describe('bloqueio de conta (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let pe: PaymentExecutionService;
  let f: Person;
  let desk: Browser;
  /** Cliente com conta; `other` também, no mesmo workspace; `contra` financia. */
  let alice: Person, bob: Person;
  let accounts: { alice: string; bob: string; contra: string };

  const path = (p: Person = alice) => `/facilitator/workspaces/${p.workspaceId}/customers/${p.id}/account`;
  const block = (p: Person = alice, justification: unknown = REASON, browser = desk, headers: Record<string, string> = {}) =>
    browser.api('POST', `${path(p)}/block`, { justification }, headers);
  const unblock = (p: Person = alice, justification: unknown = 'Situação esclarecida com o cliente') => desk.api('POST', `${path(p)}/unblock`, { justification });
  const history = (accountId = accounts.alice) => h.db.client.accountStatusChange.findMany({ where: { accountId }, orderBy: { changedAt: 'asc' } });
  const audits = () => h.db.client.auditRecord.findMany({ where: { workspaceId: alice.workspaceId ?? '', operation: { in: ['ACCOUNT_BLOCK', 'ACCOUNT_UNBLOCK'] } }, orderBy: { occurredAt: 'asc' } });
  const status = async (accountId = accounts.alice) => (await h.db.client.account.findUniqueOrThrow({ where: { id: accountId } })).status;
  const key = () => `op-${randomUUID()}`;
  const transfer = (debit: string, credit: string, amount = 100n) =>
    pe.execute({ workspaceId: alice.workspaceId, operationKey: key(), debitAccountId: debit, creditAccountId: credit, amountCents: amount });
  const credit = (accountId: string, amount = 100n) => pe.credit({ workspaceId: alice.workspaceId, operationKey: key(), accountId, amountCents: amount });

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function withAccount(person: Person): Promise<string> {
    const account = await pe.openAccount(person.workspaceId, 'STANDARD');
    await h.db.client.customerAccount.create({ data: { identityId: person.id, workspaceId: person.workspaceId ?? '', accountId: account.id } });
    return account.id;
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    pe = new PaymentExecutionService(new PrismaPaymentExecutionStore(h.app.client));
  });

  beforeEach(async () => {
    alice = await h.customer();
    const email = `bob-${randomUUID()}@example.test`;
    const bobRow = await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email, workspaceId: alice.workspaceId } });
    bob = { id: bobRow.id, email, workspaceId: alice.workspaceId, alias: alice.alias };
    accounts = { alice: await withAccount(alice), bob: await withAccount(bob), contra: (await pe.openAccount(alice.workspaceId, 'CONTRA')).id };
    await credit(accounts.alice, 1_000n);
    await credit(accounts.bob, 1_000n);
    f = await h.facilitator();
    await h.db.client.workspaceMembership.create({ data: { workspaceId: alice.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    desk = new Browser(server.url);
    expect((await desk.login(f, PASSWORD)).status).toBe(200);
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  it('bloquear e desbloquear gravam estado, histórico e auditoria; saldo e lançamentos não mudam', async () => {
    const before = await h.db.client.account.findUniqueOrThrow({ where: { id: accounts.alice } });
    const entries = await h.db.client.ledgerEntry.count({ where: { workspaceId: alice.workspaceId ?? '' } });
    const started = Date.now();
    expect((await block()).body).toEqual({ workspaceId: alice.workspaceId, customerId: alice.id, accountId: accounts.alice, status: 'BLOCKED' });
    expect(await status()).toBe('BLOCKED');
    expect((await unblock()).body).toMatchObject({ status: 'ACTIVE' });
    const rows = await history();
    expect(rows.map((r) => [r.fromStatus, r.toStatus, r.justification, r.changedBy])).toEqual([
      ['ACTIVE', 'BLOCKED', REASON, f.id],
      ['BLOCKED', 'ACTIVE', 'Situação esclarecida com o cliente', f.id],
    ]);
    rows.forEach((r) => expect(Math.abs(r.changedAt.getTime() - started)).toBeLessThan(60_000));
    const records = await audits();
    expect(records.map((a) => [a.operation, a.actorIdentityId, a.resourceType, a.resourceId])).toEqual([
      ['ACCOUNT_BLOCK', f.id, 'ACCOUNT', accounts.alice],
      ['ACCOUNT_UNBLOCK', f.id, 'ACCOUNT', accounts.alice],
    ]);
    expect(JSON.stringify(records)).not.toMatch(/Suspeita|esclarecida/);
    const after = await h.db.client.account.findUniqueOrThrow({ where: { id: accounts.alice } });
    expect(after.balanceCents).toBe(before.balanceCents);
    expect(await h.db.client.ledgerEntry.count({ where: { workspaceId: alice.workspaceId ?? '' } })).toBe(entries);
  });

  it('repetir o mesmo estado devolve o atual sem histórico nem auditoria', async () => {
    expect((await unblock()).body).toMatchObject({ status: 'ACTIVE' });
    await block();
    expect((await block(alice, 'Outro motivo qualquer da turma')).body).toMatchObject({ status: 'BLOCKED' });
    expect(await history()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('conta bloqueada não envia nem recebe; desbloqueada volta a operar; o login continua', async () => {
    await block();
    expect((await rejection(transfer(accounts.alice, accounts.bob))).code).toBe('ACCOUNT_BLOCKED');
    expect((await rejection(transfer(accounts.bob, accounts.alice))).code).toBe('ACCOUNT_BLOCKED');
    expect((await rejection(credit(accounts.alice))).code).toBe('ACCOUNT_BLOCKED');
    expect((await new Browser(server.url).login(alice, PASSWORD)).status).toBe(200);
    await unblock();
    expect((await transfer(accounts.alice, accounts.bob)).replayed).toBe(false);
    expect((await credit(accounts.alice)).replayed).toBe(false);
  });

  it('a consulta mostra estado e histórico do mais recente ao mais antigo', async () => {
    await block();
    await unblock();
    const view = await desk.api('GET', path());
    expect(view.body).toMatchObject({ workspaceId: alice.workspaceId, customerId: alice.id, accountId: accounts.alice, status: 'ACTIVE' });
    expect((view.body['history'] as { toStatus: string; justification: string; changedBy: string }[]).map((r) => [r.toStatus, r.changedBy])).toEqual([
      ['ACTIVE', f.id],
      ['BLOCKED', f.id],
    ]);
  });

  describe('concorrência com movimentações', () => {
    async function waiting(): Promise<void> {
      await vi.waitFor(async () => {
        const [row] = await h.db.client.$queryRaw<{ total: number }[]>`
          SELECT count(*)::int AS "total" FROM pg_stat_activity
           WHERE "wait_event_type" = 'Lock' AND "datname" = current_database() AND "query" LIKE '%FROM "account"%'`;
        expect(row?.total).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 50 });
    }

    it('movimentação em curso faz o bloqueio esperar e valer depois dela', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      // A mesma trava de linha que o PaymentExecution toma ao movimentar.
      const movement = h.db.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "account" WHERE "id" = ${accounts.alice}::uuid FOR NO KEY UPDATE`;
        locked();
        await held;
      }, { timeout: 20_000 });
      await lockTaken;
      const pending = block();
      await waiting();
      expect(await status()).toBe('ACTIVE');
      release();
      await movement;
      expect((await pending).body).toMatchObject({ status: 'BLOCKED' });
    });

    it('bloqueio em curso faz a movimentação esperar e ser recusada', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const blocking = h.db.client.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "account" SET "status" = 'BLOCKED' WHERE "id" = ${accounts.alice}::uuid`;
        locked();
        await held;
      }, { timeout: 20_000 });
      await lockTaken;
      const pending = transfer(accounts.alice, accounts.bob);
      await waiting();
      release();
      await blocking;
      expect((await rejection(pending)).code).toBe('ACCOUNT_BLOCKED');
    });
  });

  describe('acesso e entrada', () => {
    it('cliente 403, sem sessão 401, sem CSRF 403, alheio e sem vínculo 404, arquivado 409', async () => {
      const customer = new Browser(server.url);
      await customer.login(alice, PASSWORD);
      problem(await block(alice, REASON, customer), 403, 'ACCESS_DENIED');
      problem(await call(server.url, 'GET', `/api/v1${path()}`), 401, 'AUTH_SESSION_REQUIRED');
      problem(await block(alice, REASON, desk, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
      const stranger = await h.facilitator();
      const strangerBrowser = new Browser(server.url);
      await strangerBrowser.login(stranger, PASSWORD);
      problem(await block(alice, REASON, strangerBrowser), 404, 'RESOURCE_NOT_FOUND');
      const outsider = await h.customer();
      await withAccount(outsider);
      problem(await desk.api('POST', `/facilitator/workspaces/${alice.workspaceId}/customers/${outsider.id}/account/block`, { justification: REASON }), 404, 'RESOURCE_NOT_FOUND');
      for (const id of [randomUUID(), 'x']) {
        problem(await desk.api('POST', `/facilitator/workspaces/${alice.workspaceId}/customers/${id}/account/block`, { justification: REASON }), 404, 'RESOURCE_NOT_FOUND');
        problem(await desk.api('GET', `/facilitator/workspaces/${alice.workspaceId}/customers/${id}/account`), 404, 'RESOURCE_NOT_FOUND');
      }
      const noAccount = await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email: `sem-${randomUUID()}@example.test`, workspaceId: alice.workspaceId } });
      problem(await desk.api('POST', `/facilitator/workspaces/${alice.workspaceId}/customers/${noAccount.id}/account/block`, { justification: REASON }), 404, 'RESOURCE_NOT_FOUND');
      await h.db.client.workspace.update({ where: { id: alice.workspaceId ?? '' }, data: { status: 'ARCHIVED' } });
      problem(await block(), 409, 'WORKSPACE_ARCHIVED');
      expect((await desk.api('GET', path())).body).toMatchObject({ status: 'ACTIVE' });
      expect(await status(accounts.alice)).toBe('ACTIVE');
      expect(await history()).toEqual([]);
    });

    it.each<[string, unknown]>([['curta', 'curta'], ['longa', 'x'.repeat(201)], ['com quebra', 'motivo com\nquebra de linha'], ['número', 1234567890]])(
      'justificativa %s: 400 com o campo, sem eco nem gravação',
      async (_label, justification) => {
        const reply = await block(alice, justification);
        problem(reply, 400, 'VALIDATION_ERROR');
        expect(reply.body['errors']).toEqual([{ field: 'justification' }]);
        if (typeof justification === 'string') {
          expect(reply.text).not.toContain(justification.slice(0, 10));
        }
        expect(await status()).toBe('ACTIVE');
      },
    );
  });

  it('falha no histórico ou na auditoria desfaz a mudança de estado', async () => {
    await h.db.client.$executeRawUnsafe(`
      CREATE FUNCTION "test_status_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."account_id" = '${accounts.alice}'::uuid THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END $$`);
    await h.db.client.$executeRawUnsafe('CREATE TRIGGER "test_status_failure" BEFORE INSERT ON "account_status_change" FOR EACH ROW EXECUTE FUNCTION "test_status_failure"()');
    try {
      problem(await block(), 503, 'TEMPORARY_UNAVAILABLE');
    } finally {
      await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_status_failure"() CASCADE');
    }
    await withAuditFailure(h, 'ACCOUNT_BLOCK', async () => {
      problem(await block(), 503, 'TEMPORARY_UNAVAILABLE');
    });
    expect(await status()).toBe('ACTIVE');
    expect(await history()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('no banco: histórico imutável também para o dono; mudança de fato e justificativa no formato', async () => {
    await block();
    for (const sql of [`UPDATE "account_status_change" SET "justification" = 'outra justificativa'`, 'DELETE FROM "account_status_change"', 'TRUNCATE "account_status_change"']) {
      expect(await sqlState(h.db.client.$executeRawUnsafe(sql)), sql).toBe('23001');
    }
    const insert = (from: string, to: string, justification: string) =>
      sqlState(h.app.client.$executeRaw`
        INSERT INTO "account_status_change" ("workspace_id", "account_id", "from_status", "to_status", "justification", "changed_by")
        VALUES (${alice.workspaceId}::uuid, ${accounts.alice}::uuid, ${from}::"account_status", ${to}::"account_status", ${justification}, ${f.id}::uuid)`);
    expect(await insert('ACTIVE', 'ACTIVE', REASON)).toBe('23514');
    expect(await insert('ACTIVE', 'BLOCKED', 'curta')).toBe('23514');
    expect(await insert('ACTIVE', 'BLOCKED', ` ${REASON}`)).toBe('23514');
  });
});
