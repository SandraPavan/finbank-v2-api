// Administração de clientes por HTTP: PactumJS e PostgreSQL real, com concorrência.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaCustomerAdministrationStore } from '../../../src/administration/adapters/prisma-customer-administration.store.js';
import { PrismaOperatorStore } from '../../../src/administration/adapters/prisma-operator.store.js';
import { IdentityError } from '../../../src/identity/domain/errors.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, failure, newEmail, PASSWORD, type Person } from '../authentication/support.js';
import { withAuditFailure } from './support.js';

describe('administração de clientes (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let a: Person, b: Person, f: Person;
  let browser: Browser;

  const base = (p: Person): string => `/facilitator/workspaces/${p.workspaceId}/customers`;
  const path = (p: Person, id: string, action: 'disable' | 'enable'): string => `${base(p)}/${id}/${action}`;
  const status = async (id: string) => (await h.db.client.userIdentity.findUniqueOrThrow({ where: { id } })).status;
  const audit = (workspaceId: string | null) =>
    h.db.client.auditRecord.findMany({ where: { workspaceId: workspaceId ?? '' }, orderBy: { occurredAt: 'asc' } });

  function problem(reply: Reply, code: number, name: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status: code, code: name });
    expect(reply.headers['cache-control']).toBe('no-store');
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
  });

  beforeEach(async () => {
    [a, b, f] = [await h.customer(), await h.customer(), await h.facilitator()];
    await h.db.client.workspaceMembership.create({ data: { workspaceId: a.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    browser = new Browser(server.url);
    expect((await browser.login(f, PASSWORD)).status).toBe(200);
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  it('lista só clientes do workspace, paginados em ordem estável, sem outros dados', async () => {
    expect((await browser.api('GET', base(a))).body).toEqual({ items: [{ customerId: a.id, email: a.email, status: 'ACTIVE' }], nextOffset: null });
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const made: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const row = await h.db.client.userIdentity.create({
        data: { profile: 'CUSTOMER', status: 'DISABLED', email: newEmail(), workspaceId: a.workspaceId, createdAt }, select: { id: true },
      });
      made.push(row.id);
    }
    const expected = [...made.sort(), a.id];
    const ids = (r: Reply) => (r.body['items'] as { customerId: string }[]).map((i) => i.customerId);
    const first = await browser.api('GET', base(a));
    expect(ids(first)).toEqual(expected.slice(0, 20));
    expect(first.body['nextOffset']).toBe(20);
    const last = await browser.api('GET', `${base(a)}?offset=20&limit=3`);
    expect([ids(last), last.body['nextOffset']]).toEqual([expected.slice(20), null]);
    problem(await browser.api('GET', `${base(a)}?limit=0`), 400, 'VALIDATION_ERROR');
  });

  it('desativar encerra sessões e impede login; reativar não as restaura; repetir devolve o mesmo', async () => {
    const opened = await h.login(a);
    for (let i = 0; i < 2; i += 1) {
      const reply = await browser.api('POST', path(a, a.id, 'disable'), i === 0 ? undefined : {});
      expect([reply.status, reply.body]).toEqual([200, { customerId: a.id, status: 'DISABLED' }]);
    }
    await failure(h.auth.validate(opened.secret), 'SESSION_INVALID');
    expect((await new Browser(server.url).login(a, PASSWORD)).status).toBe(401);
    for (let i = 0; i < 2; i += 1) {
      expect((await browser.api('POST', path(a, a.id, 'enable'))).body).toEqual({ customerId: a.id, status: 'ACTIVE' });
    }
    await failure(h.auth.validate(opened.secret), 'SESSION_INVALID');
    expect((await new Browser(server.url).login(a, PASSWORD)).status).toBe(200);
    const rows = await audit(a.workspaceId);
    expect(rows.map((r) => `${r.operation} ${r.result}`)).toEqual([
      'CUSTOMER_DISABLE CHANGED', 'CUSTOMER_DISABLE UNCHANGED', 'CUSTOMER_ENABLE CHANGED', 'CUSTOMER_ENABLE UNCHANGED',
    ]);
  });

  it('a auditoria identifica ator, recurso e correlação, sem dados sensíveis', async () => {
    const correlation = `corr-${randomUUID()}`;
    await browser.api('POST', path(a, a.id, 'disable'), undefined, { 'x-correlation-id': correlation });
    const rows = await audit(a.workspaceId);
    expect(rows).toMatchObject([
      { actorType: 'IDENTITY', actorIdentityId: f.id, actorProfile: 'FACILITATOR', resourceType: 'IDENTITY', resourceId: a.id, correlationId: correlation },
    ]);
    const text = JSON.stringify(rows);
    for (const value of [a.email, f.email, PASSWORD, browser.token, ...browser.jar.values()]) {
      expect(text).not.toContain(value);
    }
  });

  it('cliente alheio, inexistente, malformado ou facilitador: mesmo 404, sem efeito nem auditoria', async () => {
    const bodies: unknown[] = [];
    for (const id of [b.id, randomUUID(), 'x', a.id.toUpperCase(), '%00', f.id]) {
      for (const action of ['disable', 'enable'] as const) {
        const reply = await browser.api('POST', path(a, id, action));
        problem(reply, 404, 'RESOURCE_NOT_FOUND');
        bodies.push({ ...reply.body, correlationId: null });
      }
    }
    bodies.forEach((body) => expect(body).toEqual(bodies[0]));
    problem(await browser.api('POST', path(b, b.id, 'disable')), 404, 'RESOURCE_NOT_FOUND');
    expect([await status(b.id), await status(f.id)]).toEqual(['ACTIVE', 'ACTIVE']);
    expect([...(await audit(a.workspaceId)), ...(await audit(b.workspaceId))]).toEqual([]);
  });

  it('sem sessão 401, cliente 403, sem CSRF 403, corpo indevido 400: sem efeito', async () => {
    const url = path(a, a.id, 'disable');
    problem(await call(server.url, 'POST', `/api/v1${url}`), 401, 'AUTH_SESSION_REQUIRED');
    problem(await browser.api('POST', url, undefined, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
    problem(await browser.api('POST', url, { status: 'DISABLED' }), 400, 'VALIDATION_ERROR');
    problem(await browser.api('POST', url, []), 400, 'VALIDATION_ERROR');
    const customer = new Browser(server.url);
    await customer.login(a, PASSWORD);
    problem(await customer.api('POST', path(a, a.id, 'enable')), 403, 'ACCESS_DENIED');
    expect(await status(a.id)).toBe('ACTIVE');
    expect(await audit(a.workspaceId)).toEqual([]);
  });

  it('nenhuma rota cria identidade, workspace ou vínculo', async () => {
    for (const target of [base(a), `${base(a)}/${a.id}`, '/facilitator/workspaces', `/facilitator/workspaces/${a.workspaceId}`, '/facilitator', '/admin', '/bootstrap']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await fetch(`${server.url}/api/v1${target}`, { method, headers: { cookie: browser.cookie, 'x-csrf-token': browser.token } });
        expect(response.status, `${method} ${target}`).toBe(404);
      }
    }
  });

  it('se a auditoria falha, a mudança não acontece e as sessões continuam', async () => {
    const opened = await h.login(a);
    await withAuditFailure(h, 'CUSTOMER_DISABLE', async () => {
      const reply = await browser.api('POST', path(a, a.id, 'disable'));
      problem(reply, 503, 'TEMPORARY_UNAVAILABLE');
      expect(reply.text).not.toMatch(/falha injetada|P0001|audit/);
    });
    expect(await status(a.id)).toBe('ACTIVE');
    expect((await h.auth.validate(opened.secret)).identityId).toBe(a.id);
  });

  it('banco inacessível é falha tipada e sanitizada', async () => {
    const down = new PrismaService({ databaseUrl: 'postgresql://usuario:segredo@127.0.0.1:1/banco' });
    try {
      const store = new PrismaCustomerAdministrationStore(down.client);
      const access = { identityId: randomUUID(), workspaceId: randomUUID(), role: 'FACILITATOR' as const };
      for (const attempt of [() => store.list(access, { limit: 1, offset: 0 }), () => store.setState(access, randomUUID(), 'ACTIVE', 'correlacao')]) {
        const error = (await attempt().catch((e: unknown) => e)) as IdentityError;
        expect(error).toMatchObject({ name: 'IdentityError', code: 'ACCESS_CHECK_FAILED' });
        expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
      }
    } finally {
      await down.onModuleDestroy();
    }
  });

  describe('concorrência', () => {
    const access = () => ({ identityId: f.id, workspaceId: a.workspaceId ?? '', role: 'FACILITATOR' as const });
    const store = () => new PrismaCustomerAdministrationStore(h.app.client);
    const operator = () => new PrismaOperatorStore(h.db.client);

    /** Espera haver conexões paradas em travas do tipo indicado (% = qualquer). */
    async function waiting(type: string, count = 1): Promise<void> {
      await vi.waitFor(async () => {
        const [row] = await h.db.client.$queryRaw<{ total: number }[]>`
          SELECT count(*)::int AS "total" FROM pg_stat_activity WHERE "wait_event_type" = 'Lock' AND "wait_event" LIKE ${type}`;
        expect(row?.total).toBeGreaterThanOrEqual(count);
      }, 10_000);
    }

    it('acesso revogado depois da guarda impede a mudança', async () => {
      await operator().setMembership(a.alias ?? '', f.email, 'REVOKED', 'correlacao-1');
      expect(await store().setState(access(), a.id, 'DISABLED', 'correlacao-2')).toBe(false);
      await operator().setMembership(a.alias ?? '', f.email, 'ACTIVE', 'correlacao-3');
      await operator().setFacilitatorState(f.email, 'DISABLED', 'correlacao-4');
      expect(await store().setState(access(), a.id, 'DISABLED', 'correlacao-5')).toBe(false);
      expect(await status(a.id)).toBe('ACTIVE');
      expect(await store().list(access(), { limit: 10, offset: 0 })).toEqual([]);
    });

    it('mudança em curso: a revogação espera e vale em seguida', async () => {
      let finish: Promise<boolean> | undefined;
      let revoke: Promise<boolean> | undefined;
      const order: string[] = [];
      await h.db.client.$transaction(async (tx) => {
        // Segura a linha do cliente: a mudança já conferiu o acesso e está parada.
        await tx.$queryRaw`SELECT 1 AS "x" FROM "user_identity" WHERE "id" = ${a.id}::uuid FOR UPDATE`;
        finish = store().setState(access(), a.id, 'DISABLED', 'correlacao-1').then((r) => (order.push('mudança'), r));
        await waiting('transactionid');
        revoke = operator().setMembership(a.alias ?? '', f.email, 'REVOKED', 'correlacao-2').then((r) => (order.push('revogação'), r));
        await waiting('advisory');
      }, { timeout: 20_000 });
      expect([await finish, await revoke]).toEqual([true, true]);
      const rows = (await audit(a.workspaceId)).filter((r) => r.operation !== 'MEMBERSHIP_GRANT');
      expect(rows.map((r) => r.operation)).toEqual(['CUSTOMER_DISABLE', 'MEMBERSHIP_REVOKE']);
      expect(await store().setState(access(), a.id, 'ACTIVE', 'correlacao-3')).toBe(false);
    });

    it('revogação em curso: a mudança espera e é negada', async () => {
      let change: Promise<boolean> | undefined;
      let revoke: Promise<boolean> | undefined;
      await h.db.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS "x" FROM "workspace_membership" WHERE "identity_id" = ${f.id}::uuid FOR UPDATE`;
        revoke = operator().setMembership(a.alias ?? '', f.email, 'REVOKED', 'correlacao-1');
        await waiting('transactionid');
        change = store().setState(access(), a.id, 'DISABLED', 'correlacao-2');
        await waiting('advisory');
      }, { timeout: 20_000 });
      expect([await revoke, await change]).toEqual([true, false]);
      expect(await status(a.id)).toBe('ACTIVE');
    });

    it('login e desativação em paralelo nunca deixam sessão ativa', async () => {
      for (let round = 0; round < 8; round += 1) {
        await Promise.allSettled([
          ...Array.from({ length: 4 }, () => h.login(a)),
          store().setState(access(), a.id, 'DISABLED', 'correlacao-1'),
          ...Array.from({ length: 4 }, () => h.login(a)),
        ]);
        expect(await status(a.id)).toBe('DISABLED');
        expect(await h.activeCount(a.id)).toBe(0);
        expect(await store().setState(access(), a.id, 'ACTIVE', 'correlacao-2')).toBe(true);
      }
    });

    it('login parado na abertura da sessão: a desativação concorrente o encerra ou impede', async () => {
      let login: Promise<unknown> | undefined;
      let change: Promise<boolean> | undefined;
      await h.db.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS "x" FROM "password_credential" WHERE "identity_id" = ${a.id}::uuid FOR UPDATE`;
        login = h.login(a).catch((e: unknown) => e);
        await waiting('transactionid');
        change = store().setState(access(), a.id, 'DISABLED', 'correlacao-1');
        await waiting('%', 2);
      }, { timeout: 30_000 });
      await login;
      expect(await change).toBe(true);
      expect(await h.activeCount(a.id)).toBe(0);
    });

    it('dez desativações paralelas: uma mudança e nove repetições auditadas', async () => {
      await Promise.all(Array.from({ length: 10 }, () => store().setState(access(), a.id, 'DISABLED', 'correlacao-1')));
      const results = (await audit(a.workspaceId)).map((r) => r.result);
      expect(results.filter((r) => r === 'CHANGED')).toHaveLength(1);
      expect(results).toHaveLength(10);
    });
  });
});
