// Recuperação de acesso: PactumJS e PostgreSQL real, com prazos movidos pelo dono e concorrência observada.
import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaCustomerAdministrationStore } from '../../../src/administration/adapters/prisma-customer-administration.store.js';
import { PrismaOperatorStore } from '../../../src/administration/adapters/prisma-operator.store.js';
import { RandomTemporaryCredential } from '../../../src/administration/adapters/random-temporary-credential.js';
import { OperatorService } from '../../../src/administration/application/operator.service.js';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { FacilitatorAccess } from '../../../src/http/access-policy.js';
import { OPENAPI_DOCUMENT } from '../../../src/http/openapi.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, failure, OTHER_PASSWORD, PASSWORD, type Person } from '../authentication/support.js';
import { settle, sqlState } from '../payment-execution/support.js';
import { withAuditFailure, withCommitFailure } from './support.js';

@Controller('api/v1/future')
class FutureController {
  @Get()
  @FacilitatorAccess()
  future(): object {
    return {};
  }
}

describe('recuperação de acesso (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let a: Person, b: Person, f: Person;
  let desk: Browser;

  const resetPath = (p: Person, id = p.id): string => `/facilitator/workspaces/${p.workspaceId}/customers/${id}/password-reset`;
  const access = () => ({ identityId: f.id, workspaceId: a.workspaceId ?? '', role: 'FACILITATOR' as const });
  const operator = (correlationId = `c-${randomUUID()}`) =>
    new OperatorService({
      store: new PrismaOperatorStore(h.db.client), hasher: new Argon2PasswordHasher(), generator: new RandomTemporaryCredential(),
      temporaryCredentialHours: 24, correlationId,
    });
  const credentials = (id: string) => h.db.client.temporaryCredential.findMany({ where: { identityId: id }, orderBy: { issuedAt: 'asc' } });
  const permanent = (id: string) => h.db.client.passwordCredential.findUniqueOrThrow({ where: { identityId: id } });
  const audit = (resourceId: string) => h.db.client.auditRecord.findMany({ where: { resourceId }, orderBy: { occurredAt: 'asc' } });
  const operations = async (id: string) => (await audit(id)).map((r) => r.operation);

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
    expect(reply.headers['cache-control']).toBe('no-store');
  }

  async function issue(p: Person = a): Promise<string> {
    const reply = await desk.api('POST', resetPath(p));
    expect(reply.status).toBe(200);
    return String(reply.body['temporaryCredential']);
  }

  /** Emite e entra com a credencial: contexto em sessão restrita. */
  async function restricted(p: Person = a): Promise<{ browser: Browser; temporary: string }> {
    const temporary = await issue(p);
    const browser = new Browser(server.url);
    expect((await browser.login(p, temporary)).status).toBe(200);
    return { browser, temporary };
  }

  /** Vence a credencial pelo dono, com o trigger desligado só aqui. */
  async function expire(identityId: string): Promise<void> {
    await h.db.client.$transaction([
      h.db.client.$executeRaw`ALTER TABLE "temporary_credential" DISABLE TRIGGER "temporary_credential_terminal"`,
      h.db.client.$executeRaw`
        UPDATE "temporary_credential" SET "issued_at" = clock_timestamp() - interval '25 hours', "expires_at" = clock_timestamp()
         WHERE "identity_id" = ${identityId}::uuid`,
      h.db.client.$executeRaw`ALTER TABLE "temporary_credential" ENABLE TRIGGER "temporary_credential_terminal"`,
    ]);
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' }, [FutureController]);
  });

  beforeEach(async () => {
    [a, b, f] = [await h.customer(), await h.customer(), await h.facilitator()];
    await h.db.client.workspaceMembership.create({ data: { workspaceId: a.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    desk = new Browser(server.url);
    expect((await desk.login(f, PASSWORD)).status).toBe(200);
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  describe('jornadas', () => {
    it('cliente: emissão, sessão restrita, senha nova e sessão normal', async () => {
      const { browser, temporary } = await restricted();
      const me = await browser.send('GET', '/me');
      expect(me.body).toMatchObject({ identityId: a.id, profile: 'CUSTOMER', workspaceId: a.workspaceId, passwordChangeRequired: true });
      const [before, token] = [browser.cookie, browser.token];
      const done = await browser.send('POST', '/password/recovery', { newPassword: OTHER_PASSWORD });
      expect([done.status, done.body['passwordChangeRequired']]).toEqual([200, false]);
      expect(browser.cookie).not.toBe(before);
      expect(browser.token).not.toBe(token);
      problem(await call(server.url, 'GET', '/api/v1/auth/me', { headers: { cookie: before } }), 401, 'AUTH_SESSION_REQUIRED');
      expect((await browser.send('GET', '/me')).body).toMatchObject({ passwordChangeRequired: false });
      expect(await h.activeCount(a.id)).toBe(1);
      await h.login(a, OTHER_PASSWORD);
      for (const old of [PASSWORD, temporary]) {
        await failure(h.login(a, old), 'INVALID_CREDENTIALS');
      }
    });

    it('facilitador pelo operador', async () => {
      const issued = await operator().resetFacilitator(` ${f.email.toUpperCase()} `);
      problem(await desk.send('GET', '/me'), 401, 'AUTH_SESSION_REQUIRED');
      await failure(h.login(f), 'INVALID_CREDENTIALS');
      expect(issued.expiresAt.getTime() - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
      const browser = new Browser(server.url);
      await browser.login(f, issued.temporaryCredential);
      problem(await browser.api('GET', '/facilitator/workspaces'), 403, 'PASSWORD_CHANGE_REQUIRED');
      await browser.send('POST', '/password/recovery', { newPassword: OTHER_PASSWORD });
      expect((await browser.api('GET', '/facilitator/workspaces')).status).toBe(200);
      expect(await operations(f.id)).toEqual(['PASSWORD_RESET_ISSUE', 'TEMPORARY_CREDENTIAL_CONSUME', 'PASSWORD_RECOVERY_COMPLETE']);
      expect((await audit(f.id)).map((r) => [r.actorType, r.actorIdentityId, r.workspaceId])).toEqual([
        ['OPERATOR', null, null], ['IDENTITY', f.id, null], ['IDENTITY', f.id, null],
      ]);
    });

    it('a senha nova sai do estado de recuperação: troca comum volta a funcionar', async () => {
      const { browser } = await restricted();
      await browser.send('POST', '/password/recovery', { newPassword: OTHER_PASSWORD });
      const changed = await browser.send('POST', '/password/change', { currentPassword: OTHER_PASSWORD, newPassword: PASSWORD });
      expect(changed.status).toBe(200);
      expect(await operations(a.id)).toEqual([
        'PASSWORD_RESET_ISSUE', 'TEMPORARY_CREDENTIAL_CONSUME', 'PASSWORD_RECOVERY_COMPLETE', 'PASSWORD_CHANGE',
      ]);
    });
  });

  describe('emissão', () => {
    it('invalida senha, sessões e credencial anterior, sem tocar outras pessoas', async () => {
      const other = await h.login(b);
      const opened = await h.login(a);
      const first = await issue();
      await failure(h.auth.validate(opened.secret), 'SESSION_INVALID');
      await failure(h.login(a), 'INVALID_CREDENTIALS');
      const second = await issue();
      expect(second).not.toBe(first);
      await failure(h.login(a, first), 'INVALID_CREDENTIALS');
      const rows = await credentials(a.id);
      expect(rows.map((r) => [r.revokedAt !== null, r.consumedAt !== null])).toEqual([[true, false], [false, false]]);
      expect((await h.login(a, second)).session.scope).toBe('PASSWORD_CHANGE');
      expect((await h.auth.validate(other.secret)).identityId).toBe(b.id);
      expect((await permanent(b.id)).invalidatedAt).toBeNull();
    });

    it('encerra também a sessão restrita de uma emissão anterior', async () => {
      const { browser } = await restricted();
      await issue();
      problem(await browser.send('POST', '/password/recovery', { newPassword: OTHER_PASSWORD }), 401, 'AUTH_SESSION_REQUIRED');
    });

    it('a credencial só aparece na resposta: nem banco, auditoria, me ou console', async () => {
      const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m));
      const out = vi.spyOn(process.stdout, 'write');
      const err = vi.spyOn(process.stderr, 'write');
      try {
        const { browser, temporary } = await restricted();
        const me = await browser.send('GET', '/me');
        const list = await desk.api('GET', `/facilitator/workspaces/${a.workspaceId}/customers`);
        const stored = JSON.stringify([await credentials(a.id), await audit(a.id), await permanent(a.id)]);
        const written = JSON.stringify([...spies, out, err].flatMap((s) => s.mock.calls));
        for (const text of [stored, written, me.text, list.text]) {
          expect(text).not.toContain(temporary);
          expect(text).not.toContain(temporary.replaceAll('-', ''));
        }
        expect((await credentials(a.id))[0]?.hash).toMatch(/^\$argon2id\$/);
      } finally {
        [...spies, out, err].forEach((s) => s.mockRestore());
      }
    });

    it('vale 24 horas pelo relógio do banco', async () => {
      const reply = await desk.api('POST', resetPath(a));
      const [row] = await credentials(a.id);
      expect(reply.body['expiresAt']).toBe(row?.expiresAt.toISOString());
      expect(Math.abs((row?.expiresAt.getTime() ?? 0) - (row?.issuedAt.getTime() ?? 0) - 86_400_000)).toBeLessThan(1000);
    });

    it('identidade desativada ou sem senha: 409 sem efeito', async () => {
      const bare = await h.db.client.userIdentity.create({
        data: { profile: 'CUSTOMER', status: 'ACTIVE', email: `x-${randomUUID()}@example.test`, workspaceId: a.workspaceId }, select: { id: true },
      });
      problem(await desk.api('POST', resetPath(a, bare.id)), 409, 'IDENTITY_STATE_CONFLICT');
      await h.db.client.userIdentity.update({ where: { id: a.id }, data: { status: 'DISABLED' } });
      problem(await desk.api('POST', resetPath(a)), 409, 'IDENTITY_STATE_CONFLICT');
      expect((await permanent(a.id)).invalidatedAt).toBeNull();
      expect([...(await credentials(a.id)), ...(await credentials(bare.id)), ...(await audit(a.id))]).toEqual([]);
      await operator().setFacilitatorState(f.email, 'DISABLED');
      await expect(operator().resetFacilitator(f.email)).rejects.toMatchObject({ code: 'IDENTITY_STATE' });
      await expect(operator().resetFacilitator(a.email)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('alheio, inexistente, malformado ou facilitador: mesmo 404; CSRF e corpo exigidos', async () => {
      const bodies: unknown[] = [];
      for (const id of [b.id, randomUUID(), 'x', f.id]) {
        const reply = await desk.api('POST', resetPath(a, id));
        problem(reply, 404, 'RESOURCE_NOT_FOUND');
        bodies.push({ ...reply.body, correlationId: null });
      }
      bodies.forEach((body) => expect(body).toEqual(bodies[0]));
      problem(await desk.api('POST', resetPath(b)), 404, 'RESOURCE_NOT_FOUND');
      problem(await desk.api('POST', resetPath(a), undefined, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
      problem(await desk.api('POST', resetPath(a), { hours: 1 }), 400, 'VALIDATION_ERROR');
      for (const p of [a, b]) {
        expect((await permanent(p.id)).invalidatedAt).toBeNull();
        await h.login(p);
      }
    });

    it('vínculo revogado depois da guarda impede a emissão', async () => {
      const store = new PrismaCustomerAdministrationStore(h.app.client);
      await operator().setMembership(a.alias ?? '', f.email, 'REVOKED');
      expect(await store.issueCredential(access(), a.id, await new Argon2PasswordHasher().hash(PASSWORD), 24, 'correlacao-1')).toBe('DENIED');
      await h.login(a);
    });

    it('se a auditoria falha, nada muda', async () => {
      const opened = await h.login(a);
      await withAuditFailure(h, 'PASSWORD_RESET_ISSUE', async () => {
        const reply = await desk.api('POST', resetPath(a));
        problem(reply, 503, 'TEMPORARY_UNAVAILABLE');
        expect(reply.text).not.toContain('temporaryCredential');
        await expect(operator().resetFacilitator(f.email)).rejects.toMatchObject({ code: 'ADMINISTRATION_FAILED' });
      });
      await h.auth.validate(opened.secret);
      await h.login(a);
      await h.login(f);
      expect(await credentials(a.id)).toEqual([]);
    });
  });

  describe('uso', () => {
    it('é único; abandonada a sessão restrita, só nova emissão recupera', async () => {
      const { browser, temporary } = await restricted();
      await browser.send('POST', '/logout');
      expect((await new Browser(server.url).login(a, temporary)).status).toBe(401);
      await failure(h.login(a), 'INVALID_CREDENTIALS');
      await h.login(a, await issue());
    });

    it('vinte logins simultâneos: um abre sessão e há um consumo auditado', async () => {
      const temporary = await issue();
      const { ok, errors } = await settle(Array.from({ length: 20 }, () => h.login(a, temporary)));
      expect(ok).toHaveLength(1);
      errors.forEach((e) => expect(e).toMatchObject({ code: 'INVALID_CREDENTIALS' }));
      expect(await h.activeCount(a.id)).toBe(1);
      expect((await operations(a.id)).filter((o) => o === 'TEMPORARY_CREDENTIAL_CONSUME')).toHaveLength(1);
    });

    it('expirada, usada, revogada, errada ou sem recuperação: recusas idênticas, com uma verificação', async () => {
      const [expired, used, revoked, wrong] = [await h.customer(), await h.customer(), await h.customer(), await h.customer()];
      const values = new Map<Person, string>();
      for (const p of [expired, used, revoked, wrong]) {
        await h.db.client.workspaceMembership.create({ data: { workspaceId: p.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
        values.set(p, await issue(p));
      }
      await expire(expired.id);
      await h.login(used, values.get(used));
      await issue(revoked);
      values.set(wrong, new RandomTemporaryCredential().generate());
      const verify = vi.spyOn(Argon2PasswordHasher.prototype, 'verify');
      const seen: unknown[] = [];
      try {
        for (const [p, value] of [...values, [a, new RandomTemporaryCredential().generate()] as const]) {
          const reply = await new Browser(server.url).login(p, value);
          problem(reply, 401, 'AUTH_INVALID_CREDENTIALS');
          expect(reply.setCookies).toEqual([]);
          seen.push({ ...reply.body, correlationId: null });
        }
        expect(verify).toHaveBeenCalledTimes(5);
      } finally {
        verify.mockRestore();
      }
      seen.forEach((body) => expect(body).toEqual(seen[0]));
      await failure(h.login(expired), 'INVALID_CREDENTIALS');
    });

    it('não serve a outra identidade, perfil ou workspace', async () => {
      const twin = await h.customer({ email: a.email });
      const temporary = await issue();
      for (const p of [twin, b, { ...a, alias: b.alias }, f]) {
        await failure(h.login(p, temporary), 'INVALID_CREDENTIALS');
      }
      await failure(h.auth.loginFacilitator({ email: a.email, password: temporary }), 'INVALID_CREDENTIALS');
      await h.login(a, temporary);
    });

    it('a comparação é exata', async () => {
      const temporary = await issue();
      for (const value of [temporary.toLowerCase(), temporary.replaceAll('-', ''), ` ${temporary}`, `${temporary} `]) {
        if (value !== temporary) {
          await failure(h.login(a, value), 'INVALID_CREDENTIALS');
        }
      }
      await h.login(a, temporary);
    });

    it('identidade desativada não entra nem consome; reativada, usa se ainda vale', async () => {
      const temporary = await issue();
      await desk.api('POST', `/facilitator/workspaces/${a.workspaceId}/customers/${a.id}/disable`);
      await failure(h.login(a, temporary), 'INVALID_CREDENTIALS');
      await desk.api('POST', `/facilitator/workspaces/${a.workspaceId}/customers/${a.id}/enable`);
      expect((await h.login(a, temporary)).session.scope).toBe('PASSWORD_CHANGE');
    });

    it('conta tentativas e respeita a restrição do login', async () => {
      const temporary = await issue();
      for (let i = 0; i < 5; i += 1) {
        expect((await new Browser(server.url).login(a, OTHER_PASSWORD)).status).toBe(401);
      }
      problem(await new Browser(server.url).login(a, temporary), 429, 'RATE_LIMIT_EXCEEDED');
      expect((await credentials(a.id))[0]?.consumedAt).toBeNull();
    });

    it('se a auditoria falha, a credencial não é consumida nem abre sessão', async () => {
      const temporary = await issue();
      await withAuditFailure(h, 'TEMPORARY_CREDENTIAL_CONSUME', async () => {
        await failure(h.login(a, temporary), 'AUTHENTICATION_FAILED');
      });
      expect(await h.activeCount(a.id)).toBe(0);
      await h.login(a, temporary);
    });
  });

  describe('sessão restrita', () => {
    const ALLOWED = ['get /api/v1/openapi.json', 'get /api/v1/auth/csrf', 'get /api/v1/auth/me', 'post /api/v1/auth/logout',
      'post /api/v1/auth/logout-all', 'post /api/v1/auth/password/recovery', 'post /api/v1/auth/customer/login', 'post /api/v1/auth/facilitator/login'];
    const routes = Object.entries(OPENAPI_DOCUMENT.paths).flatMap(([path, item]) => Object.keys(item).map((m) => `${m} ${path}`));

    it('toda rota fora da lista permitida recebe PASSWORD_CHANGE_REQUIRED, inclusive uma nova', async () => {
      expect(ALLOWED.every((r) => routes.includes(r))).toBe(true);
      const issued = await operator().resetFacilitator(f.email);
      const facilitator = new Browser(server.url);
      await facilitator.login(f, issued.temporaryCredential);
      // `desk` perdeu a sessão: a emissão ao cliente vem direto do adaptador.
      const temporary = new RandomTemporaryCredential().generate();
      await h.db.client.userIdentity.update({ where: { id: f.id }, data: { status: 'ACTIVE' } });
      const store = new PrismaCustomerAdministrationStore(h.app.client);
      await store.issueCredential(access(), a.id, await new Argon2PasswordHasher().hash(temporary), 24, 'correlacao-1');
      const customer = new Browser(server.url);
      expect((await customer.login(a, temporary)).status).toBe(200);
      for (const browser of [facilitator, customer]) {
        const denied = [...routes.filter((r) => !ALLOWED.includes(r)), 'get /api/v1/future'];
        expect(denied).toHaveLength(routes.length - ALLOWED.length + 1);
        for (const route of denied) {
          const [method = '', path = ''] = route.split(' ');
          const url = path.replace('/api/v1', '').replace('{workspaceId}', a.workspaceId ?? '').replace('{customerId}', a.id);
          const reply = await browser.api(method.toUpperCase() as 'GET' | 'POST' | 'PATCH', url, method === 'post' && path.endsWith('change') ? { currentPassword: temporary, newPassword: OTHER_PASSWORD } : undefined);
          problem(reply, 403, 'PASSWORD_CHANGE_REQUIRED');
        }
        expect((await browser.send('GET', '/csrf')).status).toBe(200);
        expect((await browser.send('GET', '/me')).status).toBe(200);
      }
      expect(await h.db.client.userIdentity.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'ACTIVE' });
      await failure(h.auth.changePassword((await h.login(b)).secret, 'x'.repeat(12), OTHER_PASSWORD), 'INVALID_CREDENTIALS');
    });

    it('o serviço também recusa a troca comum, sem depender da rota', async () => {
      const opened = await h.login(a, await issue());
      await failure(h.auth.changePassword(opened.secret, PASSWORD, OTHER_PASSWORD), 'PASSWORD_CHANGE_REQUIRED');
      const normal = await h.login(b);
      await failure(h.auth.completeRecovery(normal.secret, OTHER_PASSWORD), 'NOT_IN_RECOVERY');
      await h.login(b);
    });

    it('logout-all e novo login no contexto encerram a restrita', async () => {
      const { browser } = await restricted();
      expect((await browser.send('POST', '/logout-all')).status).toBe(204);
      expect(await h.activeCount(a.id)).toBe(0);
      const again = await restricted();
      expect((await again.browser.login(b, PASSWORD)).body).toMatchObject({ identityId: b.id, passwordChangeRequired: false });
      expect(await h.activeCount(a.id)).toBe(0);
    });

    it('conclusão exige CSRF, sessão restrita, campos exatos, política e senha diferente da temporária', async () => {
      const { browser, temporary } = await restricted();
      const url = '/password/recovery';
      problem(await browser.send('POST', url, { newPassword: OTHER_PASSWORD }, { 'x-csrf-token': 'A'.repeat(43) }), 403, 'CSRF_VALIDATION_FAILED');
      problem(await browser.send('POST', url, { newPassword: OTHER_PASSWORD }, { 'sec-fetch-site': 'cross-site' }), 403, 'CSRF_VALIDATION_FAILED');
      problem(await browser.send('POST', url, { newPassword: OTHER_PASSWORD, currentPassword: temporary }), 400, 'VALIDATION_ERROR');
      problem(await browser.send('POST', url, {}), 400, 'VALIDATION_ERROR');
      for (const newPassword of ['curta', temporary]) {
        problem(await browser.send('POST', url, { newPassword }), 422, 'PASSWORD_POLICY_VIOLATION');
      }
      problem(await call(server.url, 'POST', `/api/v1/auth${url}`, { json: { newPassword: OTHER_PASSWORD } }), 401, 'AUTH_SESSION_REQUIRED');
      problem(await desk.send('POST', url, { newPassword: OTHER_PASSWORD }), 403, 'ACCESS_DENIED');
      expect((await browser.send('GET', '/me')).body['passwordChangeRequired']).toBe(true);
      expect((await browser.send('POST', url, { newPassword: OTHER_PASSWORD })).status).toBe(200);
      problem(await browser.send('POST', url, { newPassword: PASSWORD }), 403, 'ACCESS_DENIED');
    });

    it('se a auditoria falha, a senha e a sessão restrita ficam como estavam', async () => {
      const { browser } = await restricted();
      await withAuditFailure(h, 'PASSWORD_RECOVERY_COMPLETE', async () => {
        problem(await browser.send('POST', '/password/recovery', { newPassword: OTHER_PASSWORD }), 503, 'TEMPORARY_UNAVAILABLE');
      });
      await failure(h.login(a, OTHER_PASSWORD), 'INVALID_CREDENTIALS');
      expect((await browser.send('POST', '/password/recovery', { newPassword: OTHER_PASSWORD })).status).toBe(200);
      await withAuditFailure(h, 'PASSWORD_CHANGE', async () => {
        problem(await browser.send('POST', '/password/change', { currentPassword: OTHER_PASSWORD, newPassword: PASSWORD }), 503, 'TEMPORARY_UNAVAILABLE');
      });
      await h.login(a, OTHER_PASSWORD);
    });
  });

  it('a auditoria traz ator, escopo e a correlação da requisição', async () => {
    const correlation = `corr-${randomUUID()}`;
    const headers = { 'x-correlation-id': correlation };
    const temporary = String((await desk.api('POST', resetPath(a), undefined, headers)).body['temporaryCredential']);
    const browser = new Browser(server.url, headers);
    await browser.login(a, temporary);
    await browser.send('POST', '/password/recovery', { newPassword: OTHER_PASSWORD });
    await browser.send('POST', '/password/change', { currentPassword: OTHER_PASSWORD, newPassword: PASSWORD });
    const rows = await audit(a.id);
    expect(rows.map((r) => [r.operation, r.actorIdentityId, r.actorProfile, r.workspaceId, r.resourceType, r.result, r.correlationId])).toEqual([
      ['PASSWORD_RESET_ISSUE', f.id, 'FACILITATOR', a.workspaceId, 'IDENTITY', 'CHANGED', correlation],
      ...['TEMPORARY_CREDENTIAL_CONSUME', 'PASSWORD_RECOVERY_COMPLETE', 'PASSWORD_CHANGE'].map((o) => [o, a.id, 'CUSTOMER', a.workspaceId, 'IDENTITY', 'CHANGED', correlation]),
    ]);
    const text = JSON.stringify(rows);
    for (const value of [temporary, PASSWORD, OTHER_PASSWORD, a.email, browser.token, 'argon2']) {
      expect(text).not.toContain(value);
    }
  });

  it('operação desfeita no commit não deixa auditoria', async () => {
    const store = new PrismaCustomerAdministrationStore(h.app.client);
    const hash = await new Argon2PasswordHasher().hash(PASSWORD);
    const other = await h.login(b);
    const temporary = await issue();
    const before = await operations(a.id);
    await withCommitFailure(h, 'temporary_credential', async () => {
      await expect(store.issueCredential(access(), a.id, hash, 24, 'correlacao-1')).rejects.toMatchObject({ code: 'ACCESS_CHECK_FAILED' });
      await expect(operator().resetFacilitator(f.email)).rejects.toMatchObject({ code: 'ADMINISTRATION_FAILED' });
      await failure(h.login(a, temporary), 'AUTHENTICATION_FAILED');
    });
    await withCommitFailure(h, 'user_identity', async () => {
      await expect(store.setState(access(), a.id, 'DISABLED', 'correlacao-1')).rejects.toMatchObject({ code: 'ACCESS_CHECK_FAILED' });
    });
    await h.login(a, temporary);
    const restrictedSession = await (async () => h.login(a, await issue()))();
    const [mine, theirs] = [await operations(a.id), await operations(b.id)];
    await withCommitFailure(h, 'user_session', async () => {
      await expect(h.auth.completeRecovery(restrictedSession.secret, OTHER_PASSWORD)).rejects.toThrow();
      await expect(h.auth.changePassword(other.secret, PASSWORD, OTHER_PASSWORD)).rejects.toThrow();
    });
    expect(before).toEqual(['PASSWORD_RESET_ISSUE']);
    expect(mine).toEqual(['PASSWORD_RESET_ISSUE', 'TEMPORARY_CREDENTIAL_CONSUME', 'PASSWORD_RESET_ISSUE', 'TEMPORARY_CREDENTIAL_CONSUME']);
    expect([await operations(a.id), await operations(b.id), await operations(f.id)]).toEqual([mine, theirs, []]);
  });

  describe('banco', () => {
    it('a execução não emite para facilitador e nada reativa credencial terminada', async () => {
      const hash = await new Argon2PasswordHasher().hash(PASSWORD);
      const insert = (client: AuthHarness['db'], id: string) => client.client.$executeRaw`
        INSERT INTO "temporary_credential" ("identity_id", "hash", "expires_at") VALUES (${id}::uuid, ${hash}, clock_timestamp() + interval '1 hour')`;
      expect(await sqlState(insert(h.app, f.id))).toBe('42501');
      expect(await sqlState(insert(h.app, randomUUID()))).toBe('42501');
      const consumed = await issue();
      await h.login(a, consumed);
      await issue();
      await issue();
      const [used, revoked, live] = await credentials(a.id);
      const set = (client: AuthHarness['db'], id: string | undefined, column: string) =>
        sqlState(client.client.$executeRawUnsafe(`UPDATE "temporary_credential" SET ${column} WHERE "id" = '${id}'`));
      for (const client of [h.app, h.db]) {
        for (const row of [used, revoked]) {
          expect(await set(client, row?.id, '"consumed_at" = NULL')).toBe('23001');
          expect(await set(client, row?.id, '"revoked_at" = NULL')).toBe('23001');
        }
      }
      for (const column of [`"expires_at" = "expires_at" + interval '1 hour'`, `"hash" = "hash" || ''`, '"identity_id" = gen_random_uuid()']) {
        expect(await set(h.app, live?.id, column)).toBe('42501');
      }
      expect(await set(h.db, live?.id, `"expires_at" = "expires_at" + interval '1 hour'`)).toBe('23001');
      expect(await set(h.db, live?.id, '"consumed_at" = now(), "revoked_at" = now()')).toBe('23514');
      await expire(a.id);
      expect(await set(h.app, live?.id, '"consumed_at" = now()')).toBe('23001');
      expect(await sqlState(h.db.client.$executeRaw`UPDATE "user_session" SET "scope" = 'NORMAL' WHERE "identity_id" = ${a.id}::uuid`)).toBe('23001');
      expect(await sqlState(h.db.client.$executeRaw`
        INSERT INTO "temporary_credential" ("identity_id", "hash", "expires_at") VALUES (${b.id}::uuid, 'em claro', clock_timestamp() + interval '1 hour')`)).toBe('23514');
    });

    it('sessão sem escopo declarado é recusada', async () => {
      expect(await sqlState(h.app.client.$executeRaw`
        INSERT INTO "user_session" ("identity_id", "token_hash", "created_at", "last_activity_at", "idle_expires_at", "absolute_expires_at")
        VALUES (${a.id}::uuid, ${randomBytes(32).toString('hex')}, now(), now(), now(), now())`)).toBe('23502');
    });
  });

  describe('concorrência', () => {
    const hasher = new Argon2PasswordHasher();
    async function direct(): Promise<{ temporary: string; issue: () => Promise<unknown> }> {
      const temporary = new RandomTemporaryCredential().generate();
      const hash = await hasher.hash(temporary);
      const store = new PrismaCustomerAdministrationStore(h.app.client);
      return { temporary, issue: () => store.issueCredential(access(), a.id, hash, 24, 'correlacao-1') };
    }

    async function waiting(count: number): Promise<void> {
      await vi.waitFor(async () => {
        const [row] = await h.db.client.$queryRaw<{ total: number }[]>`
          SELECT count(*)::int AS "total" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(row?.total).toBe(count);
      }, 10_000);
    }

    /** Com a credencial travada pelo dono, `first` entra na fila antes de `second`. */
    async function queue<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
      let started: [Promise<PromiseSettledResult<A>[]>, Promise<PromiseSettledResult<B>[]>] | undefined;
      await h.db.client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS "x" FROM "password_credential" WHERE "identity_id" = ${a.id}::uuid FOR UPDATE`;
        const x = Promise.allSettled([first()]);
        await waiting(1);
        const y = Promise.allSettled([second()]);
        await waiting(2);
        started = [x, y];
      }, { timeout: 30_000 });
      const [[x], [y]] = await Promise.all(started as NonNullable<typeof started>);
      return [x as PromiseSettledResult<A>, y as PromiseSettledResult<B>] as const;
    }

    it('dez emissões paralelas deixam uma credencial utilizável', async () => {
      const made = await Promise.all(Array.from({ length: 10 }, () => direct()));
      await Promise.all(made.map((m) => m.issue()));
      const rows = await credentials(a.id);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
      const { ok } = await settle(made.map((m) => h.login(a, m.temporary)));
      expect(ok).toHaveLength(1);
    });

    it('login com a senha antes da emissão: a sessão dele é encerrada', async () => {
      const d = await direct();
      const [login, issued] = await queue(() => h.login(a), d.issue);
      expect(issued.status).toBe('fulfilled');
      if (login.status === 'fulfilled') {
        await failure(h.auth.validate(login.value.secret), 'SESSION_INVALID');
      }
      expect(await h.activeCount(a.id)).toBe(0);
    });

    it('emissão antes do login com a senha: o login é recusado', async () => {
      const d = await direct();
      const [, login] = await queue(d.issue, () => h.login(a));
      expect(login).toMatchObject({ status: 'rejected', reason: { code: 'INVALID_CREDENTIALS' } });
      expect(await h.activeCount(a.id)).toBe(0);
    });

    it('troca de senha e emissão, nas duas ordens: nenhuma senha ou sessão sobrevive', async () => {
      for (const changeFirst of [true, false]) {
        a = await h.customer();
        await h.db.client.workspaceMembership.create({ data: { workspaceId: a.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
        const { secret } = await h.login(a);
        const d = await direct();
        const change = () => h.auth.changePassword(secret, PASSWORD, OTHER_PASSWORD);
        await (changeFirst ? queue(change, d.issue) : queue<unknown, unknown>(d.issue, change));
        for (const password of [PASSWORD, OTHER_PASSWORD]) {
          await failure(h.login(a, password), 'INVALID_CREDENTIALS');
        }
        expect(await h.activeCount(a.id)).toBe(0);
        expect((await h.login(a, d.temporary)).session.scope).toBe('PASSWORD_CHANGE');
      }
    });

    it('conclusão e nova emissão, nas duas ordens: vale só a credencial nova', async () => {
      for (const completeFirst of [true, false]) {
        a = await h.customer();
        await h.db.client.workspaceMembership.create({ data: { workspaceId: a.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
        const first = await direct();
        await first.issue();
        const { secret } = await h.login(a, first.temporary);
        const d = await direct();
        const complete = () => h.auth.completeRecovery(secret, OTHER_PASSWORD);
        await (completeFirst ? queue(complete, d.issue) : queue<unknown, unknown>(d.issue, complete));
        await failure(h.login(a, OTHER_PASSWORD), 'INVALID_CREDENTIALS');
        expect(await h.activeCount(a.id)).toBe(0);
        await h.login(a, d.temporary);
      }
    });

    it('uso e nova emissão, nas duas ordens: a credencial antiga não deixa sessão', async () => {
      for (const useFirst of [true, false]) {
        a = await h.customer();
        await h.db.client.workspaceMembership.create({ data: { workspaceId: a.workspaceId ?? '', identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
        const first = await direct();
        await first.issue();
        const d = await direct();
        const use = () => h.login(a, first.temporary);
        await (useFirst ? queue(use, d.issue) : queue<unknown, unknown>(d.issue, use));
        expect(await h.activeCount(a.id)).toBe(0);
        await h.login(a, d.temporary);
      }
    });

    it('conclusões paralelas: uma vence e resta uma sessão', async () => {
      const { secret } = await h.login(a, await issue());
      const { ok, errors } = await settle(Array.from({ length: 5 }, (_, i) => h.auth.completeRecovery(secret, `${OTHER_PASSWORD} ${i}`)));
      expect(ok).toHaveLength(1);
      expect(errors).toHaveLength(4);
      expect(await h.activeCount(a.id)).toBe(1);
      await h.auth.validate(ok[0]?.secret);
    });
  });
});
