// Limite de tentativas: prazos movidos pelo dono do banco; a API usa só o relógio do PostgreSQL.
import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { PrismaAttemptStore } from '../../../src/authentication/adapters/prisma-attempt.store.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { sqlState } from '../payment-execution/support.js';
import { Browser, type Reply, startApp } from './http-support.js';
import { type AuthHarness, authHarness, failure, newEmail, OTHER_PASSWORD, PASSWORD, type Person } from './support.js';

const LIMITS = { maxAttempts: 5, windowMinutes: 15, restrictionSeconds: 30, maxRestrictionSeconds: 900 };

describe('limite de tentativas (PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http' });
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const subjectOf = (p: Person) => (p.alias === null ? hash('facilitator', p.email) : hash('customer', p.alias, p.email));
  const row = (subjectHash: string) => h.db.client.authenticationControl.findUnique({ where: { subjectHash } });
  const login = (p: { alias: string | null; email: string }, password: string, url = server.url) => new Browser(url).login(p, password);

  async function fail(p: Person, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      expect((await login(p, OTHER_PASSWORD)).status).toBe(401);
    }
  }

  /** Desloca todos os instantes do contador para o passado. */
  async function elapse(subjectHash: string, seconds: number): Promise<void> {
    await h.db.client.$executeRaw`
      UPDATE "authentication_control" SET
        "window_started_at" = "window_started_at" - make_interval(secs => ${seconds}::int),
        "restricted_until" = "restricted_until" - make_interval(secs => ${seconds}::int),
        "expires_at" = "expires_at" - make_interval(secs => ${seconds}::int)
       WHERE "subject_hash" = ${subjectHash}`;
  }

  function limited(reply: Reply, max: number): number {
    expect(reply.status).toBe(429);
    expect(reply.body['code']).toBe('RATE_LIMIT_EXCEEDED');
    const seconds = Number(reply.headers['retry-after']);
    expect(seconds).toBeGreaterThan(Math.max(0, max - 10));
    expect(seconds).toBeLessThanOrEqual(max);
    return seconds;
  }

  it('a quinta falha restringe por 30 s: 429 até com senha correta, sem Argon2', async () => {
    const p = await h.customer();
    await fail(p, 4);
    expect((await login(p, PASSWORD)).status).toBe(200);
    expect(await row(subjectOf(p))).toBeNull();
    await fail(p, 5);
    const verify = vi.spyOn(Argon2PasswordHasher.prototype, 'verify');
    try {
      limited(await login(p, PASSWORD), 30);
      limited(await login(p, OTHER_PASSWORD), 30);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
    expect((await row(subjectOf(p)))?.failures).toBe(5);
    expect(await h.activeCount(p.id)).toBe(1);
    await elapse(subjectOf(p), 31);
    expect((await login(p, PASSWORD)).status).toBe(200);
    expect(await row(subjectOf(p))).toBeNull();
  });

  it('dobra a cada falha até 15 min e nunca vira permanente', async () => {
    const p = await h.customer();
    await fail(p, 5);
    for (const expected of [60, 120, 240, 480, 900, 900, 900]) {
      await elapse(subjectOf(p), Math.ceil(((await row(subjectOf(p)))?.restrictedUntil?.getTime() ?? 0) / 1000 - Date.now() / 1000) + 2);
      expect((await login(p, OTHER_PASSWORD)).status).toBe(401);
      limited(await login(p, PASSWORD), expected);
    }
    await elapse(subjectOf(p), 902);
    expect((await login(p, PASSWORD)).status).toBe(200);
  });

  it('a janela fixa vence 15 min após a primeira falha, e a progressão 15 min após a restrição', async () => {
    const p = await h.customer();
    await fail(p, 4);
    await elapse(subjectOf(p), 15 * 60 + 1);
    await fail(p, 4);
    expect((await row(subjectOf(p)))?.failures).toBe(4);
    await fail(p, 1);
    await elapse(subjectOf(p), 30 + 14 * 60);
    await fail(p, 1);
    limited(await login(p, PASSWORD), 60);
    await elapse(subjectOf(p), 60 + 15 * 60 + 1);
    await fail(p, 1);
    expect(await row(subjectOf(p))).toMatchObject({ failures: 1, restrictedUntil: null });
  });

  it('login inexistente recebe as mesmas respostas', async () => {
    const real = await h.customer();
    const ghost = { alias: real.alias, email: newEmail() };
    for (let i = 0; i < 5; i += 1) {
      const [a, b] = [await login(real, OTHER_PASSWORD), await login(ghost, OTHER_PASSWORD)];
      expect({ ...a.body, correlationId: '' }).toEqual({ ...b.body, correlationId: '' });
    }
    limited(await login(real, PASSWORD), 30);
    limited(await login(ghost, PASSWORD), 30);
  });

  it('workspaces e perfis com o mesmo e-mail não se afetam; e-mail equivalente conta junto', async () => {
    const email = newEmail();
    const [a, b, f] = [await h.customer({ email }), await h.customer({ email }), await h.facilitator({ email })];
    await fail(a, 3);
    await fail({ ...a, email: ` ${email.toUpperCase()} ` }, 2);
    limited(await login(a, PASSWORD), 30);
    expect((await login(b, PASSWORD)).status).toBe(200);
    expect((await login(f, PASSWORD)).status).toBe(200);
  });

  it('entrada malformada não conta', async () => {
    const p = await h.customer();
    for (let i = 0; i < 8; i += 1) {
      expect((await login(p, 'curta')).status).toBe(401);
    }
    expect(await row(subjectOf(p))).toBeNull();
    expect((await login(p, PASSWORD)).status).toBe(200);
  });

  it('troca de senha tem limite próprio por identidade, sem afetar o login', async () => {
    const p = await h.customer();
    const b = new Browser(server.url);
    await b.login(p, PASSWORD);
    const change = (currentPassword: string, newPassword = 'mais uma senha longa') =>
      b.send('POST', '/password/change', { currentPassword, newPassword });
    for (let i = 0; i < 5; i += 1) {
      expect((await change(OTHER_PASSWORD)).status).toBe(422);
    }
    limited(await change(PASSWORD), 30);
    expect((await login(p, PASSWORD)).status).toBe(200);
    await elapse(hash('password', p.id), 31);
    expect((await change(PASSWORD, 'curta')).status).toBe(422);
    expect((await change(PASSWORD)).status).toBe(200);
  });

  it('20 falhas paralelas não passam do limite', async () => {
    const p = await h.customer();
    const verify = vi.spyOn(Argon2PasswordHasher.prototype, 'verify');
    try {
      const replies = await Promise.all(Array.from({ length: 20 }, () => login(p, OTHER_PASSWORD)));
      expect(replies.filter((r) => r.status === 401)).toHaveLength(5);
      expect(replies.filter((r) => r.status === 429)).toHaveLength(15);
      expect(verify).toHaveBeenCalledTimes(5);
    } finally {
      verify.mockRestore();
    }
  });

  it('20 logins corretos paralelos da mesma identidade são aceitos, mesmo após falhas', async () => {
    const p = await h.customer();
    await fail(p, 4);
    const replies = await Promise.all(Array.from({ length: 20 }, () => login(p, PASSWORD)));
    expect(replies.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(await h.activeCount(p.id)).toBe(20);
  });

  it('a restrição sobrevive a reinício e vale em outra instância', async () => {
    const p = await h.customer();
    await fail(p, 5);
    const other = await startApp({ COOKIE_TRANSPORT: 'local-http' });
    try {
      limited(await login(p, PASSWORD, other.url), 30);
    } finally {
      await other.app.close();
    }
  });

  it('usa a configuração', async () => {
    const p = await h.customer();
    const other = await startApp({
      COOKIE_TRANSPORT: 'local-http', LOGIN_MAX_ATTEMPTS: '1', LOGIN_RESTRICTION_SECONDS: '100', LOGIN_MAX_RESTRICTION_SECONDS: '150',
    });
    try {
      expect((await login(p, OTHER_PASSWORD, other.url)).status).toBe(401);
      limited(await login(p, PASSWORD, other.url), 100);
      await elapse(subjectOf(p), 101);
      expect((await login(p, OTHER_PASSWORD, other.url)).status).toBe(401);
      limited(await login(p, PASSWORD, other.url), 150);
    } finally {
      await other.app.close();
    }
  });

  it('guarda só o hash do assunto, remove vencidos e conta falhas atômicas entre instâncias', async () => {
    const store = new PrismaAttemptStore(h.app.client);
    const subject = `teste-${newEmail()}`;
    await Promise.all(Array.from({ length: 10 }, () => store.registerFailure(subject, LIMITS)));
    const key = createHash('sha256').update(subject).digest('hex');
    expect(await row(key)).toMatchObject({ failures: 10 });
    expect(JSON.stringify(await h.db.client.authenticationControl.findMany())).not.toContain('@');
    await elapse(key, 86_400);
    await store.registerFailure(`outro-${newEmail()}`, LIMITS);
    expect(await row(key)).toBeNull();
    const bad = h.app.client.$executeRaw`INSERT INTO "authentication_control" VALUES ('ana@example.test', 1, now(), NULL, now())`;
    expect(await sqlState(bad)).toBe('23514');
  });

  it('banco inacessível nega sem verificar a senha', async () => {
    const unreachable = new PrismaService({ databaseUrl: 'postgresql://u:senhabanco@127.0.0.1:1/b' });
    const store = new PrismaAttemptStore(unreachable.client);
    try {
      for (const op of [store.restrictionSeconds('x'), store.registerFailure('x', LIMITS), store.clear('x')]) {
        const error = await failure(op, 'AUTHENTICATION_FAILED');
        expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain('senhabanco');
      }
    } finally {
      await unreachable.onModuleDestroy();
    }
  });
});
