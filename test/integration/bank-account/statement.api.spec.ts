// Saldo e extrato por HTTP: PactumJS, PaymentExecution real e PostgreSQL real.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaPaymentExecutionStore } from '../../../src/payment-execution/adapters/prisma-payment-execution.store.js';
import { PaymentExecutionService } from '../../../src/payment-execution/application/payment-execution.service.js';
import { PrismaReconciliationReader } from '../../../src/reconciliation/adapters/prisma-reconciliation.reader.js';
import { ReconciliationService } from '../../../src/reconciliation/application/reconciliation.service.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';

interface Item {
  entryId: string;
  operationId: string;
  type: string;
  modality: string | null;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  status: string;
  reversesOperationId: string | null;
  occurredAt: string;
}

const REASON = 'Saldo inicial do exercício de extrato';
/** Texto decimal da API para centavos, sem passar por número de ponto flutuante. */
const cents = (amount: string): bigint => BigInt(amount.replace('.', ''));

describe('saldo e extrato (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let pe: PaymentExecutionService;
  let alice: Person;
  let account: string;
  let me: Browser;
  let desk: Browser;

  const ws = () => alice.workspaceId ?? '';
  const facilitatorPath = (p: Person = alice) => `/facilitator/workspaces/${p.workspaceId}/customers/${p.id}/account`;
  const items = (reply: Reply) => reply.body['items'] as Item[];
  const credit = (amount: string) =>
    desk.api('POST', `${facilitatorPath()}/educational-credits`, { amount, justification: REASON }, { 'idempotency-key': `chave-${randomUUID()}` });
  const balance = async (id = account) => (await h.db.client.account.findUniqueOrThrow({ where: { id } })).balanceCents;

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function withAccount(person: Person): Promise<string> {
    const opened = await pe.openAccount(person.workspaceId, 'STANDARD');
    await h.db.client.customerAccount.create({ data: { identityId: person.id, workspaceId: person.workspaceId ?? '', accountId: opened.id } });
    return opened.id;
  }

  async function enter(person: Person): Promise<Browser> {
    const browser = new Browser(server.url);
    expect((await browser.login(person, PASSWORD)).status).toBe(200);
    return browser;
  }

  async function facilitatorOf(person: Person): Promise<Browser> {
    const facilitator = await h.facilitator();
    await h.db.client.workspaceMembership.create({ data: { workspaceId: person.workspaceId ?? '', identityId: facilitator.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    return enter(facilitator);
  }

  /** Percorre o extrato inteiro pelo cursor. */
  async function walk(browser: Browser, path: string, limit: number, between?: (page: number) => Promise<void>): Promise<{ all: Item[]; pages: number }> {
    const all: Item[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? `?limit=${limit}` : `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
      const reply = await browser.api('GET', `${path}${query}`);
      expect(reply.status).toBe(200);
      all.push(...items(reply));
      cursor = reply.body['nextCursor'] as string | null;
      pages += 1;
      await between?.(pages);
    } while (cursor !== null);
    return { all, pages };
  }

  /** Lançamentos gravados pelo dono numa única transação: todos com o mesmo instante, para provar o desempate. */
  async function sameInstantEntries(count: number): Promise<void> {
    const contra = (await pe.openAccount(ws(), 'CONTRA')).id;
    await h.db.client.$transaction(async (tx) => {
      for (let i = 0; i < count; i += 1) {
        const [op] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "payment_operation" ("workspace_id", "operation_key", "fingerprint", "type", "debit_account_id", "credit_account_id", "amount_cents")
          VALUES (${ws()}::uuid, ${`mesmo-instante-${randomUUID()}`}, ${'0'.repeat(64)}, 'TRANSFER', ${contra}::uuid, ${account}::uuid, ${BigInt(i + 1)})
          RETURNING "id"::text AS "id"`;
        await tx.$executeRaw`
          INSERT INTO "ledger_entry" ("workspace_id", "operation_id", "account_id", "amount_cents")
          VALUES (${ws()}::uuid, ${op?.id}::uuid, ${contra}::uuid, ${-BigInt(i + 1)}), (${ws()}::uuid, ${op?.id}::uuid, ${account}::uuid, ${BigInt(i + 1)})`;
      }
      const total = BigInt((count * (count + 1)) / 2);
      await tx.$executeRaw`UPDATE "account" SET "balance_cents" = "balance_cents" + ${total} WHERE "id" = ${account}::uuid`;
      await tx.$executeRaw`UPDATE "account" SET "balance_cents" = "balance_cents" - ${total} WHERE "id" = ${contra}::uuid`;
    });
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    pe = new PaymentExecutionService(new PrismaPaymentExecutionStore(h.app.client));
  });

  beforeEach(async () => {
    alice = await h.customer();
    account = await withAccount(alice);
    me = await enter(alice);
    desk = await facilitatorOf(alice);
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  describe('conta e saldo', () => {
    it('conta nova: saldo "0.00", BRL, extrato vazio', async () => {
      const reply = await me.api('GET', '/accounts/me');
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ accountId: account, status: 'ACTIVE', balance: '0.00', currency: 'BRL' });
      expect((await me.api('GET', '/accounts/me/statement')).body).toEqual({ accountId: account, items: [], nextCursor: null });
    });

    it('saldo materializado em texto decimal com centavos exatos, para o cliente e para o facilitador', async () => {
      await credit('150.07');
      await credit('0.01');
      expect((await me.api('GET', '/accounts/me')).body['balance']).toBe('150.08');
      const view = await desk.api('GET', facilitatorPath());
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ accountId: account, status: 'ACTIVE', balance: '150.08' });
      expect(await balance()).toBe(15_008n);
    });

    it('saldo grande sem perda de precisão (acima do inteiro seguro de ponto flutuante)', async () => {
      const huge = 9_007_199_254_740_993n;
      await h.db.client.$executeRaw`UPDATE "account" SET "balance_cents" = ${huge} WHERE "id" = ${account}::uuid`;
      expect((await me.api('GET', '/accounts/me')).body['balance']).toBe('90071992547409.93');
    });
  });

  describe('extrato', () => {
    it('crédito, transferência com modalidade e estorno: direção, valor, contrapartida oculta; soma = saldo; reconciliação', async () => {
      const first = await credit('150.00');
      await credit('50.00');
      const other = (await pe.openAccount(ws(), 'STANDARD')).id;
      const transfer = await pe.execute({ workspaceId: ws(), operationKey: `pix-${randomUUID()}`, debitAccountId: account, creditAccountId: other, amountCents: 3_000n, modality: 'PIX_KEY' });
      const reversal = await pe.reverse({ workspaceId: ws(), operationKey: `estorno-${randomUUID()}`, originalOperationId: transfer.operationId });

      const reply = await me.api('GET', '/accounts/me/statement');
      expect(reply.status).toBe(200);
      expect(reply.body['nextCursor']).toBeNull();
      const list = items(reply);
      expect(list.map((i) => [i.type, i.direction, i.amount, i.modality, i.status])).toEqual([
        ['REVERSAL', 'CREDIT', '30.00', null, 'COMPLETED'],
        ['TRANSFER', 'DEBIT', '30.00', 'PIX_KEY', 'COMPLETED'],
        ['EDUCATIONAL_CREDIT', 'CREDIT', '50.00', null, 'COMPLETED'],
        ['EDUCATIONAL_CREDIT', 'CREDIT', '150.00', null, 'COMPLETED'],
      ]);
      expect(list[0]).toMatchObject({ operationId: reversal.operationId, reversesOperationId: transfer.operationId });
      expect(list[3]?.operationId).toBe(first.body['operationId']);
      const entries = await h.db.client.ledgerEntry.findMany({ where: { accountId: account } });
      expect(list.map((i) => i.entryId).sort()).toEqual(entries.map((e) => e.id).sort());
      // Nenhuma outra conta aparece: nem a contrapartida nem o destino da transferência.
      const contra = await h.db.client.account.findFirstOrThrow({ where: { workspaceId: ws(), kind: 'CONTRA' } });
      expect(reply.text).not.toContain(contra.id);
      expect(reply.text).not.toContain(other);

      const signed = list.reduce((sum, i) => sum + (i.direction === 'CREDIT' ? cents(i.amount) : -cents(i.amount)), 0n);
      expect(signed).toBe(await balance());
      expect((await me.api('GET', '/accounts/me')).body['balance']).toBe('200.00');
      const report = await new ReconciliationService(new PrismaReconciliationReader(h.app.client)).reconcile(ws());
      expect(report).toMatchObject({ consistent: true });
    });

    it('o facilitador vê o mesmo extrato do cliente', async () => {
      await credit('10.00');
      await credit('20.00');
      const own = await me.api('GET', '/accounts/me/statement');
      const seen = await desk.api('GET', `${facilitatorPath()}/statement`);
      expect(seen.status).toBe(200);
      expect(seen.body).toEqual(own.body);
    });

    it('somente lançamentos da própria conta, mesmo com outros clientes movimentando no workspace', async () => {
      const bob = await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email: `bob-${randomUUID()}@example.test`, workspaceId: ws() } });
      const bobAccount = await withAccount({ id: bob.id, email: bob.email, workspaceId: ws(), alias: alice.alias });
      await credit('10.00');
      await desk.api('POST', `/facilitator/workspaces/${ws()}/customers/${bob.id}/account/educational-credits`, { amount: '99.00', justification: REASON }, { 'idempotency-key': `chave-${randomUUID()}` });
      const list = items(await me.api('GET', '/accounts/me/statement'));
      expect(list.map((i) => i.amount)).toEqual(['10.00']);
      const bobs = items(await desk.api('GET', `/facilitator/workspaces/${ws()}/customers/${bob.id}/account/statement`));
      expect(bobs.map((i) => i.amount)).toEqual(['99.00']);
      expect(JSON.stringify(list)).not.toContain(bobAccount);
    });
  });

  describe('paginação', () => {
    it('45 lançamentos no mesmo instante: páginas de 7 sem repetir nem perder, em ordem decrescente com desempate pelo id', async () => {
      await sameInstantEntries(45);
      const { all, pages } = await walk(me, '/accounts/me/statement', 7);
      expect(pages).toBe(7);
      expect(all).toHaveLength(45);
      expect(new Set(all.map((i) => i.entryId)).size).toBe(45);
      expect(new Set(all.map((i) => i.occurredAt)).size).toBe(1);
      const ids = all.map((i) => i.entryId);
      expect(ids).toEqual([...ids].sort().reverse());
      const sum = all.reduce((s, i) => s + cents(i.amount), 0n);
      expect(sum).toBe(await balance());
    });

    it('padrão 20 e máximo 100', async () => {
      await sameInstantEntries(25);
      const first = await me.api('GET', '/accounts/me/statement');
      expect(items(first)).toHaveLength(20);
      expect(first.body['nextCursor']).toEqual(expect.any(String));
      const rest = await me.api('GET', `/accounts/me/statement?cursor=${encodeURIComponent(first.body['nextCursor'] as string)}`);
      expect(items(rest)).toHaveLength(5);
      expect(rest.body['nextCursor']).toBeNull();
      expect(items(await me.api('GET', '/accounts/me/statement?limit=100'))).toHaveLength(25);
    });

    it('lançamento gravado durante a navegação não quebra o cursor nem repete itens', async () => {
      await sameInstantEntries(12);
      const before = (await h.db.client.ledgerEntry.findMany({ where: { accountId: account }, select: { id: true } })).map((e) => e.id);
      const { all } = await walk(me, '/accounts/me/statement', 5, async (page) => {
        if (page === 1) {
          expect((await credit('1.00')).status).toBe(201);
        }
      });
      expect(all.map((i) => i.entryId).sort()).toEqual(before.sort());
      const fresh = items(await me.api('GET', '/accounts/me/statement?limit=1'));
      expect(fresh[0]).toMatchObject({ type: 'EDUCATIONAL_CREDIT', amount: '1.00' });
    });

    it.each(['limit=0', 'limit=101', 'limit=abc', 'limit=1&limit=2', 'cursor=', 'cursor=abc', 'cursor[x]=1', 'offset=0', 'workspaceId=x'])('%s é 400', async (query) => {
      const reply = await me.api('GET', `/accounts/me/statement?${query}`);
      problem(reply, 400, 'VALIDATION_ERROR');
      // Sem eco do valor recebido (o correlationId é aleatório e fica fora da comparação).
      expect(JSON.stringify({ ...reply.body, correlationId: null })).not.toContain('abc');
      problem(await desk.api('GET', `${facilitatorPath()}/statement?${query}`), 400, 'VALIDATION_ERROR');
    });

    it('cursor de outra conta só posiciona: nunca devolve lançamentos alheios', async () => {
      const bob = await h.customer();
      const bobAccount = await withAccount(bob);
      const bobDesk = await facilitatorOf(bob);
      await bobDesk.api('POST', `${facilitatorPath(bob)}/educational-credits`, { amount: '5.00', justification: REASON }, { 'idempotency-key': `chave-${randomUUID()}` });
      await bobDesk.api('POST', `${facilitatorPath(bob)}/educational-credits`, { amount: '6.00', justification: REASON }, { 'idempotency-key': `chave-${randomUUID()}` });
      const bobPage = await (await enter(bob)).api('GET', '/accounts/me/statement?limit=1');
      const cursor = bobPage.body['nextCursor'] as string;
      await credit('7.00');
      const reply = await me.api('GET', `/accounts/me/statement?cursor=${encodeURIComponent(cursor)}`);
      expect(reply.status).toBe(200);
      expect(reply.text).not.toContain(bobAccount);
      expect(items(reply).every((i) => i.amount === '7.00')).toBe(true);
    });
  });

  describe('estados', () => {
    it('conta bloqueada continua consultável e mostra o estado', async () => {
      await credit('10.00');
      expect((await desk.api('POST', `${facilitatorPath()}/block`, { justification: 'Exercício de bloqueio da turma' })).status).toBe(200);
      expect((await me.api('GET', '/accounts/me')).body).toMatchObject({ status: 'BLOCKED', balance: '10.00' });
      expect(items(await me.api('GET', '/accounts/me/statement'))).toHaveLength(1);
      expect((await desk.api('GET', `${facilitatorPath()}/statement`)).status).toBe(200);
    });

    it('workspace arquivado continua legível', async () => {
      await credit('10.00');
      await h.db.client.workspace.update({ where: { id: ws() }, data: { status: 'ARCHIVED' } });
      expect((await me.api('GET', '/accounts/me')).body['balance']).toBe('10.00');
      expect(items(await desk.api('GET', `${facilitatorPath()}/statement`))).toHaveLength(1);
    });

    it('cliente sem conta: 404 para ele e para o facilitador, sem detalhe', async () => {
      const carol = await h.customer();
      const carolDesk = await facilitatorOf(carol);
      const carolMe = await enter(carol);
      problem(await carolMe.api('GET', '/accounts/me'), 404, 'RESOURCE_NOT_FOUND');
      problem(await carolMe.api('GET', '/accounts/me/statement'), 404, 'RESOURCE_NOT_FOUND');
      problem(await carolDesk.api('GET', `${facilitatorPath(carol)}/statement`), 404, 'RESOURCE_NOT_FOUND');
    });
  });

  describe('acesso', () => {
    it('sem sessão 401; facilitador na rota de cliente 403; cliente na rota de facilitador 403', async () => {
      problem(await call(server.url, 'GET', '/api/v1/accounts/me'), 401, 'AUTH_SESSION_REQUIRED');
      problem(await call(server.url, 'GET', '/api/v1/accounts/me/statement'), 401, 'AUTH_SESSION_REQUIRED');
      problem(await desk.api('GET', '/accounts/me'), 403, 'ACCESS_DENIED');
      problem(await desk.api('GET', '/accounts/me/statement'), 403, 'ACCESS_DENIED');
      problem(await me.api('GET', `${facilitatorPath()}/statement`), 403, 'ACCESS_DENIED');
    });

    it('cliente alheio, inexistente ou malformado e facilitador sem vínculo: 404', async () => {
      const bob = await h.customer();
      await withAccount(bob);
      problem(await desk.api('GET', `/facilitator/workspaces/${ws()}/customers/${bob.id}/account/statement`), 404, 'RESOURCE_NOT_FOUND');
      problem(await desk.api('GET', `/facilitator/workspaces/${ws()}/customers/${randomUUID()}/account/statement`), 404, 'RESOURCE_NOT_FOUND');
      problem(await desk.api('GET', `/facilitator/workspaces/${ws()}/customers/x/account/statement`), 404, 'RESOURCE_NOT_FOUND');
      problem(await desk.api('GET', `${facilitatorPath(bob)}/statement`), 404, 'RESOURCE_NOT_FOUND');
    });

    it('sessão restrita (credencial temporária) é recusada com PASSWORD_CHANGE_REQUIRED', async () => {
      const issued = await desk.api('POST', `/facilitator/workspaces/${ws()}/customers/${alice.id}/password-reset`);
      expect(issued.status).toBe(200);
      const restricted = new Browser(server.url);
      expect((await restricted.login(alice, String(issued.body['temporaryCredential']))).status).toBe(200);
      for (const path of ['/accounts/me', '/accounts/me/statement']) {
        const reply = await restricted.api('GET', path);
        problem(reply, 403, 'PASSWORD_CHANGE_REQUIRED');
        expect(reply.text).not.toContain(account);
      }
    });

    it('leitura não grava auditoria nem altera o ledger', async () => {
      await credit('10.00');
      const count = async () => ({
        audits: await h.db.client.auditRecord.count({ where: { workspaceId: ws() } }),
        entries: await h.db.client.ledgerEntry.count({ where: { workspaceId: ws() } }),
        balance: await balance(),
      });
      const before = await count();
      await me.api('GET', '/accounts/me');
      await me.api('GET', '/accounts/me/statement');
      await desk.api('GET', `${facilitatorPath()}/statement`);
      expect(await count()).toEqual(before);
    });
  });
});
