// Verificação do contrato da interface web: API real, PostgreSQL real e sessões reais.
// Cookie e token são segredos de execução: o filtro troca os exemplos do pacto pelos do contexto preparado.
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Verifier } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { Argon2PasswordHasher } from '../../src/authentication/adapters/argon2-password-hasher.js';
import { AuthenticationService } from '../../src/authentication/application/authentication.service.js';
import { AuthenticationError } from '../../src/authentication/domain/errors.js';
import { csrfToken } from '../../src/authentication/http/csrf.js';
import { RandomSessionSecrets } from '../../src/authentication/adapters/random-session-secrets.js';
import { issueTemporaryCredential } from '../../src/administration/adapters/temporary-credential-sql.js';
import { startApp } from '../integration/authentication/http-support.js';
import { type AuthHarness, authHarness } from '../integration/authentication/support.js';

// Identificadores e dados combinados com o consumidor.
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const FACILITATOR = '33333333-3333-4333-8333-333333333333';
const ALIAS = 'turma-contrato';
const PASSWORD = 'senha de contrato longa';
const WRONG_TOKEN = 'X'.repeat(43);
const customer = { alias: ALIAS, email: 'cliente@contrato.test' };
const facilitator = { alias: null, email: 'facilitador@contrato.test' };

interface ProxiedRequest {
  readonly method: string;
  readonly headers: Record<string, string | undefined>;
}

