// Relógio simulado por HTTP: PactumJS e PostgreSQL real.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityError } from '../../../src/identity/domain/errors.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { PrismaSimulationClockStore } from '../../../src/simulation-clock/adapters/prisma-simulation-clock.store.js';
import { ClockWorkspaceNotFoundError, SimulationClockService } from '../../../src/simulation-clock/application/simulation-clock.service.js';
import type { BusinessDate } from '../../../src/simulation-clock/domain/business-date.js';
import { withAuditFailure } from '../administration/support.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';

describe('relógio simulado (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let a: Person, b: Person, f: Person;
  let desk: Browser;

  const path = (p: Person = a): string => `/facilitator/workspaces/${p.workspaceId}/clock`;
  const revisions = (p: Person = a) =>
    h.db.client.simulationClockRevision.findMany({ where: { workspaceId: p.workspaceId ?? '' }, orderBy: { revision: 'asc' } });
  const audits = (p: Person = a) => h.db.client.auditRecord.findMany({ where: { workspaceId: p.workspaceId ?? '', operation: 'SIMULATION_CLOCK_CHANGE' } });
  const change = (base: number, date: unknown, browser = desk, p: Person = a, headers: Record<string, string> = {}) =>
    browser.api('PATCH', path(p), { baseRevision: base, date }, headers);
  const grant = (p: Person, who: Person = f) =>
    h.db.client.workspaceMembership.create({ data: { workspaceId: p.workspaceId ?? '', identityId: who.id, role: 'FACILITATOR', status: 'ACTIVE' } });
  const iso = (d: Date): string => d.toISOString().slice(0, 10);

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function enter(person: Person): Promise<Browser> {
    const browser = new Browser(server.url);
    expect((await browser.login(person, PASSWORD)).status).toBe(200);
    return browser;
  }

  /** Workspace com instante de criação escolhido pelo dono, vinculado ao facilitador. */
  async function workspaceCreatedAt(instant: string): Promise<Person> {
    const ws = await h.db.client.workspace.create({ data: { alias: `t-${randomUUID()}`, createdAt: new Date(instant) }, select: { id: true } });
    await h.db.client.workspaceMembership.create({ data: { workspaceId: ws.id, identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    return { ...f, workspaceId: ws.id };
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
  });

  beforeEach(async () => {
    [a, b, f] = [await h.customer(), await h.customer(), await h.facilitator()];
    await grant(a);
    desk = await enter(f);
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  describe('revisão 0', () => {
    it.each([
      ['02:30 UTC é o dia anterior em São Paulo', '2026-03-10T02:30:00.000Z', '2026-03-09'],
      ['02:59:59.999 UTC ainda é o dia anterior', '2026-03-10T02:59:59.999Z', '2026-03-09'],
      ['03:00 UTC já é o mesmo dia', '2026-03-10T03:00:00.000Z', '2026-03-10'],
      ['12:00 UTC', '2026-03-10T12:00:00.000Z', '2026-03-10'],
      ['virada do ano', '2027-01-01T01:00:00.000Z', '2026-12-31'],
    ])('%s', async (_label, instant, expected) => {
      const ws = await workspaceCreatedAt(instant);
      const reply = await desk.api('GET', path(ws));
      expect(reply.body).toEqual({ workspaceId: ws.workspaceId, date: expected, revision: 0, timeZone: 'America/Sao_Paulo' });
      expect(await revisions(ws)).toEqual([]);
      expect(await audits(ws)).toEqual([]);
    });

    it('workspace criado agora: data de hoje em São Paulo, sem gravar ao consultar', async () => {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const reply = await desk.api('GET', path());
      expect(reply.body).toMatchObject({ revision: 0, date: today });
      expect(await revisions()).toEqual([]);
    });
  });

  it('alterações gravam revisões encadeadas com autor e instante real, nos dois sentidos', async () => {
    const started = Date.now();
    expect((await change(0, '2027-04-30')).body).toEqual({ workspaceId: a.workspaceId, date: '2027-04-30', revision: 1, timeZone: 'America/Sao_Paulo' });
    expect((await change(1, '2001-01-01')).body).toMatchObject({ date: '2001-01-01', revision: 2 });
    expect((await change(2, '2099-12-31')).body).toMatchObject({ date: '2099-12-31', revision: 3 });
    expect((await change(3, '2000-01-01')).body).toMatchObject({ date: '2000-01-01', revision: 4 });
    expect((await desk.api('GET', path())).body).toMatchObject({ date: '2000-01-01', revision: 4 });
    const rows = await revisions();
    expect(rows.map((r) => [r.revision, iso(r.businessDate), r.createdBy])).toEqual([
      [1, '2027-04-30', f.id],
      [2, '2001-01-01', f.id],
      [3, '2099-12-31', f.id],
      [4, '2000-01-01', f.id],
    ]);
    rows.forEach((r) => expect(Math.abs(r.createdAt.getTime() - started)).toBeLessThan(60_000));
  });

  it('base diferente da vigente é 409 sem gravar', async () => {
    await change(0, '2027-01-01');
    for (const base of [0, 2, 99]) {
      problem(await change(base, '2028-01-01'), 409, 'CLOCK_CONFLICT');
    }
    expect(await revisions()).toHaveLength(1);
  });

  it('vinte gravações simultâneas com a mesma base: uma vence', async () => {
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => change(0, `2030-01-${String(i + 1).padStart(2, '0')}`)));
    const won = replies.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    replies.filter((r) => r.status !== 200).forEach((r) => problem(r, 409, 'CLOCK_CONFLICT'));
    const rows = await revisions();
    expect(rows.map((r) => [r.revision, iso(r.businessDate)])).toEqual([[1, won[0]?.body['date']]]);
    expect(await audits()).toHaveLength(1);
  });

  it.each(['2027-02-30', '2027-02-29', '2027-13-01', '1999-12-31', '2100-01-01', '2027-1-1', '2027-01-01T00:00:00Z', '01/01/2027', '', 'amanhã'])(
    'data %j: 422 sem eco',
    async (date) => {
      const reply = await change(0, date);
      problem(reply, 422, 'CLOCK_DATE_INVALID');
      expect(Object.keys(reply.body).sort()).toEqual(['code', 'correlationId', 'status', 'title', 'type']);
      if (date !== '') {
        expect(reply.text).not.toContain(date);
      }
      expect(await revisions()).toEqual([]);
    },
  );

  it.each<[string, unknown]>([
    ['sem base', { date: '2027-01-01' }], ['sem data', { baseRevision: 0 }], ['base negativa', { baseRevision: -1, date: '2027-01-01' }],
    ['base texto', { baseRevision: '0', date: '2027-01-01' }], ['base fracionária', { baseRevision: 0.5, date: '2027-01-01' }],
    ['data numérica', { baseRevision: 0, date: 20270101 }], ['campo extra', { baseRevision: 0, date: '2027-01-01', workspaceId: 'x' }],
    ['revisão forjada', { baseRevision: 0, date: '2027-01-01', revision: 7 }], ['lista', []],
  ])('%s: 400', async (_label, body) => {
    problem(await desk.api('PATCH', path(), body), 400, 'VALIDATION_ERROR');
    expect(await revisions()).toEqual([]);
  });

  it('a mesma data vigente não grava revisão nem auditoria e devolve o estado atual', async () => {
    const initial = (await desk.api('GET', path())).body['date'];
    expect((await change(0, initial)).body).toMatchObject({ date: initial, revision: 0 });
    await change(0, '2027-06-01');
    expect((await change(1, '2027-06-01')).body).toMatchObject({ date: '2027-06-01', revision: 1 });
    expect(await revisions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  // Sessão restrita: coberta para toda rota do contrato em administration/recovery.api.spec.ts.
  it('acesso: sem sessão 401, cliente 403, sem CSRF 403, alheio e malformado 404', async () => {
    problem(await call(server.url, 'GET', `/api/v1${path()}`), 401, 'AUTH_SESSION_REQUIRED');
    const customer = await enter(a);
    problem(await customer.api('GET', path()), 403, 'ACCESS_DENIED');
    problem(await change(0, '2027-01-01', customer), 403, 'ACCESS_DENIED');
    problem(await change(0, '2027-01-01', desk, a, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
    for (const target of [b, { ...a, workspaceId: randomUUID() }, { ...a, workspaceId: 'x' }]) {
      problem(await desk.api('GET', path(target)), 404, 'RESOURCE_NOT_FOUND');
      problem(await change(0, '2027-01-01', desk, target), 404, 'RESOURCE_NOT_FOUND');
    }
    expect([...(await revisions()), ...(await revisions(b))]).toEqual([]);
  });

  it('vínculo revogado entre a guarda e a gravação: 404 sem gravar', async () => {
    const store = new PrismaSimulationClockStore(h.app.client);
    await h.db.client.workspaceMembership.updateMany({ where: { identityId: f.id }, data: { status: 'REVOKED' } });
    const access = { identityId: f.id, workspaceId: a.workspaceId ?? '', role: 'FACILITATOR' as const };
    expect(await store.publish(access, 1, '2027-01-01' as BusinessDate, 'correlacao-1')).toBe('DENIED');
    await h.db.client.workspaceMembership.updateMany({ where: { identityId: f.id }, data: { status: 'ACTIVE' } });
    const original: PrismaSimulationClockStore['publish'] = Reflect.get(PrismaSimulationClockStore.prototype, 'publish');
    const spy = vi.spyOn(PrismaSimulationClockStore.prototype, 'publish').mockImplementationOnce(async function (this: PrismaSimulationClockStore, ...args) {
      await h.db.client.workspaceMembership.updateMany({ where: { identityId: f.id }, data: { status: 'REVOKED' } });
      return original.apply(this, args);
    });
    try {
      problem(await change(0, '2027-01-01'), 404, 'RESOURCE_NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
    expect(await revisions()).toEqual([]);
  });

  it('workspace arquivado: consulta permitida, alteração 409 sem gravar', async () => {
    await change(0, '2027-01-01');
    await h.db.client.workspace.update({ where: { id: a.workspaceId ?? '' }, data: { status: 'ARCHIVED' } });
    expect((await desk.api('GET', path())).body).toMatchObject({ date: '2027-01-01', revision: 1 });
    problem(await change(1, '2028-01-01'), 409, 'WORKSPACE_ARCHIVED');
    expect(await revisions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('arquivamento em curso faz a alteração esperar e ser recusada', async () => {
    const owner = h.db.client;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const archiving = owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finbank:workspace:${a.workspaceId}`}, 0))`;
      await tx.workspace.update({ where: { id: a.workspaceId ?? '' }, data: { status: 'ARCHIVED' } });
      locked();
      await held;
    }, { timeout: 20_000 });
    await lockTaken;
    const pending = change(0, '2027-01-01');
    await vi.waitFor(async () => {
      const [row] = await owner.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS "waiting" FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`;
      expect(row?.waiting).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 50 });
    release();
    await archiving;
    problem(await pending, 409, 'WORKSPACE_ARCHIVED');
    expect(await revisions()).toEqual([]);
  });

  it('auditoria: ator, workspace e revisão; falha na auditoria ou no commit não grava', async () => {
    const correlation = `corr-${randomUUID()}`;
    await change(0, '2027-01-01', desk, a, { 'x-correlation-id': correlation });
    const [row] = await revisions();
    expect(await audits()).toMatchObject([
      {
        actorType: 'IDENTITY', actorIdentityId: f.id, actorProfile: 'FACILITATOR', workspaceId: a.workspaceId,
        resourceType: 'SIMULATION_CLOCK_REVISION', resourceId: row?.id, result: 'CHANGED', correlationId: correlation,
      },
    ]);
    await withAuditFailure(h, 'SIMULATION_CLOCK_CHANGE', async () => {
      problem(await change(1, '2028-01-01'), 503, 'TEMPORARY_UNAVAILABLE');
    });
    await h.db.client.$executeRawUnsafe(
      `CREATE FUNCTION "test_commit_failure"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha no commit'; END $$`,
    );
    await h.db.client.$executeRawUnsafe(
      'CREATE CONSTRAINT TRIGGER "test_commit_failure" AFTER INSERT ON "simulation_clock_revision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "test_commit_failure"()',
    );
    try {
      problem(await change(1, '2028-01-01'), 503, 'TEMPORARY_UNAVAILABLE');
    } finally {
      await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_commit_failure"() CASCADE');
    }
    expect(await revisions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('today entrega data e revisão vigentes; relógios de workspaces diferentes são independentes', async () => {
    const service = new SimulationClockService(new PrismaSimulationClockStore(h.app.client));
    await grant(b);
    const initialB = await service.today(b.workspaceId ?? '');
    await change(0, '2027-01-01');
    expect(await service.today(a.workspaceId ?? '')).toEqual({ date: '2027-01-01', revision: 1 });
    expect(await service.today(b.workspaceId ?? '')).toEqual(initialB);
    expect((await change(0, '2031-05-05', desk, b)).body).toMatchObject({ revision: 1 });
    expect(await service.today(a.workspaceId ?? '')).toEqual({ date: '2027-01-01', revision: 1 });
    await expect(service.today(randomUUID())).rejects.toBeInstanceOf(ClockWorkspaceNotFoundError);
  });

  it('tempo real continua governando sessão, limite de tentativas e auditoria', async () => {
    const started = Date.now();
    await change(0, '2099-12-31');
    await change(1, '2000-01-01');
    expect((await desk.api('GET', path())).status).toBe(200);
    const sessions = await h.db.client.userSession.findMany({ where: { identityId: f.id, revokedAt: null } });
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) {
      expect(Math.abs(s.idleExpiresAt.getTime() - (started + 30 * 60_000))).toBeLessThan(5 * 60_000);
      expect(s.absoluteExpiresAt.getTime() - started).toBeLessThan(9 * 3_600_000);
    }
    for (const r of await audits()) {
      expect(Math.abs(r.occurredAt.getTime() - started)).toBeLessThan(60_000);
    }
    const before = new Date(started - 1_000);
    expect((await new Browser(server.url).login(a, 'senha errada de propósito')).status).toBe(401);
    const controls = await h.db.client.authenticationControl.findMany({ where: { windowStartedAt: { gte: before } } });
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(Math.abs(c.windowStartedAt.getTime() - Date.now())).toBeLessThan(60_000);
      expect(c.expiresAt.getTime() - Date.now()).toBeLessThan(2 * 86_400_000);
    }
    expect((await enter(a)).token).not.toBe('');
  });

  it('no banco: revisões imutáveis também para o dono; faixa e número garantidos', async () => {
    await change(0, '2027-01-01');
    for (const sql of [`UPDATE "simulation_clock_revision" SET "business_date" = DATE '2030-01-01'`, 'DELETE FROM "simulation_clock_revision"', 'TRUNCATE "simulation_clock_revision"']) {
      expect(await sqlState(h.db.client.$executeRawUnsafe(sql)), sql).toBe('23001');
    }
    const insert = (revision: number, date: string) =>
      sqlState(h.app.client.$executeRaw`
        INSERT INTO "simulation_clock_revision" ("workspace_id", "revision", "business_date", "created_by")
        VALUES (${a.workspaceId}::uuid, ${revision}::int, ${date}::date, ${f.id}::uuid)`);
    expect(await insert(2, '1999-12-31')).toBe('23514');
    expect(await insert(2, '2100-01-01')).toBe('23514');
    expect(await insert(0, '2027-01-01')).toBe('23514');
    expect(await insert(-1, '2027-01-01')).toBe('23514');
    expect(await insert(1, '2028-01-01')).toBe('23505');
  });

  it('banco inacessível é falha tipada e sanitizada', async () => {
    const down = new PrismaService({ databaseUrl: 'postgresql://usuario:segredo@127.0.0.1:1/banco' });
    try {
      const error = (await new PrismaSimulationClockStore(down.client).current(randomUUID()).catch((e: unknown) => e)) as IdentityError;
      expect(error).toMatchObject({ name: 'IdentityError', code: 'ACCESS_CHECK_FAILED' });
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
    } finally {
      await down.onModuleDestroy();
    }
  });
});
