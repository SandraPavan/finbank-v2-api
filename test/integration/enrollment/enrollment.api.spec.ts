// Modalidade do workspace e código de inscrição: PactumJS e PostgreSQL real.
import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { PrismaOperatorStore } from '../../../src/administration/adapters/prisma-operator.store.js';
import { RandomTemporaryCredential } from '../../../src/administration/adapters/random-temporary-credential.js';
import { OperatorService } from '../../../src/administration/application/operator.service.js';
import { PrismaEnrollmentStore } from '../../../src/enrollment/adapters/prisma-enrollment.store.js';
import { EnrollmentService, EnrollmentWorkspaceNotFoundError } from '../../../src/enrollment/application/enrollment.service.js';
import { IdentityError } from '../../../src/identity/domain/errors.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { withAuditFailure } from '../administration/support.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';

const sha = (code: string): string => createHash('sha256').update(code.replace(/-/g, '')).digest('hex');

describe('modalidade e código de inscrição (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let a: Person, b: Person, f: Person;
  let desk: Browser;
  let service: EnrollmentService;

  const path = (p: Person = a): string => `/facilitator/workspaces/${p.workspaceId}/enrollment-code`;
  const revisions = (p: Person = a) =>
    h.db.client.workspaceEnrollmentCode.findMany({ where: { workspaceId: p.workspaceId ?? '' }, orderBy: { revision: 'asc' } });
  const audits = (p: Person = a) =>
    h.db.client.auditRecord.findMany({ where: { workspaceId: p.workspaceId ?? '', operation: { in: ['ENROLLMENT_CODE_ISSUE', 'ENROLLMENT_CODE_REVOKE'] } }, orderBy: { occurredAt: 'asc' } });
  const issue = (browser = desk, p: Person = a, headers: Record<string, string> = {}) => browser.api('POST', path(p), undefined, headers);
  const revoke = (browser = desk, p: Person = a, headers: Record<string, string> = {}) => browser.api('DELETE', path(p), undefined, headers);
  const grant = (p: Person, who: Person = f) =>
    h.db.client.workspaceMembership.create({ data: { workspaceId: p.workspaceId ?? '', identityId: who.id, role: 'FACILITATOR', status: 'ACTIVE' } });
  const summary = async (p: Person = a) => (await desk.api('GET', `/facilitator/workspaces/${p.workspaceId}`)).body;

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function enter(person: Person): Promise<Browser> {
    const browser = new Browser(server.url);
    expect((await browser.login(person, PASSWORD)).status).toBe(200);
    return browser;
  }

  async function sharedWorkspace(): Promise<Person> {
    const ws = await h.db.client.workspace.create({ data: { alias: `t-${randomUUID()}`, modality: 'SHARED' }, select: { id: true, alias: true } });
    await h.db.client.workspaceMembership.create({ data: { workspaceId: ws.id, identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    return { ...f, workspaceId: ws.id, alias: ws.alias };
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    service = new EnrollmentService(new PrismaEnrollmentStore(h.app.client));
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

  describe('modalidade', () => {
    const operator = () =>
      new OperatorService({
        store: new PrismaOperatorStore(h.db.client), hasher: new Argon2PasswordHasher(), generator: new RandomTemporaryCredential(),
        temporaryCredentialHours: 24, correlationId: `corr-${randomUUID()}`,
      });

    it('workspace create grava a modalidade escolhida; bootstrap cria ISOLATED; inválida não cria nada', async () => {
      const [shared, isolated, boot, bad] = [`t-${randomUUID()}`, `t-${randomUUID()}`, `t-${randomUUID()}`, `t-${randomUUID()}`];
      await operator().createWorkspace(shared, 'SHARED');
      await operator().createWorkspace(isolated, 'ISOLATED');
      await operator().bootstrap(boot, `boot-${randomUUID()}@example.test`, () => Promise.resolve(PASSWORD));
      await expect(operator().createWorkspace(bad, 'shared')).rejects.toMatchObject({ code: 'INVALID_MODALITY' });
      const rows = await h.db.client.workspace.findMany({ where: { alias: { in: [shared, isolated, boot, bad] } }, select: { alias: true, modality: true } });
      expect(Object.fromEntries(rows.map((r) => [r.alias, r.modality]))).toEqual({ [shared]: 'SHARED', [isolated]: 'ISOLATED', [boot]: 'ISOLATED' });
    });

    it('a modalidade não muda, nem pelo dono; os demais campos continuam alteráveis pelo dono', async () => {
      expect(await sqlState(h.db.client.$executeRaw`UPDATE "workspace" SET "modality" = 'SHARED' WHERE "id" = ${a.workspaceId}::uuid`)).toBe('23001');
      await h.db.client.workspace.update({ where: { id: a.workspaceId ?? '' }, data: { status: 'ARCHIVED' } });
      expect(await h.db.client.workspace.findUniqueOrThrow({ where: { id: a.workspaceId ?? '' } })).toMatchObject({ modality: 'ISOLATED', status: 'ARCHIVED' });
    });

    it('a leitura do facilitador traz modalidade, estado e situação do código, nunca o código nem o hash', async () => {
      const s = await sharedWorkspace();
      expect(await summary(s)).toEqual({
        workspaceId: s.workspaceId, alias: s.alias, modality: 'SHARED', status: 'ACTIVE', enrollment: { active: false, revision: 0, required: true },
      });
      const code = (await issue(desk, s)).body['code'] as string;
      const view = await desk.api('GET', `/facilitator/workspaces/${s.workspaceId}`);
      expect(view.body).toMatchObject({ enrollment: { active: true, revision: 1, required: true } });
      const list = await desk.api('GET', '/facilitator/workspaces');
      for (const text of [view.text, list.text]) {
        expect(text).not.toContain(code);
        expect(text).not.toContain(sha(code));
      }
      await revoke(desk, s);
      expect(await summary(s)).toMatchObject({ enrollment: { active: false, revision: 2, required: true } });
    });
  });

  describe('geração e revogação', () => {
    it('gera XXXX-XXXX-XXXX uma vez; grava só o hash; gerar de novo invalida o anterior', async () => {
      const started = Date.now();
      const first = await issue();
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      const code1 = first.body['code'] as string;
      expect(first.body).toEqual({ workspaceId: a.workspaceId, active: true, revision: 1, required: false, code: code1 });
      expect(code1).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      const code2 = (await issue()).body['code'] as string;
      expect(code2).not.toBe(code1);
      const rows = await revisions();
      expect(rows.map((r) => [r.revision, r.codeHash, r.createdBy])).toEqual([[1, sha(code1), f.id], [2, sha(code2), f.id]]);
      rows.forEach((r) => expect(Math.abs(r.createdAt.getTime() - started)).toBeLessThan(60_000));
      expect(JSON.stringify(rows)).not.toContain(code1.replace(/-/g, ''));
      expect(await service.check(a.workspaceId ?? '', code1)).toBe('INVALID');
      expect(await service.check(a.workspaceId ?? '', code2)).toBe('ACCEPTED');
      expect(await service.check(a.workspaceId ?? '', code2.toLowerCase().replace(/-/g, ''))).toBe('ACCEPTED');
    });

    it('revogação: sem vigente nada muda; com vigente grava revisão sem hash e o código deixa de valer', async () => {
      expect((await revoke()).body).toEqual({ workspaceId: a.workspaceId, active: false, revision: 0, required: false });
      expect(await revisions()).toEqual([]);
      expect(await audits()).toEqual([]);
      const code = (await issue()).body['code'] as string;
      expect((await revoke()).body).toEqual({ workspaceId: a.workspaceId, active: false, revision: 2, required: false });
      expect((await revoke()).body).toMatchObject({ active: false, revision: 2 });
      expect((await revisions()).map((r) => [r.revision, r.codeHash])).toEqual([[1, sha(code)], [2, null]]);
      expect((await audits()).map((r) => r.operation)).toEqual(['ENROLLMENT_CODE_ISSUE', 'ENROLLMENT_CODE_REVOKE']);
      expect(await service.check(a.workspaceId ?? '', code)).toBe('INVALID');
      expect(await service.check(a.workspaceId ?? '', null)).toBe('ACCEPTED');
    });

    it('vinte gerações simultâneas: revisões consecutivas e só o último código vale', async () => {
      const replies = await Promise.all(Array.from({ length: 20 }, () => issue()));
      expect(replies.every((r) => r.status === 200)).toBe(true);
      const rows = await revisions();
      expect(rows.map((r) => r.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      const results = await Promise.all(replies.map(async (r) => [r.body['revision'], await service.check(a.workspaceId ?? '', r.body['code'] as string)]));
      expect(results.filter(([, check]) => check === 'ACCEPTED')).toEqual([[20, 'ACCEPTED']]);
      expect(await audits()).toHaveLength(20);
    });
  });

  describe('verificação', () => {
    it('matriz por modalidade, com código de outro workspace e workspace inexistente', async () => {
      const s = await sharedWorkspace();
      await grant(b);
      expect(await service.check(s.workspaceId ?? '', null)).toBe('REQUIRED');
      expect(await service.check(s.workspaceId ?? '', 'AB12-CD34-EF56')).toBe('INVALID');
      const sharedCode = (await issue(desk, s)).body['code'] as string;
      const otherCode = (await issue(desk, b)).body['code'] as string;
      expect(await service.check(s.workspaceId ?? '', sharedCode)).toBe('ACCEPTED');
      expect(await service.check(s.workspaceId ?? '', otherCode)).toBe('INVALID');
      expect(await service.check(b.workspaceId ?? '', sharedCode)).toBe('INVALID');
      expect(await service.check(s.workspaceId ?? '', '')).toBe('REQUIRED');
      expect(await service.check(s.workspaceId ?? '', 'malformado')).toBe('INVALID');
      expect(await service.check(a.workspaceId ?? '', null)).toBe('ACCEPTED');
      expect(await service.check(b.workspaceId ?? '', null)).toBe('REQUIRED');
      await expect(service.check(randomUUID(), null)).rejects.toBeInstanceOf(EnrollmentWorkspaceNotFoundError);
    });
  });

  describe('acesso', () => {
    it('sem sessão 401, cliente 403, sem CSRF 403, alheio e malformado 404', async () => {
      problem(await call(server.url, 'POST', `/api/v1${path()}`), 401, 'AUTH_SESSION_REQUIRED');
      const customer = await enter(a);
      problem(await issue(customer), 403, 'ACCESS_DENIED');
      problem(await revoke(customer), 403, 'ACCESS_DENIED');
      problem(await issue(desk, a, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
      problem(await revoke(desk, a, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
      for (const target of [b, { ...a, workspaceId: randomUUID() }, { ...a, workspaceId: 'x' }]) {
        problem(await issue(desk, target), 404, 'RESOURCE_NOT_FOUND');
        problem(await revoke(desk, target), 404, 'RESOURCE_NOT_FOUND');
      }
      expect([...(await revisions()), ...(await revisions(b))]).toEqual([]);
    });

    it('vínculo revogado entre a guarda e a gravação: 404 sem gravar', async () => {
      const original: PrismaEnrollmentStore['write'] = Reflect.get(PrismaEnrollmentStore.prototype, 'write');
      const spy = vi.spyOn(PrismaEnrollmentStore.prototype, 'write').mockImplementation(async function (this: PrismaEnrollmentStore, ...args) {
        await h.db.client.workspaceMembership.updateMany({ where: { identityId: f.id }, data: { status: 'REVOKED' } });
        return original.apply(this, args);
      });
      try {
        problem(await issue(), 404, 'RESOURCE_NOT_FOUND');
      } finally {
        spy.mockRestore();
      }
      expect(await revisions()).toEqual([]);
      expect(await audits()).toEqual([]);
    });

    it('workspace arquivado: geração e revogação 409 sem gravar; a leitura continua', async () => {
      await issue();
      await h.db.client.workspace.update({ where: { id: a.workspaceId ?? '' }, data: { status: 'ARCHIVED' } });
      problem(await issue(), 409, 'WORKSPACE_ARCHIVED');
      problem(await revoke(), 409, 'WORKSPACE_ARCHIVED');
      expect(await summary()).toMatchObject({ status: 'ARCHIVED', enrollment: { active: true, revision: 1 } });
      expect(await revisions()).toHaveLength(1);
    });
  });

  it('auditoria: ator, workspace e revisão sem código; falha na auditoria ou no commit não grava', async () => {
    const correlation = `corr-${randomUUID()}`;
    const code = (await issue(desk, a, { 'x-correlation-id': correlation })).body['code'] as string;
    const [row] = await revisions();
    const records = await audits();
    expect(records).toMatchObject([
      {
        actorType: 'IDENTITY', actorIdentityId: f.id, actorProfile: 'FACILITATOR', workspaceId: a.workspaceId, operation: 'ENROLLMENT_CODE_ISSUE',
        resourceType: 'ENROLLMENT_CODE_REVISION', resourceId: row?.id, result: 'CHANGED', correlationId: correlation,
      },
    ]);
    expect(JSON.stringify(records)).not.toMatch(new RegExp(`${code}|${code.replace(/-/g, '')}|${sha(code)}`));
    await withAuditFailure(h, 'ENROLLMENT_CODE_ISSUE', async () => {
      problem(await issue(), 503, 'TEMPORARY_UNAVAILABLE');
    });
    await withAuditFailure(h, 'ENROLLMENT_CODE_REVOKE', async () => {
      problem(await revoke(), 503, 'TEMPORARY_UNAVAILABLE');
    });
    await h.db.client.$executeRawUnsafe(
      `CREATE FUNCTION "test_commit_failure"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha no commit'; END $$`,
    );
    await h.db.client.$executeRawUnsafe(
      'CREATE CONSTRAINT TRIGGER "test_commit_failure" AFTER INSERT ON "workspace_enrollment_code" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "test_commit_failure"()',
    );
    try {
      problem(await issue(), 503, 'TEMPORARY_UNAVAILABLE');
    } finally {
      await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_commit_failure"() CASCADE');
    }
    expect(await revisions()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
    expect(await service.check(a.workspaceId ?? '', code)).toBe('ACCEPTED');
  });

  it('no banco: revisões imutáveis também para o dono; hash e número garantidos', async () => {
    await issue();
    for (const sql of [`UPDATE "workspace_enrollment_code" SET "code_hash" = NULL`, 'DELETE FROM "workspace_enrollment_code"', 'TRUNCATE "workspace_enrollment_code"']) {
      expect(await sqlState(h.db.client.$executeRawUnsafe(sql)), sql).toBe('23001');
    }
    const insert = (revision: number, hash: string | null) =>
      sqlState(h.app.client.$executeRaw`
        INSERT INTO "workspace_enrollment_code" ("workspace_id", "revision", "code_hash", "created_by")
        VALUES (${a.workspaceId}::uuid, ${revision}::int, ${hash}, ${f.id}::uuid)`);
    expect(await insert(2, 'AB12-CD34-EF56'.padEnd(64, 'x'))).toBe('23514');
    expect(await insert(2, 'A'.repeat(64))).toBe('23514');
    expect(await insert(0, null)).toBe('23514');
    expect(await insert(1, null)).toBe('23505');
  });

  it('banco inacessível é falha tipada e sanitizada', async () => {
    const down = new PrismaService({ databaseUrl: 'postgresql://usuario:segredo@127.0.0.1:1/banco' });
    try {
      const error = (await new PrismaEnrollmentStore(down.client).state(randomUUID()).catch((e: unknown) => e)) as IdentityError;
      expect(error).toMatchObject({ name: 'IdentityError', code: 'ACCESS_CHECK_FAILED' });
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
    } finally {
      await down.onModuleDestroy();
    }
  });
});
