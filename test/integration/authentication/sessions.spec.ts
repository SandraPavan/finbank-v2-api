import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { PrismaAuthenticationStore } from '../../../src/authentication/adapters/prisma-authentication.store.js';
import { RandomSessionSecrets } from '../../../src/authentication/adapters/random-session-secrets.js';
import { AuthenticationService } from '../../../src/authentication/application/authentication.service.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { sqlState } from '../payment-execution/support.js';
import { type AuthHarness, authHarness, failure, newEmail, OTHER_PASSWORD, PASSWORD, type Person, SETTINGS, sha256 } from './support.js';

describe('login e sessões em PostgreSQL real', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await authHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  /** Envelhece a sessão pelo dono: desloca os instantes para o passado com o trigger desligado só aqui. */
  async function age(sessionId: string, minutes: { idle: number; absolute: number }): Promise<void> {
    await h.db.client.$transaction([
      h.db.client.$executeRaw`ALTER TABLE "user_session" DISABLE TRIGGER "user_session_terminal"`,
      h.db.client.$executeRaw`
        UPDATE "user_session"
           SET "created_at" = clock_timestamp() - interval '1 day', "last_activity_at" = clock_timestamp() - interval '1 day',
               "idle_expires_at" = clock_timestamp() + make_interval(mins => ${minutes.idle}::int),
               "absolute_expires_at" = clock_timestamp() + make_interval(mins => ${minutes.absolute}::int)
         WHERE "id" = ${sessionId}::uuid`,
      h.db.client.$executeRaw`ALTER TABLE "user_session" ENABLE TRIGGER "user_session_terminal"`,
    ]);
  }

  const row = (sessionId: string) => h.db.client.userSession.findUniqueOrThrow({ where: { id: sessionId } });

  describe('login', () => {
    it('cliente com alias e facilitador global recebem sessão com o próprio escopo', async () => {
      const [c, f] = [await h.customer(), await h.facilitator()];
      const [oc, of] = [await h.login(c), await h.login(f)];
      expect(oc.session).toMatchObject({ identityId: c.id, profile: 'CUSTOMER', workspaceId: c.workspaceId });
      expect(of.session).toMatchObject({ identityId: f.id, profile: 'FACILITATOR', workspaceId: null });
      expect((await h.auth.validate(oc.secret)).sessionId).toBe(oc.session.sessionId);
      expect((await h.auth.validate(of.secret)).sessionId).toBe(of.session.sessionId);
    });

    it('normaliza o e-mail e preserva a senha exata', async () => {
      const f = await h.facilitator({ password: '  Espaços e CAIXA  ' });
      await h.auth.loginFacilitator({ email: ` ${f.email.toUpperCase()} `, password: '  Espaços e CAIXA  ' });
      await failure(h.auth.loginFacilitator({ email: f.email, password: 'Espaços e CAIXA' }), 'INVALID_CREDENTIALS');
      await failure(h.auth.loginFacilitator({ email: f.email, password: '  espaços e caixa  ' }), 'INVALID_CREDENTIALS');
    });

    it('mesmo e-mail em dois workspaces são identidades independentes', async () => {
      const email = newEmail();
      const a = await h.customer({ email, password: PASSWORD });
      const b = await h.customer({ email, password: OTHER_PASSWORD });
      const f = await h.facilitator({ email, password: 'senha do facilitador aqui' });
      expect((await h.login(a, PASSWORD)).session.identityId).toBe(a.id);
      expect((await h.login(b, OTHER_PASSWORD)).session.identityId).toBe(b.id);
      await failure(h.login(a, OTHER_PASSWORD), 'INVALID_CREDENTIALS');
      await failure(h.login(b, PASSWORD), 'INVALID_CREDENTIALS');
      await failure(h.login(f, PASSWORD), 'INVALID_CREDENTIALS');
      await failure(h.login(a, 'senha do facilitador aqui'), 'INVALID_CREDENTIALS');
    });

    it('todas as recusas são idênticas, executam uma verificação e não criam sessão', async () => {
      const c = await h.customer();
      const disabled = await h.customer();
      await h.db.client.userIdentity.update({ where: { id: disabled.id }, data: { status: 'DISABLED' } });
      const bare = await h.customer({ password: null });
      const before = await h.db.client.userSession.count();
      const verify = vi.spyOn(Argon2PasswordHasher.prototype, 'verify');
      try {
        const attempts: Person[] = [
          { ...c, alias: `t-${randomUUID()}` }, { ...c, email: newEmail() }, disabled, bare, { ...c, alias: bare.alias },
        ];
        const errors = [await failure(h.login(c, OTHER_PASSWORD), 'INVALID_CREDENTIALS')];
        for (const person of attempts) {
          errors.push(await failure(h.login(person), 'INVALID_CREDENTIALS'));
        }
        expect(new Set(errors.map((e) => `${e.name}|${e.message}|${e.technicalCode}|${String(e.cause)}`)).size).toBe(1);
        expect(verify).toHaveBeenCalledTimes(errors.length);
      } finally {
        verify.mockRestore();
      }
      expect(await h.db.client.userSession.count()).toBe(before);
    });

    it('cliente não entra como facilitador nem o contrário', async () => {
      const [c, f] = [await h.customer(), await h.facilitator()];
      await failure(h.auth.loginFacilitator({ email: c.email, password: PASSWORD }), 'INVALID_CREDENTIALS');
      await failure(h.auth.loginCustomer({ alias: c.alias, email: f.email, password: PASSWORD }), 'INVALID_CREDENTIALS');
    });
  });

  describe('segredo', () => {
    it('só o SHA-256 fica no banco; hash, id ou segredo alterado não validam', async () => {
      const c = await h.customer();
      const { secret, session } = await h.login(c);
      const stored = await row(session.sessionId);
      expect(stored.tokenHash).toBe(sha256(secret));
      expect(JSON.stringify(stored)).not.toContain(secret);
      const changed = `${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;
      for (const value of [stored.tokenHash, session.sessionId, changed, new RandomSessionSecrets().generate()]) {
        await failure(h.auth.validate(value), 'SESSION_INVALID');
      }
      expect((await h.auth.validate(secret)).identityId).toBe(c.id);
    });

    it('o banco recusa hash de senha e segredo fora do formato', async () => {
      const f = await h.facilitator({ password: null });
      const add = (hash: string) =>
        h.db.client.$executeRaw`INSERT INTO "password_credential" ("identity_id", "hash") VALUES (${f.id}::uuid, ${hash})`;
      for (const hash of ['senha em claro aqui', '', '$argon2i$v=19$m=19456,t=2,p=1$x$y', sha256('x')]) {
        expect(await sqlState(add(hash))).toBe('23514');
      }
      const open = (token: string) => h.app.client.$executeRaw`
        INSERT INTO "user_session" ("identity_id", "token_hash", "created_at", "last_activity_at", "idle_expires_at", "absolute_expires_at")
        VALUES (${f.id}::uuid, ${token}, now(), now(), now(), now())`;
      expect(await sqlState(open('segredo-em-claro'))).toBe('23514');
    });
  });

  describe('expiração', () => {
    it('grava os prazos a partir do relógio do banco e renova só a inatividade', async () => {
      const { secret, session } = await h.login(await h.customer());
      const created = await row(session.sessionId);
      expect(created.idleExpiresAt.getTime() - created.createdAt.getTime()).toBe(30 * 60_000);
      expect(created.absoluteExpiresAt.getTime() - created.createdAt.getTime()).toBe(480 * 60_000);
      await age(session.sessionId, { idle: 1, absolute: 100 });
      const aged = await row(session.sessionId);
      const renewed = await h.auth.validate(secret);
      expect(renewed.idleExpiresAt.getTime()).toBeGreaterThan(aged.idleExpiresAt.getTime() + 28 * 60_000);
      expect(renewed.absoluteExpiresAt).toEqual(aged.absoluteExpiresAt);
      expect((await row(session.sessionId)).lastActivityAt.getTime()).toBeGreaterThan(aged.lastActivityAt.getTime());
    });

    it('a renovação nunca ultrapassa o prazo absoluto', async () => {
      const { secret, session } = await h.login(await h.customer());
      await age(session.sessionId, { idle: 1, absolute: 5 });
      const renewed = await h.auth.validate(secret);
      expect(renewed.idleExpiresAt).toEqual(renewed.absoluteExpiresAt);
    });

    it.each([
      ['inatividade', { idle: -1, absolute: 100 }],
      ['duração absoluta', { idle: -1, absolute: -1 }],
      ['fronteira exata', { idle: 0, absolute: 100 }],
    ])('expira por %s e não volta nem com configuração maior', async (_label, minutes) => {
      const person = await h.customer();
      const { secret, session } = await h.login(person);
      await age(session.sessionId, minutes);
      const before = await row(session.sessionId);
      await failure(h.auth.validate(secret), 'SESSION_EXPIRED');
      const generous = h.service({ idleMinutes: 1440, absoluteMinutes: 1440 });
      await failure(generous.validate(secret), 'SESSION_EXPIRED');
      await failure(generous.logoutAll(secret), 'SESSION_EXPIRED');
      await failure(generous.changePassword(secret, PASSWORD, OTHER_PASSWORD), 'SESSION_EXPIRED');
      await h.auth.logout(secret);
      await failure(h.auth.validate(secret), 'SESSION_EXPIRED');
      expect(await row(session.sessionId)).toEqual(before);
      await h.login(person);
    });

    it('a execução não reativa por SQL sessão expirada nem encerrada', async () => {
      const person = await h.customer();
      const [expired, revoked] = [await h.login(person), await h.login(person)];
      await age(expired.session.sessionId, { idle: -1, absolute: 100 });
      await h.auth.logout(revoked.secret);
      const set = (id: string, change: string) => h.app.client.$executeRawUnsafe(`UPDATE "user_session" SET ${change} WHERE "id" = $1::uuid`, id);
      const renew = `"idle_expires_at" = clock_timestamp() + interval '1 minute'`;
      expect(await sqlState(set(expired.session.sessionId, renew))).toBe('23001');
      expect(await sqlState(set(expired.session.sessionId, '"last_activity_at" = clock_timestamp()'))).toBe('23001');
      expect(await sqlState(set(revoked.session.sessionId, '"revoked_at" = NULL'))).toBe('23001');
      expect(await sqlState(set(revoked.session.sessionId, renew))).toBe('23001');
      expect(await sqlState(set(revoked.session.sessionId, `"absolute_expires_at" = now() + interval '2 days'`))).toBe('42501');
      const active = await h.login(person);
      expect(await sqlState(set(active.session.sessionId, `"idle_expires_at" = now() + interval '2 days'`))).toBe('23514');
    });

    it('os prazos configurados valem para a sessão nova', async () => {
      const f = await h.facilitator();
      const { session } = await h.service({ idleMinutes: 2, absoluteMinutes: 3 }).loginFacilitator({ email: f.email, password: PASSWORD });
      const stored = await row(session.sessionId);
      expect(stored.idleExpiresAt.getTime() - stored.createdAt.getTime()).toBe(120_000);
      expect(stored.absoluteExpiresAt.getTime() - stored.createdAt.getTime()).toBe(180_000);
    });
  });

  describe('encerramento', () => {
    it('logout encerra só a sessão atual e repetir não tem efeito', async () => {
      const person = await h.customer();
      const [a, b] = [await h.login(person), await h.login(person)];
      await h.auth.logout(a.secret);
      const revokedAt = (await row(a.session.sessionId)).revokedAt;
      await h.auth.logout(a.secret);
      expect((await row(a.session.sessionId)).revokedAt).toEqual(revokedAt);
      await failure(h.auth.validate(a.secret), 'SESSION_INVALID');
      await h.auth.validate(b.secret);
    });

    it('logout de todas encerra só as da própria identidade', async () => {
      const [person, other] = [await h.customer(), await h.customer()];
      const mine = await Promise.all([h.login(person), h.login(person), h.login(person)]);
      const theirs = await h.login(other);
      await h.auth.logoutAll(mine[0].secret);
      for (const { secret } of mine) {
        await failure(h.auth.validate(secret), 'SESSION_INVALID');
      }
      await failure(h.auth.logoutAll(mine[1].secret), 'SESSION_INVALID');
      await h.auth.validate(theirs.secret);
      await h.login(person);
    });

    it('desativar encerra as sessões e reativar não as restaura', async () => {
      const [person, other] = [await h.customer(), await h.customer()];
      const [mine, theirs] = [await h.login(person), await h.login(other)];
      await h.db.client.userIdentity.update({ where: { id: person.id }, data: { status: 'DISABLED' } });
      await failure(h.auth.validate(mine.secret), 'SESSION_INVALID');
      await h.db.client.userIdentity.update({ where: { id: person.id }, data: { status: 'ACTIVE' } });
      await failure(h.auth.validate(mine.secret), 'SESSION_INVALID');
      await h.auth.validate(theirs.secret);
      await h.login(person);
    });

    it('identidade desativada é negada mesmo com a sessão ainda aberta no banco', async () => {
      const person = await h.customer();
      const { secret } = await h.login(person);
      await h.db.client.$transaction([
        h.db.client.$executeRaw`ALTER TABLE "user_identity" DISABLE TRIGGER "user_identity_disable_revokes_sessions"`,
        h.db.client.$executeRaw`UPDATE "user_identity" SET "status" = 'DISABLED' WHERE "id" = ${person.id}::uuid`,
        h.db.client.$executeRaw`ALTER TABLE "user_identity" ENABLE TRIGGER "user_identity_disable_revokes_sessions"`,
      ]);
      expect(await h.activeCount(person.id)).toBe(1);
      await failure(h.auth.validate(secret), 'SESSION_INVALID');
    });

    it('trocar o alias não move a sessão de workspace', async () => {
      const [a, b] = [await h.customer(), await h.customer()];
      const { secret } = await h.login(a);
      await h.db.client.$transaction([
        h.db.client.$executeRaw`UPDATE "workspace" SET "alias" = NULL WHERE "id" = ${a.workspaceId}::uuid`,
        h.db.client.$executeRaw`UPDATE "workspace" SET "alias" = ${a.alias} WHERE "id" = ${b.workspaceId}::uuid`,
      ]);
      expect((await h.auth.validate(secret)).workspaceId).toBe(a.workspaceId);
      await failure(h.login(a), 'INVALID_CREDENTIALS');
    });
  });

  describe('troca de senha', () => {
    it('encerra as anteriores, abre uma nova e só a senha nova vale', async () => {
      const person = await h.customer();
      const [a, b] = [await h.login(person), await h.login(person)];
      const changed = await h.auth.changePassword(a.secret, PASSWORD, OTHER_PASSWORD);
      expect(changed.session.sessionId).not.toBe(a.session.sessionId);
      expect(changed.session.workspaceId).toBe(person.workspaceId);
      for (const { secret } of [a, b]) {
        await failure(h.auth.validate(secret), 'SESSION_INVALID');
      }
      await h.auth.validate(changed.secret);
      expect(await h.activeCount(person.id)).toBe(1);
      await failure(h.login(person, PASSWORD), 'INVALID_CREDENTIALS');
      await h.login(person, OTHER_PASSWORD);
    });

    it.each([
      ['senha atual errada', OTHER_PASSWORD, 'senha nova bem longa', 'INVALID_CREDENTIALS'],
      ['senha atual malformada', 'curta', 'senha nova bem longa', 'INVALID_CREDENTIALS'],
      ['senha nova fora da política', PASSWORD, 'curta', 'PASSWORD_POLICY'],
    ] as const)('%s não altera nada e mantém a sessão', async (_label, current, next, code) => {
      const person = await h.customer();
      const { secret } = await h.login(person);
      const before = await h.db.client.passwordCredential.findUniqueOrThrow({ where: { identityId: person.id } });
      await failure(h.auth.changePassword(secret, current, next), code);
      expect(await h.db.client.passwordCredential.findUniqueOrThrow({ where: { identityId: person.id } })).toEqual(before);
      await h.auth.validate(secret);
      expect(await h.activeCount(person.id)).toBe(1);
    });

    it('falha ao abrir a sessão nova reverte a senha e os encerramentos', async () => {
      const person = await h.customer();
      const [a, b] = [await h.login(person), await h.login(person)];
      await h.db.client.$executeRawUnsafe(`CREATE FUNCTION test_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.identity_id = '${person.id}' THEN RAISE EXCEPTION 'falha de teste'; END IF; RETURN NEW; END $$`);
      await h.db.client.$executeRawUnsafe('CREATE TRIGGER test_fail_session BEFORE INSERT ON "user_session" FOR EACH ROW EXECUTE FUNCTION test_fail_session()');
      try {
        await failure(h.auth.changePassword(a.secret, PASSWORD, OTHER_PASSWORD), 'AUTHENTICATION_FAILED');
      } finally {
        await h.db.client.$executeRawUnsafe('DROP TRIGGER test_fail_session ON "user_session"');
        await h.db.client.$executeRawUnsafe('DROP FUNCTION test_fail_session()');
      }
      await h.auth.validate(a.secret);
      await h.auth.validate(b.secret);
      await h.login(person, PASSWORD);
    });
  });

  it('banco inacessível é falha tipada, sem senha, segredo, hash, e-mail nem conexão', async () => {
    const unreachable = new PrismaService({ databaseUrl: 'postgresql://usuario:senhabanco@127.0.0.1:1/banco' });
    const secrets = new RandomSessionSecrets();
    const secret = secrets.generate();
    const service = new AuthenticationService({
      store: new PrismaAuthenticationStore(unreachable.client), hasher: new Argon2PasswordHasher(), secrets, settings: SETTINGS, decoyHash: '',
    });
    const spies = (['log', 'error', 'warn', 'info'] as const).map((m) => vi.spyOn(console, m));
    try {
      for (const op of [
        service.loginFacilitator({ email: 'ana@example.test', password: PASSWORD }),
        service.loginCustomer({ alias: 'turma', email: 'ana@example.test', password: PASSWORD }),
        service.validate(secret), service.logout(secret), service.logoutAll(secret),
        service.changePassword(secret, PASSWORD, OTHER_PASSWORD),
      ]) {
        const error = await failure(op, 'AUTHENTICATION_FAILED');
        expect(error.cause).toBeUndefined();
        const text = `${error.stack} ${JSON.stringify(error)}`;
        for (const sensitive of [PASSWORD, OTHER_PASSWORD, secret, sha256(secret), 'ana@example.test', 'senhabanco', '127.0.0.1']) {
          expect(text).not.toContain(sensitive);
        }
      }
      expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
    } finally {
      spies.forEach((s) => s.mockRestore());
      await unreachable.onModuleDestroy();
    }
  });
});
