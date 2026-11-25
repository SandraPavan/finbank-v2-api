import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { spec } from 'pactum';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { csrfToken } from '../../../src/authentication/http/csrf.js';
import { OPENAPI_DOCUMENT } from '../../../src/http/openapi.js';
import { Browser, call, type Reply, startApp } from './http-support.js';
import { type AuthHarness, authHarness, OTHER_PASSWORD, PASSWORD, sha256 } from './support.js';

const POSTS = ['/customer/login', '/facilitator/login', '/logout', '/logout-all', '/password/change'] as const;
const secret = (): string => randomBytes(32).toString('base64url');

describe('autenticação por HTTP (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let local: { app: NestExpressApplication; url: string };
  let secure: { app: NestExpressApplication; url: string };

  beforeAll(async () => {
    h = await authHarness();
    local = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    secure = await startApp();
  });

  afterAll(async () => {
    await local?.app.close();
    await secure?.app.close();
    await h?.close();
  });

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body['correlationId']).toBe(reply.headers['x-correlation-id']);
    expect(reply.body['type']).toBe(`urn:finbank:problem:${code.toLowerCase()}`);
  }

  describe('jornadas', () => {
    it('cliente: csrf, login, consulta, troca de senha e logout', async () => {
      const person = await h.customer();
      const b = new Browser(local.url);
      const entered = await b.login(person, PASSWORD);
      expect(entered.status).toBe(200);
      expect(entered.body).toMatchObject({ identityId: person.id, profile: 'CUSTOMER', workspaceId: person.workspaceId });
      const me = await b.send('GET', '/me');
      expect(me.body).toMatchObject({ identityId: person.id, profile: 'CUSTOMER', workspaceId: person.workspaceId });
      const changed = await b.send('POST', '/password/change', { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD });
      expect(changed.status).toBe(200);
      expect((await b.send('GET', '/me')).status).toBe(200);
      expect((await b.send('POST', '/logout')).status).toBe(204);
      expect(b.jar.size).toBe(0);
      problem(await b.send('GET', '/me'), 401, 'AUTH_SESSION_REQUIRED');
      expect((await new Browser(local.url).login(person, OTHER_PASSWORD)).status).toBe(200);
    });

    it('facilitador: login global e encerramento de todas as sessões', async () => {
      const person = await h.facilitator();
      const [a, b] = [new Browser(local.url), new Browser(local.url)];
      expect((await a.login(person, PASSWORD)).body).toMatchObject({ profile: 'FACILITATOR', workspaceId: null });
      await b.login(person, PASSWORD);
      expect((await a.send('POST', '/logout-all')).status).toBe(204);
      expect(a.jar.size).toBe(0);
      problem(await b.send('GET', '/me'), 401, 'AUTH_SESSION_REQUIRED');
    });

    it('logout sem contexto, repetido e com sessão já encerrada devolve 204', async () => {
      expect((await new Browser(local.url).send('POST', '/logout')).status).toBe(204);
      const b = new Browser(local.url);
      await b.login(await h.customer(), PASSWORD);
      const [jar, token] = [new Map(b.jar), b.token];
      expect((await b.send('POST', '/logout')).status).toBe(204);
      const again = new Browser(local.url);
      jar.forEach((v, k) => again.jar.set(k, v));
      again.token = token;
      expect((await again.send('POST', '/logout')).status).toBe(204);
      expect(again.jar.size).toBe(0);
    });

    it('sessão expirada é distinguida e o contexto permite novo login', async () => {
      const person = await h.customer();
      const b = new Browser(local.url);
      await b.login(person, PASSWORD);
      await h.db.client.$transaction([
        h.db.client.$executeRaw`ALTER TABLE "user_session" DISABLE TRIGGER "user_session_terminal"`,
        h.db.client.$executeRaw`UPDATE "user_session" SET "created_at" = now() - interval '2 days', "last_activity_at" = now() - interval '2 days',
          "idle_expires_at" = now() - interval '1 minute' WHERE "identity_id" = ${person.id}::uuid`,
        h.db.client.$executeRaw`ALTER TABLE "user_session" ENABLE TRIGGER "user_session_terminal"`,
      ]);
      problem(await b.send('GET', '/me'), 401, 'AUTH_SESSION_EXPIRED');
      problem(await b.send('POST', '/logout-all'), 401, 'AUTH_SESSION_EXPIRED');
      await b.send('GET', '/csrf');
      expect((await b.login(person, PASSWORD)).status).toBe(200);
    });
  });

  describe('cookies', () => {
    const ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Strict';

    it.each([
      ['seguro', () => secure.url, '__Host-', '; Secure'],
      ['HTTP local', () => local.url, '', ''],
    ])('modo %s: atributos exatos, segredo só no cookie e remoção com os mesmos atributos', async (_m, url, prefix, suffix) => {
      const b = new Browser(url());
      const csrf = await b.send('GET', '/csrf');
      expect(csrf.setCookies).toEqual([expect.stringMatching(new RegExp(`^${prefix}finbank_preauth=[\\w-]{43}; ${ATTRIBUTES}${suffix}$`))]);
      const entered = await b.login(await h.customer(), PASSWORD);
      const removed = `; ${ATTRIBUTES}${suffix}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      expect(entered.setCookies).toEqual([
        expect.stringMatching(new RegExp(`^${prefix}finbank_session=[\\w-]{43}; ${ATTRIBUTES}${suffix}$`)),
        `${prefix}finbank_preauth=${removed}`,
      ]);
      const value = b.jar.get(`${prefix}finbank_session`) ?? '';
      expect(entered.text).not.toContain(value);
      expect(entered.text).not.toContain(sha256(value));
      expect((await b.send('POST', '/logout')).setCookies).toEqual([`${prefix}finbank_session=${removed}`, `${prefix}finbank_preauth=${removed}`]);
    });

    it('o cookie de um modo não vale no outro', async () => {
      const b = new Browser(secure.url);
      await b.login(await h.customer(), PASSWORD);
      const value = b.jar.get('__Host-finbank_session') ?? '';
      problem(await call(secure.url, 'GET', '/api/v1/auth/me', { headers: { cookie: `finbank_session=${value}` } }), 401, 'AUTH_SESSION_REQUIRED');
      expect((await call(secure.url, 'GET', '/api/v1/auth/me', { headers: { cookie: `x=1; __Host-finbank_session=${value}; y=2` } })).status).toBe(200);
    });

    it('nome repetido é recusado e valor malformado é ignorado', async () => {
      const b = new Browser(local.url);
      await b.login(await h.customer(), PASSWORD);
      const value = b.jar.get('finbank_session') ?? '';
      for (const cookie of [`finbank_session=${secret()}; finbank_session=${value}`, `finbank_session=${value};finbank_session=`]) {
        problem(await call(local.url, 'GET', '/api/v1/auth/me', { headers: { cookie } }), 400, 'VALIDATION_ERROR');
      }
      for (const cookie of ['finbank_session=x', 'finbank_session', `finbank_session=${value}x`, `finbank_session="${value}"`, '=;;=']) {
        problem(await call(local.url, 'GET', '/api/v1/auth/me', { headers: { cookie } }), 401, 'AUTH_SESSION_REQUIRED');
      }
    });

    it.each(['evil.example', 'localhost.evil.example', '127.0.0.1.evil.example', '10.0.0.1', '127.0.0.1@evil'])(
      'HTTP local recusa Host %s em todas as rotas, antes de qualquer efeito',
      async (host) => {
        for (const path of ['/csrf', '/me']) {
          problem(await call(local.url, 'GET', `/api/v1/auth${path}`, { headers: { host } }), 403, 'ACCESS_DENIED');
        }
        for (const path of POSTS) {
          const reply = await call(local.url, 'POST', `/api/v1/auth${path}`, { headers: { host } });
          problem(reply, 403, 'ACCESS_DENIED');
          expect(reply.setCookies).toEqual([]);
        }
        expect((await call(secure.url, 'GET', '/api/v1/auth/csrf', { headers: { host } })).status).toBe(200);
      },
    );

    it.each(['localhost', 'LOCALHOST:13000', '127.0.0.1:1', '[::1]:8080'])('HTTP local aceita Host %s', async (host) => {
      expect((await call(local.url, 'GET', '/api/v1/auth/csrf', { headers: { host } })).status).toBe(200);
    });

    it('maiúsculas no caminho não contornam Host, erros padronizados nem no-store', async () => {
      const reply = await call(local.url, 'GET', '/API/V1/Auth/me', { headers: { host: 'evil.example' } });
      problem(reply, 403, 'ACCESS_DENIED');
    });
  });

  describe('CSRF e contexto', () => {
    it('todo POST exige o token do próprio contexto, sem efeito e sem contar tentativa', async () => {
      const person = await h.customer();
      const other = new Browser(local.url);
      await other.login(await h.customer(), PASSWORD);
      const bodies: Record<(typeof POSTS)[number], unknown> = {
        '/customer/login': { alias: person.alias, email: person.email, password: OTHER_PASSWORD },
        '/facilitator/login': { email: person.email, password: OTHER_PASSWORD },
        '/logout': undefined,
        '/logout-all': undefined,
        '/password/change': { currentPassword: OTHER_PASSWORD, newPassword: 'mais uma senha longa' },
      };
      const verify = vi.spyOn(Argon2PasswordHasher.prototype, 'verify');
      const logged = new Browser(local.url);
      await logged.login(person, PASSWORD);
      verify.mockClear();
      const good = logged.token;
      const session = logged.jar.get('finbank_session') ?? '';
      try {
        for (const path of POSTS) {
          for (const token of ['', 'x', other.token, sha256(session), session, csrfToken(secret()), `${good}x`]) {
            logged.token = token;
            problem(await logged.send('POST', path, bodies[path]), 403, 'CSRF_VALIDATION_FAILED');
          }
          logged.token = good;
          problem(await logged.send('POST', path, bodies[path], { 'sec-fetch-site': 'cross-site' }), 403, 'CSRF_VALIDATION_FAILED');
        }
        expect(verify).not.toHaveBeenCalled();
      } finally {
        verify.mockRestore();
      }
      expect((await logged.send('GET', '/me')).status).toBe(200);
      expect(await h.activeCount(person.id)).toBe(1);
      for (let i = 0; i < 4; i += 1) {
        problem(await new Browser(local.url).login(person, OTHER_PASSWORD), 401, 'AUTH_INVALID_CREDENTIALS');
      }
      expect((await new Browser(local.url).login(person, PASSWORD)).status).toBe(200);
    });

    it('login sem contexto pré-autenticado é recusado mesmo com token bem formado', async () => {
      const f = await h.facilitator();
      const reply = await call(local.url, 'POST', '/api/v1/auth/facilitator/login', {
        json: { email: f.email, password: PASSWORD },
        headers: { 'x-csrf-token': csrfToken(secret()) },
      });
      problem(reply, 403, 'CSRF_VALIDATION_FAILED');
      expect(await h.activeCount(f.id)).toBe(0);
    });

    it('logout com cookie exige token, mesmo pré-autenticado', async () => {
      const b = new Browser(local.url);
      await b.send('GET', '/csrf');
      b.token = '';
      problem(await b.send('POST', '/logout'), 403, 'CSRF_VALIDATION_FAILED');
      problem(await new Browser(local.url).send('POST', '/logout', undefined, { 'sec-fetch-site': 'cross-site' }), 403, 'CSRF_VALIDATION_FAILED');
    });

    it('same-origin, same-site e ausência do cabeçalho são aceitos', async () => {
      const person = await h.customer();
      for (const site of ['same-origin', 'same-site', 'none']) {
        const b = new Browser(local.url, { 'sec-fetch-site': site });
        expect((await b.login(person, PASSWORD)).status).toBe(200);
      }
    });

    it('login e troca de senha renovam contexto e token; os anteriores deixam de valer', async () => {
      const person = await h.customer();
      const b = new Browser(local.url);
      await b.send('GET', '/csrf');
      const [preauth, preToken] = [b.jar.get('finbank_preauth') ?? '', b.token];
      await b.login(person, PASSWORD);
      const [first, firstToken] = [b.jar.get('finbank_session') ?? '', b.token];
      expect(first).not.toBe(preauth);
      expect(firstToken).not.toBe(preToken);
      expect(b.jar.has('finbank_preauth')).toBe(false);
      // Contexto antigo reenviado junto da sessão: quem manda é a sessão.
      b.jar.set('finbank_preauth', preauth);
      b.token = preToken;
      problem(await b.send('POST', '/logout-all'), 403, 'CSRF_VALIDATION_FAILED');
      b.token = firstToken;
      await b.send('POST', '/password/change', { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD });
      expect(b.jar.get('finbank_session')).not.toBe(first);
      expect(b.token).not.toBe(firstToken);
      b.token = firstToken;
      problem(await b.send('POST', '/logout-all'), 403, 'CSRF_VALIDATION_FAILED');
      problem(await call(local.url, 'GET', '/api/v1/auth/me', { headers: { cookie: `finbank_session=${first}` } }), 401, 'AUTH_SESSION_REQUIRED');
    });

    it('contexto imposto por terceiro não vira sessão', async () => {
      const person = await h.customer();
      const planted = secret();
      const b = new Browser(local.url);
      b.jar.set('finbank_preauth', planted);
      b.jar.set('finbank_session', planted);
      await b.send('GET', '/csrf');
      expect((await b.login(person, PASSWORD)).status).toBe(200);
      expect(b.jar.get('finbank_session')).not.toBe(planted);
      problem(await call(local.url, 'GET', '/api/v1/auth/me', { headers: { cookie: `finbank_session=${planted}` } }), 401, 'AUTH_SESSION_REQUIRED');
    });

    it('novo login encerra só a sessão do próprio contexto, e só se tiver sucesso', async () => {
      const [a, b] = [await h.customer(), await h.customer()];
      const [main, parallel] = [new Browser(local.url), new Browser(local.url)];
      await main.login(a, PASSWORD);
      await parallel.login(a, PASSWORD);
      const old = main.jar.get('finbank_session') ?? '';
      problem(await main.login(b, OTHER_PASSWORD), 401, 'AUTH_INVALID_CREDENTIALS');
      expect((await main.send('GET', '/me')).body).toMatchObject({ identityId: a.id });
      expect((await main.login(b, PASSWORD)).status).toBe(200);
      expect((await main.send('GET', '/me')).body).toMatchObject({ identityId: b.id });
      problem(await call(local.url, 'GET', '/api/v1/auth/me', { headers: { cookie: `finbank_session=${old}` } }), 401, 'AUTH_SESSION_REQUIRED');
      expect((await parallel.send('GET', '/me')).body).toMatchObject({ identityId: a.id });
    });

    it('o token do contexto é estável e não é o hash guardado', async () => {
      const b = new Browser(local.url);
      await b.login(await h.customer(), PASSWORD);
      const token = b.token;
      await b.send('GET', '/csrf');
      expect(b.token).toBe(token);
      const stored = sha256(b.jar.get('finbank_session') ?? '');
      expect([stored, Buffer.from(stored, 'hex').toString('base64url')]).not.toContain(token);
    });
  });

  describe('entradas e erros', () => {
    it('recusas de login são idênticas, salvo correlationId', async () => {
      const c = await h.customer();
      const bare = await h.customer({ password: null });
      const disabled = await h.customer();
      await h.db.client.userIdentity.update({ where: { id: disabled.id }, data: { status: 'DISABLED' } });
      const replies = [
        await new Browser(local.url).login(c, OTHER_PASSWORD),
        await new Browser(local.url).login(bare, PASSWORD),
        await new Browser(local.url).login(disabled, PASSWORD),
        await new Browser(local.url).login({ ...c, email: 'ninguem@example.test' }, PASSWORD),
        await new Browser(local.url).login({ ...c, alias: 'nao-existe' }, PASSWORD),
        await new Browser(local.url).login({ ...c, alias: '../x' }, PASSWORD),
        await new Browser(local.url).login({ ...c, email: 'nao é e-mail' }, PASSWORD),
        await new Browser(local.url).login(c, 'curta'),
      ];
      const normalized = replies.map((r) => {
        problem(r, 401, 'AUTH_INVALID_CREDENTIALS');
        return JSON.stringify([{ ...r.body, correlationId: '' }, r.setCookies, Object.keys(r.headers).sort()]);
      });
      expect(new Set(normalized).size).toBe(1);
    });

    it.each<[string, unknown]>([
      ['campo ausente', { email: 'a@b' }],
      ['campo extra', { email: 'a@b', password: PASSWORD, profile: 'FACILITATOR' }],
      ['tipo errado', { email: 'a@b', password: 123456789012 }],
      ['nulo', { email: null, password: PASSWORD }],
      ['lista', ['a@b', PASSWORD]],
      ['vazio', {}],
      ['protótipo', JSON.parse('{"__proto__":{"email":"a@b"},"password":"x"}')],
    ])('corpo com %s é 400 sem repetir valores', async (_label, body) => {
      const b = new Browser(local.url);
      await b.send('GET', '/csrf');
      const reply = await b.send('POST', '/facilitator/login', body);
      problem(reply, 400, 'VALIDATION_ERROR');
      expect(reply.text).not.toMatch(/a@b|123456789012|profile|__proto__/);
      expect(reply.text).not.toContain(PASSWORD);
    });

    it('JSON inválido, tipo, codificação e tamanho são recusados antes das rotas', async () => {
      const b = new Browser(local.url);
      await b.send('GET', '/csrf');
      const post = (raw: string, headers: Record<string, string>) =>
        call(local.url, 'POST', '/api/v1/auth/facilitator/login', { raw, headers: { cookie: b.cookie, 'x-csrf-token': b.token, ...headers } });
      const json = { 'content-type': 'application/json' };
      for (const raw of ['{', '"texto"', '{"email":', 'null']) {
        problem(await post(raw, json), 400, 'VALIDATION_ERROR');
      }
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'application/json; charset=latin1']) {
        problem(await post('{"email":"a@b","password":"x"}', { 'content-type': type }), 415, 'UNSUPPORTED_MEDIA_TYPE');
      }
      problem(await post('{}', { ...json, 'content-encoding': 'gzip' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
      problem(await post(JSON.stringify({ email: 'a@b', password: 'x'.repeat(11_000) }), json), 413, 'PAYLOAD_TOO_LARGE');
    });

    it('logout e logout-all não aceitam parâmetros', async () => {
      const b = new Browser(local.url);
      await b.login(await h.customer(), PASSWORD);
      problem(await b.send('POST', '/logout-all', { identityId: 'x' }), 400, 'VALIDATION_ERROR');
      problem(await b.send('POST', '/logout', { tudo: 'x' }), 400, 'VALIDATION_ERROR');
      expect((await b.send('POST', '/logout', {})).status).toBe(204);
    });

    it('troca de senha: senha atual errada e política mantêm a sessão', async () => {
      const b = new Browser(local.url);
      await b.login(await h.customer(), PASSWORD);
      const wrong = await b.send('POST', '/password/change', { currentPassword: OTHER_PASSWORD, newPassword: 'mais uma senha longa' });
      problem(wrong, 422, 'AUTH_CURRENT_PASSWORD_INVALID');
      problem(await b.send('POST', '/password/change', { currentPassword: PASSWORD, newPassword: 'curta' }), 422, 'PASSWORD_POLICY_VIOLATION');
      expect((await b.send('GET', '/me')).status).toBe(200);
    });

    it('correlação: devolve o identificador válido e substitui o inválido', async () => {
      const ok = await call(local.url, 'GET', '/api/v1/auth/csrf', { headers: { 'x-correlation-id': 'aula-01.turma_A' } });
      expect(ok.headers['x-correlation-id']).toBe('aula-01.turma_A');
      for (const bad of ['curto', 'a'.repeat(65), 'com espaço aqui', '<script>alert(1)</script>']) {
        const reply = await call(local.url, 'GET', '/api/v1/auth/me', { headers: { 'x-correlation-id': bad } });
        problem(reply, 401, 'AUTH_SESSION_REQUIRED');
        expect(reply.text).not.toContain(bad);
      }
    });

    it('rota inexistente em /api/v1 é Problem Details; fora dela mantém o padrão', async () => {
      problem(await call(local.url, 'GET', '/api/v1/nada'), 404, 'RESOURCE_NOT_FOUND');
      problem(await call(local.url, 'POST', '/api/v1/auth/me'), 404, 'RESOURCE_NOT_FOUND');
      const outside = await fetch(`${local.url}/nada`);
      expect(outside.status).toBe(404);
      expect(outside.headers.get('content-type')).toContain('application/json');
      expect(outside.headers.get('x-powered-by')).toBeNull();
    });

    it('nenhuma rota emite CORS, inclusive em preflight', async () => {
      for (const method of ['GET', 'OPTIONS']) {
        const response = await fetch(`${local.url}/api/v1/auth/csrf`, {
          method,
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        });
        expect([...response.headers.keys()].filter((name) => name.startsWith('access-control'))).toEqual([]);
      }
    });

    it('falha inesperada é 500 sem detalhes e o banco fora é 503', async () => {
      const b = new Browser(local.url);
      await b.login(await h.customer(), PASSWORD);
      const { AuthenticationService } = await import('../../../src/authentication/application/authentication.service.js');
      const spy = vi.spyOn(AuthenticationService.prototype, 'validate');
      try {
        spy.mockRejectedValueOnce(new Error('SELECT segredo FROM tabela em /src/x.ts'));
        const failed = await b.send('GET', '/me');
        problem(failed, 500, 'INTERNAL_ERROR');
        expect(failed.text).not.toMatch(/segredo|SELECT|\/src|stack|Error:/);
        const { AuthenticationError } = await import('../../../src/authentication/domain/errors.js');
        spy.mockRejectedValueOnce(new AuthenticationError('AUTHENTICATION_FAILED', '08006'));
        const down = await b.send('GET', '/me');
        problem(down, 503, 'TEMPORARY_UNAVAILABLE');
        expect(down.text).not.toContain('08006');
      } finally {
        spy.mockRestore();
      }
    });

    it('senha, segredo, token e e-mail não aparecem no console', async () => {
      const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m));
      const out = vi.spyOn(process.stdout, 'write');
      const err = vi.spyOn(process.stderr, 'write');
      try {
        const person = await h.customer();
        const b = new Browser(local.url);
        await b.login(person, OTHER_PASSWORD);
        await b.login(person, PASSWORD);
        const written = JSON.stringify([...spies, out, err].flatMap((s) => s.mock.calls));
        for (const value of [PASSWORD, OTHER_PASSWORD, person.email, b.token, ...b.jar.values()]) {
          expect(written).not.toContain(value);
        }
      } finally {
        [...spies, out, err].forEach((s) => s.mockRestore());
      }
    });
  });

  describe('contrato OpenAPI', () => {
    it('descreve exatamente as rotas registradas em /api/v1', () => {
      interface Layer {
        route?: { path: string; methods: Record<string, boolean> };
      }
      const instance = local.app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } };
      const registered = instance.router.stack.flatMap((layer) =>
        layer.route === undefined ? [] : Object.keys(layer.route.methods).map((m) => `${m} ${layer.route?.path}`),
      );
      const documented = Object.entries(OPENAPI_DOCUMENT.paths).flatMap(([path, item]) => Object.keys(item).map((m) => `${m} ${path}`));
      expect(documented.length).toBe(15);
      expect(registered.filter((r) => r.includes('/api/')).map((r) => r.replace(/:(\w+)/g, '{$1}')).sort()).toEqual(documented.sort());
    });

    it('a conferência de schemas está ativa, inclusive em Problem Details', async () => {
      const request = spec().get(`${local.url}/api/v1/auth/me`);
      await request.toss();
      const quiet = (['log', 'error', 'warn'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      try {
        request.response().to.have.jsonSchema({ type: 'object', required: ['code'] });
        expect(() => request.response().to.have.jsonSchema({ type: 'object', required: ['campo-inexistente'] })).toThrow();
      } finally {
        quiet.forEach((q) => q.mockRestore());
      }
    });

    it('é servido como está', async () => {
      const reply = await call(local.url, 'GET', '/api/v1/openapi.json');
      expect(reply.body).toEqual(JSON.parse(JSON.stringify(OPENAPI_DOCUMENT)));
    });

    it('toda referência interna existe', () => {
      for (const [, ref = ''] of JSON.stringify(OPENAPI_DOCUMENT).matchAll(/"\$ref":"#\/([^"]+)"/g)) {
        const target = ref.split('/').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], OPENAPI_DOCUMENT);
        expect(target, ref).toBeDefined();
      }
    });
  });
});