describe('contrato finbank-v2-web → finbank-v2-api', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let hash: string;
  let context: { cookie: string | null; secret: string };

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    hash = await new Argon2PasswordHasher().hash(PASSWORD);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await server?.app.close();
    await h?.close();
  });

  /** Mesmos registros a cada interação, devolvidos ao estado inicial (auditoria e vínculos não são apagados). */
  async function reset(): Promise<void> {
    vi.restoreAllMocks();
    const db = h.db.client;
    await db.workspace.upsert({ where: { id: WORKSPACE }, create: { id: WORKSPACE, alias: ALIAS }, update: {} });
    const people = [
      { id: CUSTOMER, profile: 'CUSTOMER' as const, email: customer.email, workspaceId: WORKSPACE },
      { id: FACILITATOR, profile: 'FACILITATOR' as const, email: facilitator.email, workspaceId: null },
    ];
    for (const person of people) {
      await db.userIdentity.upsert({ where: { id: person.id }, create: { ...person, status: 'ACTIVE' }, update: { status: 'ACTIVE' } });
      await db.passwordCredential.upsert({ where: { identityId: person.id }, create: { identityId: person.id, hash }, update: { hash, invalidatedAt: null } });
      await db.userSession.updateMany({ where: { identityId: person.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await db.temporaryCredential.updateMany({ where: { identityId: person.id, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await db.workspaceMembership.updateMany({ where: { identityId: FACILITATOR }, data: { status: 'REVOKED' } });
    await link(WORKSPACE);
    await db.authenticationControl.deleteMany();
    // Contexto pré-autenticado, para login.
    const secret = new RandomSessionSecrets().generate();
    context = { cookie: `finbank_preauth=${secret}`, secret };
  }

  async function link(workspaceId: string): Promise<void> {
    const key = { workspaceId_identityId: { workspaceId, identityId: FACILITATOR } };
    const create = { workspaceId, identityId: FACILITATOR, role: 'FACILITATOR' as const, status: 'ACTIVE' as const };
    await h.db.client.workspaceMembership.upsert({ where: key, create, update: { status: 'ACTIVE' } });
  }

  async function enter(person: typeof customer | typeof facilitator, password = PASSWORD): Promise<string> {
    const { secret, session } = await h.login({ id: '', workspaceId: null, ...person }, password);
    context = { cookie: `finbank_session=${secret}`, secret };
    return session.sessionId;
  }

  async function issue(identityId: string): Promise<void> {
    await h.db.client.$transaction((tx) => issueTemporaryCredential(tx, identityId, hash, 1));
  }

  const state = (prepare: () => Promise<unknown>) => async () => {
    await reset();
    await prepare();
  };

  const STATES: Record<string, () => Promise<void>> = {
    'sem sessão': state(() => Promise.resolve((context = { cookie: null, secret: '' }))),
    'cliente com senha': state(() => Promise.resolve()),
    'facilitador com senha': state(() => Promise.resolve()),
    'cliente com outra senha': state(async () =>
      h.db.client.passwordCredential.update({ where: { identityId: CUSTOMER }, data: { hash: await new Argon2PasswordHasher().hash('senha diferente longa') } }),
    ),
    'cliente com login restrito': state(async () => {
      for (let i = 0; i < 5; i += 1) {
        const secret = new RandomSessionSecrets().generate();
        const response = await fetch(`${server.url}/api/v1/auth/customer/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `finbank_preauth=${secret}`, 'x-csrf-token': csrfToken(secret) },
          body: JSON.stringify({ ...customer, password: 'senha errada longa' }),
        });
        expect(response.status).toBe(401);
      }
    }),
    'cliente cuja credencial temporária é a senha informada': state(() => issue(CUSTOMER)),
    'sessão de cliente': state(() => enter(customer)),
    'sessão de facilitador': state(() => enter(facilitator)),
    'sessão restrita de cliente': state(async () => {
      await issue(CUSTOMER);
      await enter(customer);
    }),
    'sessão restrita de facilitador': state(async () => {
      await issue(FACILITATOR);
      await enter(facilitator);
    }),
    'sessão expirada de cliente': state(async () => {
      const id = await enter(customer);
      await h.db.client.$executeRaw`UPDATE "user_session" SET "idle_expires_at" = clock_timestamp() WHERE "id" = ${id}::uuid`;
    }),
    'sessão de cliente com banco indisponível': state(async () => {
      await enter(customer);
      vi.spyOn(AuthenticationService.prototype, 'validate').mockRejectedValueOnce(new AuthenticationError('AUTHENTICATION_FAILED', '08006'));
    }),
    'sessão de facilitador com muitos workspaces': state(async () => {
      await h.db.client.workspaceMembership.updateMany({ where: { identityId: FACILITATOR }, data: { status: 'REVOKED' } });
      for (let i = 0; i < 21; i += 1) {
        await link((await h.db.client.workspace.create({ data: {}, select: { id: true } })).id);
      }
      await enter(facilitator);
    }),
    'sessão de facilitador sem vínculo': state(async () => {
      await h.db.client.workspaceMembership.updateMany({ where: { identityId: FACILITATOR }, data: { status: 'REVOKED' } });
      await enter(facilitator);
    }),
    'sessão de facilitador com cliente desativado': state(async () => {
      await h.db.client.userIdentity.update({ where: { id: CUSTOMER }, data: { status: 'DISABLED' } });
      await enter(facilitator);
    }),
  };

  it('a API cumpre o que a interface espera', async () => {
    const verifier = new Verifier({
      provider: 'finbank-v2-api',
      providerBaseUrl: server.url,
      pactUrls: [resolve('test/contract/pacts/finbank-v2-web-finbank-v2-api.json')],
      logLevel: 'error',
      stateHandlers: Object.fromEntries(Object.entries(STATES).map(([name, prepare]) => [name, async () => void (await prepare())])),
      requestFilter: (request: ProxiedRequest, _response: unknown, next: () => void) => {
        // Escrita sem corpo: o navegador envia tamanho zero; o proxy do Pact, transferência em blocos.
        if (request.headers['content-type'] === undefined) {
          delete request.headers['transfer-encoding'];
          if (request.method === 'POST') {
            request.headers['content-length'] = '0';
          }
        }
        if (request.headers.cookie !== undefined && context.cookie !== null) {
          request.headers.cookie = context.cookie;
        }
        if (request.headers['x-csrf-token'] !== undefined && request.headers['x-csrf-token'] !== WRONG_TOKEN) {
          request.headers['x-csrf-token'] = csrfToken(context.secret);
        }
        next();
      },
    });
    await verifier.verifyProvider();
  }, 120_000);
});

// Sanidade: sem banco de testes a verificação não tem sentido.
it('usa PostgreSQL real', () => {
  expect(inject('databaseUrl')).toMatch(/^postgres/);
});
