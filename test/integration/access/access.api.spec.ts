// Autorização por operação e isolamento nas rotas: PactumJS e PostgreSQL real, com dois workspaces.
import { randomUUID } from 'node:crypto';
import { Controller, Get, Post } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentWorkspace } from '../../../src/access/http/operation-context.js';
import { ACCESS_POLICY, type AccessPolicy, FacilitatorAccess, FacilitatorWorkspaceAccess } from '../../../src/http/access-policy.js';
import { OPENAPI_DOCUMENT } from '../../../src/http/openapi.js';
import { PrismaFacilitatorWorkspacesReader } from '../../../src/identity/adapters/prisma-facilitator-workspaces.reader.js';
import { PrismaWorkspaceAccessReader } from '../../../src/identity/adapters/prisma-workspace-access.reader.js';
import { IdentityError } from '../../../src/identity/domain/errors.js';
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { Browser, call, contractPath, type Method, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, OTHER_PASSWORD, PASSWORD, type Person } from '../authentication/support.js';

let writes = 0;

@Controller('api/v1/probe')
class ProbeController {
  @Get('undeclared')
  undeclared(): object {
    return {};
  }

  @Post(':workspaceId')
  @FacilitatorWorkspaceAccess()
  write(@CurrentWorkspace() access: WorkspaceAccess): object {
    writes += 1;
    return { workspaceId: access.workspaceId };
  }

  /** Escopo exigido sem o parâmetro no caminho. */
  @Get('no-param')
  @FacilitatorWorkspaceAccess()
  noParam(): object {
    return {};
  }

  /** Pede o workspace sem tê-lo exigido. */
  @Get('no-scope')
  @FacilitatorAccess()
  noScope(@CurrentWorkspace() access: WorkspaceAccess): object {
    return access;
  }
}

const LIST = '/facilitator/workspaces';
/** Workspace de teste: ISOLATED, ativo, sem código de inscrição. */
const ISOLATED_SUMMARY = { modality: 'ISOLATED', status: 'ACTIVE', enrollment: { active: false, revision: 0, required: false } };
const one = (id: string | null): string => `${LIST}/${id}`;

