// Configuração educacional por HTTP: PactumJS e PostgreSQL real, com catálogo fictício injetado só aqui.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaEducationalConfigStore } from '../../../src/education/adapters/prisma-educational-config.store.js';
import { DEFECT_CATALOG } from '../../../src/education/defect-catalog.js';
import { EDUCATIONAL_CATALOG } from '../../../src/education/education.module.js';
import { hashLabCode } from '../../../src/education/educational-mode.js';
import { IdentityError } from '../../../src/identity/domain/errors.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';
import { withAuditFailure } from '../administration/support.js';
import { CODE_1, FIXTURE_CATALOG, ID_A, ID_B, ID_C, ID_D, VERSION } from '../../unit/education/fixture-catalog.js';

const NONE = { mode: 'STUDENT', preset: { kind: 'NONE' } };

describe('configuração educacional (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let isolated: { app: NestExpressApplication; url: string };
  let shared: { app: NestExpressApplication; url: string };
  let current: { app: NestExpressApplication; url: string };
  let a: Person, b: Person, f: Person;
  let desk: Browser;

  const path = (p: Person = a): string => `/facilitator/workspaces/${p.workspaceId}/flags`;
  const revisions = (p: Person = a) => h.db.client.educationalConfigRevision.findMany({ where: { workspaceId: p.workspaceId ?? '' }, orderBy: { revision: 'asc' } });
  const audits = (p: Person = a) => h.db.client.auditRecord.findMany({ where: { workspaceId: p.workspaceId ?? '', operation: 'EDUCATIONAL_CONFIG_CHANGE' } });
  const change = (base: number, configuration: unknown, browser = desk, p: Person = a, headers: Record<string, string> = {}) =>
    browser.api('PATCH', path(p), { baseRevision: base, configuration }, headers);

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function enter(person: Person, url: string): Promise<Browser> {
    const browser = new Browser(url);
    expect((await browser.login(person, PASSWORD)).status).toBe(200);
    return browser;
  }

  beforeAll(async () => {
    h = await authHarness();
    const fixture: [unknown, unknown][] = [[EDUCATIONAL_CATALOG, FIXTURE_CATALOG]];
    isolated = await startApp({ COOKIE_TRANSPORT: 'local-http', FINBANK_ENVIRONMENT: 'ISOLATED' }, [], fixture);
    shared = await startApp({ COOKIE_TRANSPORT: 'local-http' }, [], fixture);
    current = await startApp({ COOKIE_TRANSPORT: 'local-http', FINBANK_ENVIRONMENT: 'ISOLATED' });
  });

  beforeEach(async () => {
    [a, b, f] = [await h.customer(), await h.customer(), await h.facilitator()];
    await h.db.client.workspaceMembership.create({ data: { workspaceId: a.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    desk = await enter(f, isolated.url);
  });

  afterAll(async () => {
    for (const server of [isolated, shared, current]) {
      await server?.app.close();
    }
    await h?.close();
  });

  it('sem revisão gravada: padrão sem defeitos, e consultar não grava', async () => {
    const reply = await desk.api('GET', path());
    expect(reply.body).toEqual({
      workspaceId: a.workspaceId, revision: 0, catalogVersion: VERSION, stale: false, mode: 'STUDENT', preset: { kind: 'NONE' },
      enabledDefectIds: [], environment: 'ISOLATED', availableDefectIds: [ID_A, ID_B, ID_C, ID_D],
    });
    expect(await revisions()).toEqual([]);
    const sharedView = await (await enter(f, shared.url)).api('GET', path());
    expect(sharedView.body).toMatchObject({ environment: 'SHARED', availableDefectIds: [ID_A] });
    expect((await (await enter(f, current.url)).api('GET', path())).body).toMatchObject({ catalogVersion: DEFECT_CATALOG.version, availableDefectIds: [] });
  });

  it('alterações gravam revisões encadeadas com autor, versão e instante real', async () => {
    const started = Date.now();
    const lab = await change(0, { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } });
    expect(lab.body).toMatchObject({ revision: 1, preset: { kind: 'LAB' }, enabledDefectIds: [ID_A, ID_B] });
    const controlled = await change(1, { mode: 'CONTROLLED', enabledDefectIds: [ID_D, ID_A] });
    expect(controlled.body).toMatchObject({ revision: 2, mode: 'CONTROLLED', preset: null, enabledDefectIds: [ID_A, ID_D] });
    expect((await change(2, NONE)).body).toMatchObject({ revision: 3, enabledDefectIds: [] });
    expect((await desk.api('GET', path())).body).toMatchObject({ revision: 3, mode: 'STUDENT', preset: { kind: 'NONE' } });
    const rows = await revisions();
    expect(rows.map((r) => [r.revision, r.mode, r.preset, r.labCodeHash, r.enabledDefectIds, r.catalogVersion, r.createdBy])).toEqual([
      [1, 'STUDENT', 'LAB', hashLabCode(CODE_1), [], VERSION, f.id],
      [2, 'CONTROLLED', null, null, [ID_D, ID_A], VERSION, f.id],
      [3, 'STUDENT', 'NONE', null, [], VERSION, f.id],
    ]);
    rows.forEach((r) => expect(Math.abs(r.createdAt.getTime() - started)).toBeLessThan(60_000));
    const text = JSON.stringify([rows, lab.text, controlled.text, await audits()]);
    expect(text).not.toContain(CODE_1);
    expect(lab.text).not.toContain(hashLabCode(CODE_1));
  });

  it('base diferente da vigente é 409 sem gravar', async () => {
    await change(0, NONE);
    for (const base of [0, 2, 99]) {
      problem(await change(base, { mode: 'CONTROLLED' }), 409, 'CONFIGURATION_CONFLICT');
    }
    expect(await revisions()).toHaveLength(1);
  });

  it('vinte gravações simultâneas com a mesma base: uma vence', async () => {
    const replies = await Promise.all(Array.from({ length: 20 }, () => change(0, { mode: 'CONTROLLED', enabledDefectIds: [ID_A] })));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    replies.filter((r) => r.status !== 200).forEach((r) => problem(r, 409, 'CONFIGURATION_CONFLICT'));
    expect(await revisions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['STUDENT sem preset', { mode: 'STUDENT' }],
    ['ALL com par incompatível', { mode: 'STUDENT', preset: { kind: 'ALL' } }],
    ['par incompatível', { mode: 'CONTROLLED', enabledDefectIds: [ID_C, ID_D] }],
    ['inexistente', { mode: 'CONTROLLED', enabledDefectIds: ['d-0000000000000000'] }],
    ['laboratório desconhecido', { mode: 'STUDENT', preset: { kind: 'LAB', code: 'XXXX-YYYY-ZZZZ' } }],
    ['campo de controle', { ...NONE, revision: 5 }],
    ['papel no payload', { ...NONE, role: 'FACILITATOR' }],
    ['modo desconhecido', { mode: 'ADMIN' }],
  ])('%s: 422 sem detalhe nem eco', async (_label, configuration) => {
    const reply = await change(0, configuration);
    problem(reply, 422, 'EDUCATIONAL_CONFIG_INVALID');
    expect(Object.keys(reply.body).sort()).toEqual(['code', 'correlationId', 'status', 'title', 'type']);
    expect(reply.text).not.toMatch(/XXXX-YYYY|d-0000|ADMIN|preset|enabledDefectIds/);
    expect(await revisions()).toEqual([]);
  });

  it('em SHARED o defeito de segurança e o restrito são recusados; ALL vira só o permitido', async () => {
    const browser = await enter(f, shared.url);
    for (const ids of [[ID_B], [ID_C]]) {
      problem(await change(0, { mode: 'CONTROLLED', enabledDefectIds: ids }, browser), 422, 'EDUCATIONAL_CONFIG_INVALID');
    }
    expect((await change(0, { mode: 'STUDENT', preset: { kind: 'ALL' } }, browser)).body).toMatchObject({ revision: 1, enabledDefectIds: [ID_A] });
  });

  it.each<[string, unknown]>([
    ['sem base', { configuration: NONE }], ['base negativa', { baseRevision: -1, configuration: NONE }], ['base texto', { baseRevision: '0', configuration: NONE }],
    ['base fracionária', { baseRevision: 0.5, configuration: NONE }], ['campo extra', { baseRevision: 0, configuration: NONE, workspaceId: 'x' }], ['lista', []],
  ])('%s: 400', async (_label, body) => {
    problem(await desk.api('PATCH', path(), body), 400, 'VALIDATION_ERROR');
    expect(await revisions()).toEqual([]);
  });

  it('acesso: sem sessão 401, cliente 403, sem CSRF 403, alheio e malformado 404, restrita 403', async () => {
    problem(await call(isolated.url, 'GET', `/api/v1${path()}`), 401, 'AUTH_SESSION_REQUIRED');
    const customer = await enter(a, isolated.url);
    for (const method of ['GET', 'PATCH'] as const) {
      problem(await customer.api(method, path(), method === 'PATCH' ? { baseRevision: 0, configuration: NONE } : undefined), 403, 'ACCESS_DENIED');
    }
    problem(await change(0, NONE, desk, a, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
    for (const target of [b, { ...a, workspaceId: randomUUID() }, { ...a, workspaceId: 'x' }]) {
      problem(await desk.api('GET', path(target)), 404, 'RESOURCE_NOT_FOUND');
      problem(await change(0, NONE, desk, target), 404, 'RESOURCE_NOT_FOUND');
    }
    expect([...(await revisions()), ...(await revisions(b))]).toEqual([]);
  });

  it('vínculo revogado entre a guarda e a gravação: 404 sem gravar', async () => {
    const store = new PrismaEducationalConfigStore(h.app.client);
    await h.db.client.workspaceMembership.updateMany({ where: { identityId: f.id }, data: { status: 'REVOKED' } });
    const next = { workspaceId: a.workspaceId ?? '', revision: 1, catalogVersion: VERSION, mode: 'STUDENT' as const, preset: { kind: 'NONE' as const } };
    expect(await store.publish({ identityId: f.id, workspaceId: a.workspaceId ?? '', role: 'FACILITATOR' }, next, 'correlacao-1')).toBe('DENIED');
    await h.db.client.workspaceMembership.updateMany({ where: { identityId: f.id }, data: { status: 'ACTIVE' } });
    const original: PrismaEducationalConfigStore['publish'] = Reflect.get(PrismaEducationalConfigStore.prototype, 'publish');
    const spy = vi.spyOn(PrismaEducationalConfigStore.prototype, 'publish').mockImplementationOnce(async function (this: PrismaEducationalConfigStore, ...args) {
      await h.db.client.workspaceMembership.updateMany({ where: { identityId: f.id }, data: { status: 'REVOKED' } });
      return original.apply(this, args);
    });
    try {
      problem(await change(0, NONE), 404, 'RESOURCE_NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
    expect(await revisions()).toEqual([]);
  });

  it('configurações de workspaces diferentes são independentes', async () => {
    await h.db.client.workspaceMembership.create({ data: { workspaceId: b.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    await change(0, { mode: 'CONTROLLED', enabledDefectIds: [ID_A] });
    expect((await desk.api('GET', path(b))).body).toMatchObject({ revision: 0, enabledDefectIds: [] });
    expect((await change(0, NONE, desk, b)).body).toMatchObject({ revision: 1 });
    expect((await desk.api('GET', path())).body).toMatchObject({ revision: 1, mode: 'CONTROLLED' });
  });

  it('revisão gravada com outra versão do catálogo não ativa nada', async () => {
    await h.db.client.educationalConfigRevision.create({
      data: { workspaceId: a.workspaceId ?? '', revision: 1, catalogVersion: '2025.12.1', mode: 'CONTROLLED', enabledDefectIds: [ID_A], createdBy: f.id },
    });
    expect((await desk.api('GET', path())).body).toMatchObject({ revision: 1, catalogVersion: '2025.12.1', stale: true, enabledDefectIds: [] });
    expect((await change(1, { mode: 'CONTROLLED', enabledDefectIds: [ID_A] })).body).toMatchObject({ revision: 2, stale: false, enabledDefectIds: [ID_A] });
  });

  it('auditoria: ator, workspace e revisão; falha na auditoria ou no commit não grava', async () => {
    const correlation = `corr-${randomUUID()}`;
    await change(0, { mode: 'STUDENT', preset: { kind: 'LAB', code: CODE_1 } }, desk, a, { 'x-correlation-id': correlation });
    const [row] = await revisions();
    expect(await audits()).toMatchObject([
      { actorType: 'IDENTITY', actorIdentityId: f.id, actorProfile: 'FACILITATOR', resourceType: 'EDUCATIONAL_CONFIG_REVISION', resourceId: row?.id, result: 'CHANGED', correlationId: correlation },
    ]);
    await withAuditFailure(h, 'EDUCATIONAL_CONFIG_CHANGE', async () => {
      problem(await change(1, NONE), 503, 'TEMPORARY_UNAVAILABLE');
    });
    await h.db.client.$executeRawUnsafe(
      `CREATE FUNCTION "test_commit_failure"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha no commit'; END $$`,
    );
    await h.db.client.$executeRawUnsafe(
      'CREATE CONSTRAINT TRIGGER "test_commit_failure" AFTER INSERT ON "educational_config_revision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "test_commit_failure"()',
    );
    try {
      problem(await change(1, NONE), 503, 'TEMPORARY_UNAVAILABLE');
    } finally {
      await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_commit_failure"() CASCADE');
    }
    expect(await revisions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('no banco: revisões imutáveis também para o dono; formato garantido', async () => {
    await change(0, { mode: 'CONTROLLED', enabledDefectIds: [ID_A] });
    for (const sql of [`UPDATE "educational_config_revision" SET "revision" = 9`, 'DELETE FROM "educational_config_revision"', 'TRUNCATE "educational_config_revision"']) {
      expect(await sqlState(h.db.client.$executeRawUnsafe(sql)), sql).toBe('23001');
    }
    const insert = (mode: string, preset: string | null, hash: string | null, ids: string[] | null, revision = 2, version = VERSION) =>
      sqlState(h.app.client.$executeRaw`
        INSERT INTO "educational_config_revision" ("workspace_id", "revision", "catalog_version", "mode", "preset", "lab_code_hash", "enabled_defect_ids", "created_by")
        VALUES (${a.workspaceId}::uuid, ${revision}::int, ${version}, ${mode}::"educational_mode", ${preset}::"educational_preset", ${hash}, ${ids}::text[], ${f.id}::uuid)`);
    expect(await insert('STUDENT', null, null, null)).toBe('23514');
    expect(await insert('STUDENT', 'LAB', null, null)).toBe('23514');
    expect(await insert('STUDENT', 'NONE', hashLabCode(CODE_1), null)).toBe('23514');
    expect(await insert('STUDENT', 'LAB', CODE_1, null)).toBe('23514');
    expect(await insert('CONTROLLED', null, null, ['nome-legivel'])).toBe('23514');
    expect(await insert('CONTROLLED', 'NONE', null, [])).toBe('23514');
    expect(await insert('STUDENT', 'NONE', null, null, 0)).toBe('23514');
    expect(await insert('STUDENT', 'NONE', null, null, 2, 'v1')).toBe('23514');
    expect(await insert('STUDENT', 'NONE', null, null, 1)).toBe('23505');
  });

  it('banco inacessível é falha tipada e sanitizada', async () => {
    const down = new PrismaService({ databaseUrl: 'postgresql://usuario:segredo@127.0.0.1:1/banco' });
    try {
      const error = (await new PrismaEducationalConfigStore(down.client).current(randomUUID()).catch((e: unknown) => e)) as IdentityError;
      expect(error).toMatchObject({ name: 'IdentityError', code: 'ACCESS_CHECK_FAILED' });
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
    } finally {
      await down.onModuleDestroy();
    }
  });
});
