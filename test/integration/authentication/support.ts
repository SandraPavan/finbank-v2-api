// Suporte dos testes de autenticação: o dono prepara dados; os serviços usam o usuário de execução.
import { createHash, randomUUID } from 'node:crypto';
import { expect, inject } from 'vitest';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { PrismaAuthenticationStore } from '../../../src/authentication/adapters/prisma-authentication.store.js';
import { RandomSessionSecrets } from '../../../src/authentication/adapters/random-session-secrets.js';
import { AuthenticationService } from '../../../src/authentication/application/authentication.service.js';
import { AuthenticationError, type AuthenticationErrorCode } from '../../../src/authentication/domain/errors.js';
import type { SessionSettings } from '../../../src/authentication/domain/session.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';

export const PASSWORD = 'senha de teste bem longa';
export const OTHER_PASSWORD = 'outra senha bem diferente';
export const SETTINGS: SessionSettings = { idleMinutes: 30, absoluteMinutes: 480 };

export interface Person {
  readonly id: string;
  readonly email: string;
  readonly workspaceId: string | null;
  readonly alias: string | null;
}

export interface AuthHarness {
  readonly db: PrismaService;
  readonly app: PrismaService;
  readonly auth: AuthenticationService;
  service(settings: SessionSettings): AuthenticationService;
  customer(options?: { email?: string; password?: string | null }): Promise<Person>;
  facilitator(options?: { email?: string; password?: string | null }): Promise<Person>;
  login(person: Person, password?: string): ReturnType<AuthenticationService['loginCustomer']>;
  activeCount(identityId: string): Promise<number>;
  close(): Promise<void>;
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const newEmail = (): string => `pessoa-${randomUUID()}@example.test`;

export async function authHarness(): Promise<AuthHarness> {
  const db = new PrismaService({ databaseUrl: inject('databaseUrl') });
  const app = new PrismaService({ databaseUrl: inject('appDatabaseUrl') });
  await db.onModuleInit();
  await app.onModuleInit();
  const hasher = new Argon2PasswordHasher();
  const decoyHash = await hasher.hash('senha ficticia descartada');
  const service = (settings: SessionSettings) =>
    new AuthenticationService({
      store: new PrismaAuthenticationStore(app.client), hasher, secrets: new RandomSessionSecrets(), settings, decoyHash,
    });
  const auth = service(SETTINGS);

  async function credential(identityId: string, password: string | null | undefined): Promise<void> {
    if (password !== null) {
      await db.client.passwordCredential.create({ data: { identityId, hash: await hasher.hash(password ?? PASSWORD) } });
    }
  }

  return {
    db,
    app,
    auth,
    service,
    async customer(options = {}) {
      const alias = `t-${randomUUID()}`;
      const workspace = await db.client.workspace.create({ data: { alias }, select: { id: true } });
      const email = options.email ?? newEmail();
      const { id } = await db.client.userIdentity.create({
        data: { profile: 'CUSTOMER', status: 'ACTIVE', email, workspaceId: workspace.id }, select: { id: true },
      });
      await credential(id, options.password);
      return { id, email, workspaceId: workspace.id, alias };
    },
    async facilitator(options = {}) {
      const email = options.email ?? newEmail();
      const { id } = await db.client.userIdentity.create({
        data: { profile: 'FACILITATOR', status: 'ACTIVE', email }, select: { id: true },
      });
      await credential(id, options.password);
      return { id, email, workspaceId: null, alias: null };
    },
    login: (person, password = PASSWORD) =>
      person.alias === null
        ? auth.loginFacilitator({ email: person.email, password })
        : auth.loginCustomer({ alias: person.alias, email: person.email, password }),
    async activeCount(identityId) {
      const [row] = await db.client.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total" FROM "user_session"
         WHERE "identity_id" = ${identityId}::uuid AND "revoked_at" IS NULL
           AND "idle_expires_at" > clock_timestamp() AND "absolute_expires_at" > clock_timestamp()`;
      return row?.total ?? -1;
    },
    async close() {
      await app.onModuleDestroy();
      await db.onModuleDestroy();
    },
  };
}

export async function failure(promise: Promise<unknown>, code: AuthenticationErrorCode): Promise<AuthenticationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthenticationError);
  expect((error as AuthenticationError).code).toBe(code);
  return error as AuthenticationError;
}