describe('autorização por operação (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let probe: { app: NestExpressApplication; url: string };
  let secure: { app: NestExpressApplication; url: string };
  // a e b: clientes (um por workspace); fa: facilitador de A; fab: de A e B.
  let a: Person, b: Person, fa: Person, fab: Person;

  const link = (workspaceId: string | null, identityId: string, status: 'ACTIVE' | 'REVOKED' = 'ACTIVE') =>
    h.db.client.workspaceMembership.create({ data: { workspaceId: workspaceId ?? '', identityId, role: 'FACILITATOR', status } });
  const setLink = (workspaceId: string | null, identityId: string, status: 'ACTIVE' | 'REVOKED') =>
    h.db.client.workspaceMembership.updateMany({ where: { workspaceId: workspaceId ?? '', identityId }, data: { status } });

  async function enter(person: Person, url = server.url): Promise<Browser> {
    const browser = new Browser(url);
    expect((await browser.login(person, PASSWORD)).status).toBe(200);
    return browser;
  }

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
    expect(reply.headers['content-type']).toContain('application/problem+json');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body['correlationId']).toBe(reply.headers['x-correlation-id']);
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    probe = await startApp({ COOKIE_TRANSPORT: 'local-http' }, [ProbeController]);
    secure = await startApp();
  });

  beforeEach(async () => {
    writes = 0;
    [a, b, fa, fab] = [await h.customer(), await h.customer(), await h.facilitator(), await h.facilitator()];
    await link(a.workspaceId, fa.id);
    await link(a.workspaceId, fab.id);
    await link(b.workspaceId, fab.id);
  });

  afterAll(async () => {
    await server?.app.close();
    await probe?.app.close();
    await secure?.app.close();
    await h?.close();
  });

  describe('política declarada', () => {
    it('todas as rotas da aplicação têm política, e todo workspace no caminho é conferido', () => {
      const discovery = new DiscoveryService(server.app.get(ModulesContainer));
      const scanner = new MetadataScanner();
      const routes = discovery.getControllers().flatMap(({ instance, metatype }) =>
        scanner.getAllMethodNames(Object.getPrototypeOf(instance) as object).flatMap((name) => {
          const handler = (instance as Record<string, object>)[name] ?? {};
          const path = Reflect.getMetadata('path', handler) as string | undefined;
          if (path === undefined) {
            return [];
          }
          const base = Reflect.getMetadata('path', metatype as object) as string;
          const policy = (Reflect.getMetadata(ACCESS_POLICY, handler) ?? Reflect.getMetadata(ACCESS_POLICY, metatype as object)) as
            | AccessPolicy
            | undefined;
          return [{ path: `${base}/${path}`, policy }];
        }),
      );
      expect(routes).toHaveLength(33);
      for (const { path, policy } of routes) {
        expect(policy, path).toBeDefined();
        expect(policy?.kind === 'PROFILE' && policy.workspace, path).toBe(path.includes(':workspaceId'));
      }
      const open = routes.filter((r) => r.policy?.kind === 'PUBLIC').map((r) => r.path).sort();
      expect(open).toEqual(['api/v1/openapi.json', 'health/live', 'health/ready']);
      // Pré-autenticação: rotas de autenticação e a submissão do onboarding, que não abre sessão.
      expect(routes.filter((r) => r.policy?.kind === 'AUTHENTICATION').every((r) => r.path.startsWith('api/v1/auth/') || r.path.startsWith('api/v1/onboarding/requests'))).toBe(true);
    });

    it('rota sem política é negada até com sessão válida', async () => {
      const browser = await enter(fab, probe.url);
      problem(await browser.api('GET', '/probe/undeclared'), 403, 'ACCESS_DENIED');
      problem(await call(probe.url, 'GET', '/api/v1/probe/undeclared'), 403, 'ACCESS_DENIED');
    });

    it('escopo mal montado nega', async () => {
      const browser = await enter(fab, probe.url);
      problem(await browser.api('GET', '/probe/no-param'), 404, 'RESOURCE_NOT_FOUND');
      problem(await browser.api('GET', '/probe/no-scope'), 403, 'ACCESS_DENIED');
    });
  });

  describe('sessão e perfil', () => {
    it('sem sessão é 401, exista ou não o workspace', async () => {
      for (const path of [LIST, one(a.workspaceId), one(randomUUID()), one('x')]) {
        problem(await call(server.url, 'GET', `/api/v1${path}`), 401, 'AUTH_SESSION_REQUIRED');
      }
    });

    it('sessão encerrada e expirada são distinguidas', async () => {
      const browser = await enter(fa);
      const cookie = browser.cookie;
      await browser.send('POST', '/logout');
      problem(await call(server.url, 'GET', `/api/v1${one(a.workspaceId)}`, { headers: { cookie } }), 401, 'AUTH_SESSION_REQUIRED');
      const expired = await enter(fa);
      await h.db.client.$executeRaw`
        UPDATE "user_session" SET "idle_expires_at" = clock_timestamp()
         WHERE "identity_id" = ${fa.id}::uuid AND "revoked_at" IS NULL`;
      problem(await expired.api('GET', LIST), 401, 'AUTH_SESSION_EXPIRED');
    });

    it('cliente é recusado com 403 sem consulta ao workspace, inclusive o próprio', async () => {
      const browser = await enter(a);
      const spies = [
        vi.spyOn(PrismaWorkspaceAccessReader.prototype, 'findActiveRole'),
        vi.spyOn(PrismaFacilitatorWorkspacesReader.prototype, 'list'),
        vi.spyOn(PrismaFacilitatorWorkspacesReader.prototype, 'find'),
      ];
      try {
        for (const path of [LIST, one(a.workspaceId), one(b.workspaceId), one(randomUUID()), one('x')]) {
          problem(await browser.api('GET', path), 403, 'ACCESS_DENIED');
        }
        spies.forEach((s) => expect(s).not.toHaveBeenCalled());
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });

  describe('workspace', () => {
    it('inexistente, sem vínculo, revogado e malformado são o mesmo 404', async () => {
      await setLink(a.workspaceId, fab.id, 'REVOKED');
      const c = await h.customer();
      const browser = await enter(fab);
      const spy = vi.spyOn(PrismaWorkspaceAccessReader.prototype, 'findActiveRole');
      try {
        const seen: unknown[] = [];
        const malformed = ['x', '1', (b.workspaceId ?? '').toUpperCase(), `${b.workspaceId}%20`, "'%20OR%201=1--", '%00', 'null'];
        for (const id of [randomUUID(), c.workspaceId, a.workspaceId, ...malformed]) {
          const reply = await browser.api('GET', one(id));
          problem(reply, 404, 'RESOURCE_NOT_FOUND');
          const { correlationId, ...body } = reply.body;
          // O ETag deriva do corpo, que contém o correlationId.
          const { date, etag, 'x-correlation-id': header, ...headers } = reply.headers;
          expect([correlationId, date, etag, header].every((v) => typeof v === 'string')).toBe(true);
          expect(reply.setCookies).toEqual([]);
          seen.push({ body, headers });
        }
        for (const other of seen) {
          expect(other).toEqual(seen[0]);
        }
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
    });

    it('com vínculo ativo devolve exatamente o workspace', async () => {
      const reply = await (await enter(fab)).api('GET', one(b.workspaceId));
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ workspaceId: b.workspaceId, alias: b.alias, ...ISOLATED_SUMMARY });
    });

    it('vínculo revogado e reativado valem na requisição seguinte, sem novo login nem efeito nos outros', async () => {
      const browser = await enter(fab);
      expect((await browser.api('GET', one(a.workspaceId))).status).toBe(200);
      await setLink(a.workspaceId, fab.id, 'REVOKED');
      problem(await browser.api('GET', one(a.workspaceId)), 404, 'RESOURCE_NOT_FOUND');
      expect((await browser.api('GET', one(b.workspaceId))).status).toBe(200);
      expect((await (await enter(fa)).api('GET', one(a.workspaceId))).status).toBe(200);
      await setLink(a.workspaceId, fab.id, 'ACTIVE');
      expect((await browser.api('GET', one(a.workspaceId))).status).toBe(200);
    });

    it('a guarda sozinha recusa vínculo revogado, sem a conferência da consulta', async () => {
      const browser = await enter(fa, probe.url);
      expect((await browser.api('POST', `/probe/${a.workspaceId}`)).status).toBe(201);
      await setLink(a.workspaceId, fa.id, 'REVOKED');
      problem(await browser.api('POST', `/probe/${a.workspaceId}`), 404, 'RESOURCE_NOT_FOUND');
      expect(writes).toBe(1);
    });

    it('revogação entre a guarda e a leitura não devolve dados', async () => {
      const browser = await enter(fa);
      const original = Reflect.get(PrismaWorkspaceAccessReader.prototype, 'findActiveRole');
      const spy = vi.spyOn(PrismaWorkspaceAccessReader.prototype, 'findActiveRole').mockImplementationOnce(async function (
        this: PrismaWorkspaceAccessReader, identityId, workspaceId,
      ) {
        const role = await original.call(this, identityId, workspaceId);
        await setLink(a.workspaceId, fa.id, 'REVOKED');
        return role;
      });
      try {
        problem(await browser.api('GET', one(a.workspaceId)), 404, 'RESOURCE_NOT_FOUND');
      } finally {
        spy.mockRestore();
      }
    });

    it('identidade desativada e sessão encerrada em outro contexto perdem o acesso', async () => {
      const [first, second] = [await enter(fab), await enter(fab)];
      await first.send('POST', '/logout-all');
      problem(await second.api('GET', one(b.workspaceId)), 401, 'AUTH_SESSION_REQUIRED');
      const third = await enter(fab);
      await h.db.client.userIdentity.update({ where: { id: fab.id }, data: { status: 'DISABLED' } });
      problem(await third.api('GET', one(b.workspaceId)), 401, 'AUTH_SESSION_REQUIRED');
      await h.db.client.userIdentity.update({ where: { id: fab.id }, data: { status: 'ACTIVE' } });
      problem(await third.api('GET', LIST), 401, 'AUTH_SESSION_REQUIRED');
    });
  });

  describe('listagem', () => {
    const ids = (reply: Reply) => (reply.body['items'] as { workspaceId: string }[]).map((i) => i.workspaceId);

    it('só vínculos ativos do próprio facilitador; sem vínculo, vazia', async () => {
      expect(ids(await (await enter(fa)).api('GET', LIST))).toEqual([a.workspaceId]);
      const browser = await enter(fab);
      expect((await browser.api('GET', LIST)).body).toEqual({
        items: [{ workspaceId: a.workspaceId, alias: a.alias, ...ISOLATED_SUMMARY }, { workspaceId: b.workspaceId, alias: b.alias, ...ISOLATED_SUMMARY }], nextOffset: null,
      });
      await setLink(a.workspaceId, fab.id, 'REVOKED');
      expect(ids(await browser.api('GET', LIST))).toEqual([b.workspaceId]);
      expect((await (await enter(await h.facilitator())).api('GET', LIST)).body).toEqual({ items: [], nextOffset: null });
    });

    it('pagina em ordem estável, com desempate por identificador e padrão de 20', async () => {
      const person = await h.facilitator();
      const createdAt = new Date('2026-01-01T00:00:00Z');
      const made: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        const { id } = await h.db.client.workspace.create({ data: { createdAt }, select: { id: true } });
        await link(id, person.id);
        made.push(id);
      }
      made.sort();
      const browser = await enter(person);
      const first = await browser.api('GET', LIST);
      expect(ids(first)).toEqual(made.slice(0, 20));
      expect(first.body['nextOffset']).toBe(20);
      expect((first.body['items'] as { alias: unknown }[])[0]?.alias).toBeNull();
      const second = await browser.api('GET', `${LIST}?offset=20`);
      expect(ids(second)).toEqual(made.slice(20));
      expect(second.body['nextOffset']).toBeNull();
      const exact = await browser.api('GET', `${LIST}?limit=5&offset=20`);
      expect([ids(exact).length, exact.body['nextOffset']]).toEqual([5, null]);
      expect((await browser.api('GET', `${LIST}?limit=100`)).body['nextOffset']).toBeNull();
      expect((await browser.api('GET', `${LIST}?offset=999999`)).body).toEqual({ items: [], nextOffset: null });
    });

    it.each(['limit=0', 'limit=101', 'limit=', 'limit=1&limit=2', 'limit[]=1', 'offset=-1', 'x=1', 'identityId=1', '__proto__=1'])(
      'recusa ?%s',
      async (query) => {
        problem(await (await enter(fa)).api('GET', `${LIST}?${query}`), 400, 'VALIDATION_ERROR');
      },
    );
  });

  describe('teste cruzado', () => {
    type Actor = 'a' | 'b' | 'fa' | 'fab';
    /** Resultado esperado por rota com workspace: [workspace A, workspace B]. Rota nova precisa entrar aqui. */
    const MATRIX: Record<string, Record<Actor, readonly [number, number]>> = {
      'get /api/v1/facilitator/workspaces/{workspaceId}': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'get /api/v1/facilitator/workspaces/{workspaceId}/customers': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/enable': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/disable': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/password-reset': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'get /api/v1/facilitator/workspaces/{workspaceId}/flags': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'patch /api/v1/facilitator/workspaces/{workspaceId}/flags': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/enrollment-code': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'delete /api/v1/facilitator/workspaces/{workspaceId}/enrollment-code': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'get /api/v1/facilitator/workspaces/{workspaceId}/clock': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'patch /api/v1/facilitator/workspaces/{workspaceId}/clock': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'get /api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/account': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/account/block': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/account/unblock': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'get /api/v1/facilitator/workspaces/{workspaceId}/onboarding-policy': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'patch /api/v1/facilitator/workspaces/{workspaceId}/onboarding-policy': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'get /api/v1/facilitator/workspaces/{workspaceId}/onboarding-requests': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/onboarding-requests/{requestId}/approve': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
      'post /api/v1/facilitator/workspaces/{workspaceId}/onboarding-requests/{requestId}/reject': { a: [403, 403], b: [403, 403], fa: [200, 404], fab: [200, 200] },
    };
    /** Conta do cliente preparada pelo dono, para as rotas de conta (clientes de teste nascem sem conta). */
    async function ensureAccount(target: Person): Promise<void> {
      if ((await h.db.client.customerAccount.count({ where: { identityId: target.id } })) > 0) {
        return;
      }
      const account = await h.db.client.account.create({ data: { workspaceId: target.workspaceId ?? '', kind: 'STANDARD' } });
      await h.db.client.customerAccount.create({ data: { identityId: target.id, workspaceId: target.workspaceId ?? '', accountId: account.id } });
    }
    /** Uma solicitação PENDING por rota e workspace, preparada pelo dono, para as rotas de solicitação. */
    const pending = new Map<string, string>();
    async function pendingFor(route: string, workspaceId: string): Promise<string> {
      const key = `${route}|${workspaceId}`;
      const known = pending.get(key);
      if (known !== undefined) {
        return known;
      }
      const cpf = String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
      const row = await h.db.client.onboardingRequest.create({
        data: {
          workspaceId, status: 'PENDING', name: 'Pessoa Fictícia', cpf, birthDate: new Date('1990-01-01'), email: `p-${randomUUID()}@example.test`,
          phone: '11987654321', passwordHash: `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
          businessDate: new Date('2026-01-01'), clockRevision: 0,
        },
        select: { id: true },
      });
      pending.set(key, row.id);
      return row.id;
    }
    const scoped = Object.entries(OPENAPI_DOCUMENT.paths).flatMap(([path, item]) =>
      path.includes('{workspaceId}') ? Object.keys(item).map((m) => `${m} ${path}`) : [],
    );

    it('toda rota com workspace no caminho está na matriz', () => {
      expect(scoped.sort()).toEqual(Object.keys(MATRIX).sort());
    });

    it.each(Object.entries(MATRIX))('%s', async (route, expected) => {
      const [method = '', path = ''] = route.split(' ');
      const people = { a, b, fa, fab };
      for (const actor of Object.keys(people) as Actor[]) {
        const browser = await enter(people[actor]);
        for (const [i, target] of [a, b].entries()) {
          const requestId = path.includes('onboarding-requests') ? await pendingFor(route, target.workspaceId ?? '') : '';
          if (path.includes('/account')) {
            await ensureAccount(target);
          }
          const url = path
            .replace('/api/v1', '')
            .replace('{workspaceId}', target.workspaceId ?? '')
            .replace('{customerId}', target.id)
            .replace('{requestId}', requestId);
          const seen = method === 'patch' ? await browser.api('GET', url) : undefined;
          const base = typeof seen?.body['revision'] === 'number' ? seen.body['revision'] : 0;
          const change = path.includes('clock')
            ? { date: `2030-0${i + 1}-15` }
            : path.includes('onboarding-policy')
              ? { mode: 'MANUAL' }
              : { configuration: { mode: 'STUDENT', preset: { kind: 'NONE' } } };
          const body = method === 'patch' ? { baseRevision: base, ...change } : /account\/(block|unblock)$/.test(path) ? { justification: 'Exercício de bloqueio da turma' } : undefined;
          const reply = await browser.api(method.toUpperCase() as Method, url, body);
          expect(reply.status, `${actor} em ${i === 0 ? 'A' : 'B'}`).toBe(expected[actor][i]);
          const own = reply.status === 200;
          const marks = path.includes('customers')
            ? [target.id]
            : path.includes('onboarding-requests')
              ? [requestId]
              : /flags|clock|enrollment|onboarding-policy/.test(path)
                ? [target.workspaceId ?? '-']
                : [target.workspaceId ?? '-', target.alias ?? '-'];
          for (const mark of marks) {
            expect(reply.text.includes(mark)).toBe(own);
          }
          if (!own) {
            expect(reply.text).not.toContain(target.email);
          }
        }
      }
    });

    it('workspace e perfil forjados em cabeçalho, query, corpo ou cookie não mudam a decisão', async () => {
      const browser = await enter(fa);
      const forged = {
        'x-workspace-id': a.workspaceId ?? '', 'x-identity-id': fab.id, 'x-profile': 'FACILITATOR', 'x-original-url': one(a.workspaceId),
        cookie: `${browser.cookie}; workspaceId=${a.workspaceId}; profile=FACILITATOR`,
      };
      problem(await browser.api('GET', `${one(b.workspaceId)}?workspaceId=${a.workspaceId}&identityId=${fab.id}`, undefined, forged), 404, 'RESOURCE_NOT_FOUND');
      const allowed = await browser.api('GET', `${one(a.workspaceId)}?workspaceId=${b.workspaceId}`, undefined, { 'x-workspace-id': b.workspaceId ?? '' });
      expect(allowed.body['workspaceId']).toBe(a.workspaceId);
      const customer = await enter(a);
      problem(await customer.api('GET', LIST, undefined, { 'x-profile': 'FACILITATOR', cookie: `${customer.cookie}; profile=FACILITATOR` }), 403, 'ACCESS_DENIED');
      const writer = await enter(fa, probe.url);
      problem(await writer.api('POST', `/probe/${b.workspaceId}`, { workspaceId: a.workspaceId, profile: 'FACILITATOR' }), 404, 'RESOURCE_NOT_FOUND');
      expect(writes).toBe(0);
    });
  });

  describe('transporte e CSRF', () => {
    it.each(['evil.example', 'localhost.evil.example'])('HTTP local recusa Host %s antes da sessão', async (host) => {
      const browser = await enter(fa);
      for (const path of [LIST, one(a.workspaceId)]) {
        problem(await browser.api('GET', path, undefined, { host }), 403, 'ACCESS_DENIED');
      }
      problem(await call(server.url, 'GET', `/API/V1${LIST}`, { headers: { host } }), 403, 'ACCESS_DENIED');
    });

    it('modo seguro só aceita o próprio cookie; nome repetido é 400', async () => {
      const login = await h.login(fa);
      const path = `/api/v1${one(a.workspaceId)}`;
      const ok = await call(secure.url, 'GET', path, { headers: { cookie: `__Host-finbank_session=${login.secret}` } });
      expect(ok.status).toBe(200);
      problem(await call(secure.url, 'GET', path, { headers: { cookie: `finbank_session=${login.secret}` } }), 401, 'AUTH_SESSION_REQUIRED');
      const cookie = `finbank_session=${login.secret}; finbank_session=${login.secret}`;
      problem(await call(server.url, 'GET', path, { headers: { cookie } }), 400, 'VALIDATION_ERROR');
    });

    it('sem CORS, e HEAD segue a mesma autorização', async () => {
      const browser = await enter(fa);
      for (const [id, status] of [[a.workspaceId, 200], [b.workspaceId, 404]] as const) {
        const response = await fetch(`${server.url}/api/v1${one(id)}`, {
          method: 'HEAD', headers: { cookie: browser.cookie, origin: 'https://evil.example' },
        });
        expect(response.status).toBe(status);
        expect([...response.headers.keys()].filter((n) => n.startsWith('access-control'))).toEqual([]);
      }
    });

    it('escrita exige CSRF do contexto, conferido antes do workspace', async () => {
      const browser = await enter(fa, probe.url);
      const other = await enter(fab, probe.url);
      const spy = vi.spyOn(PrismaWorkspaceAccessReader.prototype, 'findActiveRole');
      try {
        for (const id of [a.workspaceId, b.workspaceId, randomUUID(), 'x']) {
          for (const headers of [
            { 'x-csrf-token': '' }, { 'x-csrf-token': other.token }, { 'x-csrf-token': 'A'.repeat(43) }, { 'sec-fetch-site': 'cross-site' },
          ] as Record<string, string>[]) {
            problem(await browser.api('POST', `/probe/${id}`, undefined, headers), 403, 'CSRF_VALIDATION_FAILED');
          }
        }
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(writes).toBe(0);
      problem(await browser.api('POST', `/probe/${b.workspaceId}`), 404, 'RESOURCE_NOT_FOUND');
      expect((await browser.api('POST', `/probe/${a.workspaceId}`)).body).toEqual({ workspaceId: a.workspaceId });
      expect(writes).toBe(1);
    });
  });

  describe('falhas', () => {
    it('banco inacessível nos adaptadores é falha tipada e sanitizada', async () => {
      const down = new PrismaService({ databaseUrl: 'postgresql://usuario:segredo@127.0.0.1:1/banco' });
      try {
        const reader = new PrismaFacilitatorWorkspacesReader(down.client);
        for (const query of [() => reader.list(randomUUID(), { limit: 1, offset: 0 }), () => reader.find(randomUUID(), randomUUID())]) {
          const error = (await query().catch((e: unknown) => e)) as IdentityError;
          expect(error).toBeInstanceOf(IdentityError);
          expect(error.code).toBe('ACCESS_CHECK_FAILED');
          expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
        }
      } finally {
        await down.onModuleDestroy();
      }
    });

    it('falha de verificação é 503 e inesperada é 500, sem detalhes nem acesso', async () => {
      const browser = await enter(fa);
      const path = one(a.workspaceId);
      const cases = [
        [new IdentityError('ACCESS_CHECK_FAILED', '08006'), 503, 'TEMPORARY_UNAVAILABLE'],
        [new Error(`SELECT segredo ${a.workspaceId} em /src/x.ts`), 500, 'INTERNAL_ERROR'],
      ] as const;
      for (const [error, status, code] of cases) {
        for (const [proto, method, url] of [
          [PrismaWorkspaceAccessReader.prototype, 'findActiveRole', path],
          [PrismaFacilitatorWorkspacesReader.prototype, 'find', path],
          [PrismaFacilitatorWorkspacesReader.prototype, 'list', LIST],
        ] as const) {
          const spy = vi.spyOn(proto as unknown as Record<string, () => Promise<never>>, method).mockRejectedValueOnce(error);
          try {
            const reply = await browser.api('GET', url);
            problem(reply, status, code);
            expect(reply.text).not.toMatch(/segredo|SELECT|\/src|08006/);
            expect(reply.text).not.toContain(a.workspaceId);
          } finally {
            spy.mockRestore();
          }
        }
      }
    });

    it('identificadores, e-mail e segredos não aparecem no console', async () => {
      const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m));
      const out = vi.spyOn(process.stdout, 'write');
      const err = vi.spyOn(process.stderr, 'write');
      try {
        const browser = await enter(fa);
        await browser.api('GET', one(b.workspaceId));
        await browser.api('GET', LIST);
        await browser.login(fa, OTHER_PASSWORD);
        const written = JSON.stringify([...spies, out, err].flatMap((s) => s.mock.calls));
        for (const value of [fa.id, fa.email, b.workspaceId ?? '-', browser.token, ...browser.jar.values()]) {
          expect(written).not.toContain(value);
        }
      } finally {
        [...spies, out, err].forEach((s) => s.mockRestore());
      }
    });
  });

  it('caminho com parâmetro é conferido contra o contrato', () => {
    expect(contractPath(`/api/v1${one(randomUUID())}`)).toBe('/api/v1/facilitator/workspaces/{workspaceId}');
    expect(contractPath(`/api/v1${LIST}?limit=1`)).toBe('/api/v1/facilitator/workspaces');
    expect(contractPath('/api/v1/probe/x')).toBeUndefined();
  });
});
