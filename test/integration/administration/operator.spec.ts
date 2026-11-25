// Operações do operador em PostgreSQL real, inclusive o processo da linha de comando.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaOperatorStore } from '../../../src/administration/adapters/prisma-operator.store.js';
import { RandomTemporaryCredential } from '../../../src/administration/adapters/random-temporary-credential.js';
import { OperatorService } from '../../../src/administration/application/operator.service.js';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { type AuthHarness, authHarness, failure, newEmail, OTHER_PASSWORD, PASSWORD } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';
import { withAuditFailure } from './support.js';

const OUT = resolve('node_modules/.cache/finbank-admin-test');
const newAlias = (): string => `t-${randomUUID()}`;
const give = (password: string) => () => Promise.resolve(password);
const never = () => Promise.reject(new Error('senha pedida'));

describe('operações do operador (PostgreSQL real)', () => {
  let h: AuthHarness;
  let operator: OperatorService;

  beforeAll(async () => {
    h = await authHarness();
    operator = service(h.db);
    rmSync(OUT, { recursive: true, force: true });
    await promisify(execFile)(resolve('node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json', '--outDir', OUT]);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/package.json`, '{"type":"module"}');
  });

  afterAll(async () => {
    rmSync(OUT, { recursive: true, force: true });
    await h?.close();
  });

  function service(prisma: PrismaService, correlationId = `c-${randomUUID()}`): OperatorService {
    return new OperatorService({ store: new PrismaOperatorStore(prisma.client), hasher: new Argon2PasswordHasher(), generator: new RandomTemporaryCredential(), temporaryCredentialHours: 24, correlationId });
  }

  const facilitator = (email: string) =>
    h.db.client.userIdentity.findFirst({ where: { email, profile: 'FACILITATOR' }, include: { credential: true, memberships: true } });
  const workspace = (alias: string) => h.db.client.workspace.findUnique({ where: { alias } });
  const audit = (correlationId: string) =>
    h.db.client.auditRecord.findMany({ where: { correlationId }, orderBy: [{ occurredAt: 'asc' }, { operation: 'asc' }] });

  describe('bootstrap', () => {
    it('prepara o acesso de ponta a ponta: facilitador e cliente entram', async () => {
      const [alias, email, customer] = [newAlias(), newEmail(), newEmail()];
      expect(await operator.bootstrap(alias, ` ${email.toUpperCase()} `, give(PASSWORD))).toEqual({
        workspaceCreated: true, facilitatorCreated: true, membershipCreated: true,
      });
      await operator.createCustomer(alias, customer, give(OTHER_PASSWORD));
      expect((await h.auth.loginFacilitator({ email, password: PASSWORD })).session.profile).toBe('FACILITATOR');
      const session = (await h.auth.loginCustomer({ alias, email: customer, password: OTHER_PASSWORD })).session;
      expect(session.workspaceId).toBe((await workspace(alias))?.id);
      const person = await facilitator(email);
      expect(person?.memberships).toMatchObject([{ status: 'ACTIVE', role: 'FACILITATOR', workspaceId: session.workspaceId }]);
      expect(await h.db.client.account.count({ where: { workspaceId: session.workspaceId ?? '' } })).toBe(0);
    });

    it('repetir não pede senha nem altera credencial, sessão ou vínculo', async () => {
      const [alias, email] = [newAlias(), newEmail()];
      await operator.bootstrap(alias, email, give(PASSWORD));
      const opened = await h.auth.loginFacilitator({ email, password: PASSWORD });
      const before = await facilitator(email);
      expect(await operator.bootstrap(alias, email, never)).toEqual({
        workspaceCreated: false, facilitatorCreated: false, membershipCreated: false,
      });
      expect(await facilitator(email)).toEqual(before);
      expect((await h.auth.validate(opened.secret)).identityId).toBe(before?.id);
    });

    it('dez execuções paralelas deixam um workspace, um facilitador e um vínculo', async () => {
      const [alias, email] = [newAlias(), newEmail()];
      const done = await Promise.all(Array.from({ length: 10 }, (_, i) => operator.bootstrap(alias, email, give(`${PASSWORD} ${i}`))));
      expect(done.filter((d) => d.workspaceCreated)).toHaveLength(1);
      expect(done.filter((d) => d.facilitatorCreated)).toHaveLength(1);
      expect(done.filter((d) => d.membershipCreated)).toHaveLength(1);
      expect(await h.db.client.userIdentity.count({ where: { email } })).toBe(1);
      expect((await facilitator(email))?.memberships).toHaveLength(1);
    });

    it('não reverte desativação nem revogação, e não deixa estado parcial', async () => {
      const [alias, email] = [newAlias(), newEmail()];
      await operator.bootstrap(alias, email, give(PASSWORD));
      await operator.setMembership(alias, email, 'REVOKED');
      await expect(operator.bootstrap(alias, email, never)).rejects.toMatchObject({ code: 'MEMBERSHIP_REVOKED' });
      await operator.setFacilitatorState(email, 'DISABLED');
      const fresh = newAlias();
      await expect(operator.bootstrap(fresh, email, never)).rejects.toMatchObject({ code: 'FACILITATOR_DISABLED' });
      expect(await workspace(fresh)).toBeNull();
      expect(await facilitator(email)).toMatchObject({ status: 'DISABLED', memberships: [{ status: 'REVOKED' }] });
    });

    it.each(['WORKSPACE_CREATE', 'FACILITATOR_CREATE', 'MEMBERSHIP_GRANT'])('falha da auditoria em %s desfaz tudo', async (operation) => {
      await withAuditFailure(h, operation, async () => {
        const [alias, email] = [newAlias(), newEmail()];
        await expect(operator.bootstrap(alias, email, give(PASSWORD))).rejects.toMatchObject({ code: 'ADMINISTRATION_FAILED' });
        expect(await workspace(alias)).toBeNull();
        expect(await facilitator(email)).toBeNull();
      });
    });
  });

  describe('comandos', () => {
    it('criar o que existe falha sem alterar; clientes repetem e-mail só em workspaces diferentes', async () => {
      const [a, b, email] = [newAlias(), newAlias(), newEmail()];
      await operator.createWorkspace(a);
      await operator.createWorkspace(b);
      await expect(operator.createWorkspace(a)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await operator.createFacilitator(email, give(PASSWORD));
      await expect(operator.createFacilitator(email, give(OTHER_PASSWORD))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await h.auth.loginFacilitator({ email, password: PASSWORD });
      await operator.createCustomer(a, email, give(PASSWORD));
      await operator.createCustomer(b, email, give(PASSWORD));
      await expect(operator.createCustomer(a, email, give(OTHER_PASSWORD))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await h.auth.loginCustomer({ alias: a, email, password: PASSWORD });
    });

    it('recurso ausente falha sem efeito', async () => {
      const [alias, email] = [newAlias(), newEmail()];
      await expect(operator.createCustomer(alias, email, give(PASSWORD))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(operator.setFacilitatorState(email, 'DISABLED')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(operator.setMembership(alias, email, 'ACTIVE')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await operator.createWorkspace(alias);
      await operator.createFacilitator(email, give(PASSWORD));
      await expect(operator.setMembership(alias, email, 'REVOKED')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // O e-mail de cliente não designa facilitador.
      const customer = await h.customer();
      await expect(operator.setFacilitatorState(customer.email, 'DISABLED')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('desativar encerra sessões e impede login; reativar não as restaura; repetir não muda', async () => {
      const person = await h.facilitator();
      const opened = await h.login(person);
      expect(await operator.setFacilitatorState(person.email, 'DISABLED')).toBe(true);
      expect(await operator.setFacilitatorState(person.email, 'DISABLED')).toBe(false);
      await failure(h.auth.validate(opened.secret), 'SESSION_INVALID');
      await failure(h.login(person), 'INVALID_CREDENTIALS');
      expect(await operator.setFacilitatorState(person.email, 'ACTIVE')).toBe(true);
      await failure(h.auth.validate(opened.secret), 'SESSION_INVALID');
      await h.login(person);
    });

    it('vínculo concedido, revogado e devolvido, com repetição sem mudança', async () => {
      const [alias, person] = [newAlias(), await h.facilitator()];
      await operator.createWorkspace(alias);
      const results = [];
      for (const state of ['ACTIVE', 'ACTIVE', 'REVOKED', 'REVOKED', 'ACTIVE'] as const) {
        results.push(await operator.setMembership(alias, person.email, state));
      }
      expect(results).toEqual([true, false, true, false, true]);
    });

    it('pelo usuário de execução toda escrita é recusada', async () => {
      const limited = service(h.app);
      const [alias, email] = [newAlias(), newEmail()];
      for (const attempt of [
        () => limited.bootstrap(alias, email, give(PASSWORD)),
        () => limited.createWorkspace(alias),
        () => limited.createFacilitator(email, give(PASSWORD)),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: 'ADMINISTRATION_FAILED' });
      }
      const person = await h.facilitator();
      await expect(limited.setFacilitatorState(person.email, 'DISABLED')).rejects.toMatchObject({ code: 'ADMINISTRATION_FAILED' });
      expect(await facilitator(person.email)).toMatchObject({ status: 'ACTIVE' });
    });
  });

  describe('banco', () => {
    it('a execução muda o estado de cliente, nunca o de facilitador', async () => {
      const [customer, person] = [await h.customer(), await h.facilitator()];
      await h.app.client.$executeRaw`UPDATE "user_identity" SET "status" = 'DISABLED' WHERE "id" = ${customer.id}::uuid`;
      expect(await sqlState(h.app.client.$executeRaw`UPDATE "user_identity" SET "status" = 'DISABLED' WHERE "id" = ${person.id}::uuid`)).toBe('42501');
      await operator.setFacilitatorState(person.email, 'DISABLED');
      expect(await sqlState(h.app.client.$executeRaw`UPDATE "user_identity" SET "status" = 'ACTIVE' WHERE "id" = ${person.id}::uuid`)).toBe('42501');
    });

    it('auditoria é imutável também para o dono e recusa registros incoerentes', async () => {
      await operator.createWorkspace(newAlias());
      for (const sql of [
        `UPDATE "audit_record" SET "result" = 'UNCHANGED'`, 'DELETE FROM "audit_record"', 'TRUNCATE "audit_record"', 'TRUNCATE "workspace" CASCADE',
      ]) {
        expect(await sqlState(h.db.client.$executeRawUnsafe(sql)), sql).toBe('23001');
      }
      const person = await h.facilitator();
      const row = (actor: string, id: string | null, profile: string | null, operation = 'BOOTSTRAP', correlation = 'correlacao-1') =>
        sqlState(h.app.client.$executeRaw`
          INSERT INTO "audit_record" ("actor_type", "actor_identity_id", "actor_profile", "operation", "resource_type", "resource_id", "result", "correlation_id")
          VALUES (${actor}::"audit_actor_type", ${id}::uuid, ${profile}::"membership_role", ${operation}, 'IDENTITY', gen_random_uuid(), 'CHANGED', ${correlation})`);
      expect(await row('IDENTITY', null, null)).toBe('23514');
      expect(await row('IDENTITY', person.id, null)).toBe('23514');
      expect(await row('OPERATOR', person.id, 'FACILITATOR')).toBe('23514');
      expect(await row('IDENTITY', person.id, 'CUSTOMER')).toBe('23503');
      expect(await row('OPERATOR', null, null, 'texto livre')).toBe('23514');
      expect(await row('OPERATOR', null, null, 'BOOTSTRAP', 'a@b com espaço')).toBe('23514');
    });

    it('cada operação registra ator, escopo, recurso, resultado e instante real, sem dados sensíveis', async () => {
      const correlation = `c-${randomUUID()}`;
      const op = service(h.db, correlation);
      const [alias, email, customer] = [newAlias(), newEmail(), newEmail()];
      const started = Date.now();
      await op.bootstrap(alias, email, give(PASSWORD));
      await op.bootstrap(alias, email, never);
      await op.createCustomer(alias, customer, give(PASSWORD));
      await op.setMembership(alias, email, 'ACTIVE');
      await op.setMembership(alias, email, 'REVOKED');
      await op.setFacilitatorState(email, 'DISABLED');
      await op.setFacilitatorState(email, 'DISABLED');
      await op.setFacilitatorState(email, 'ACTIVE');
      await expect(op.createWorkspace(alias)).rejects.toThrow();
      const rows = await audit(correlation);
      const w = (await workspace(alias))?.id;
      const f = (await facilitator(email))?.id;
      const c = (await h.db.client.userIdentity.findFirst({ where: { email: customer } }))?.id;
      const seen = rows.map((r) => [r.operation, r.resourceType, r.resourceId, r.workspaceId, r.result].join(' '));
      expect(seen.sort()).toEqual([
        `WORKSPACE_CREATE WORKSPACE ${w} ${w} CHANGED`, `FACILITATOR_CREATE IDENTITY ${f}  CHANGED`, `MEMBERSHIP_GRANT MEMBERSHIP ${f} ${w} CHANGED`,
        `BOOTSTRAP WORKSPACE ${w} ${w} UNCHANGED`, `CUSTOMER_CREATE IDENTITY ${c} ${w} CHANGED`, `MEMBERSHIP_GRANT MEMBERSHIP ${f} ${w} UNCHANGED`,
        `MEMBERSHIP_REVOKE MEMBERSHIP ${f} ${w} CHANGED`, `FACILITATOR_DISABLE IDENTITY ${f}  CHANGED`, `FACILITATOR_DISABLE IDENTITY ${f}  UNCHANGED`,
        `FACILITATOR_ENABLE IDENTITY ${f}  CHANGED`,
      ].sort());
      for (const r of rows) {
        expect(r).toMatchObject({ actorType: 'OPERATOR', actorIdentityId: null, actorProfile: null });
        expect(Math.abs(r.occurredAt.getTime() - started)).toBeLessThan(60_000);
      }
      const text = JSON.stringify(rows);
      for (const value of [email, customer, alias, PASSWORD, 'argon2']) {
        expect(text).not.toContain(value);
      }
    });
  });

  describe('processo da linha de comando', () => {
    interface Run {
      code: number | null;
      out: string;
      err: string;
    }
    function cli(args: string[], input: string | null = null, url: string = inject('databaseUrl')): Promise<Run> {
      return new Promise((done) => {
        const child = spawn(process.execPath, [`${OUT}/admin.js`, ...args], { env: { ...process.env, DATABASE_URL: url } });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('close', (code) => done({ code, out, err }));
        child.stdin.on('error', () => undefined);
        child.stdin.end(input ?? '');
      });
    }

    it('bootstrap, repetição e conflito, com códigos de saída e sem vazar', async () => {
      const [alias, email] = [newAlias(), newEmail()];
      const first = await cli(['bootstrap', '--alias', alias, '--email', email], `${PASSWORD}\n`);
      expect(first).toEqual({ code: 0, out: 'workspace: criado; facilitador: criado; vínculo: criado\n', err: '' });
      const again = await cli(['bootstrap', '--alias', alias, '--email', email]);
      expect(again).toEqual({ code: 0, out: 'workspace: já existia; facilitador: já existia; vínculo: já existia\n', err: '' });
      await h.auth.loginFacilitator({ email, password: PASSWORD });
      const duplicate = await cli(['facilitator', 'create', '--email', email], OTHER_PASSWORD);
      expect([duplicate.code, duplicate.out]).toEqual([3, '']);
      const revoked = await cli(['membership', 'revoke', '--alias', alias, '--email', email]);
      expect([revoked.code, revoked.out]).toEqual([0, 'vínculo revogado\n']);
      expect((await cli(['bootstrap', '--alias', alias, '--email', email])).code).toBe(3);
      for (const run of [first, again, duplicate, revoked]) {
        expect(run.out + run.err).not.toContain(PASSWORD);
        expect(run.out + run.err).not.toContain(OTHER_PASSWORD);
        expect(run.out + run.err).not.toContain(email);
      }
    });

    it('facilitator reset mostra a credencial uma vez, só na saída padrão', async () => {
      const person = await h.facilitator();
      const run = await cli(['facilitator', 'reset', '--email', person.email]);
      expect([run.code, run.err]).toEqual([0, '']);
      const [temporary = ''] = /([0-9A-Z]{4}-){4}[0-9A-Z]{4}/.exec(run.out) ?? [];
      expect(run.out.split(temporary)).toHaveLength(2);
      expect((await h.login(person, temporary)).session.scope).toBe('PASSWORD_CHANGE');
      expect((await cli(['facilitator', 'reset', '--email', newEmail()])).code).toBe(3);
      await operator.setFacilitatorState(person.email, 'DISABLED');
      const conflict = await cli(['facilitator', 'reset', '--email', person.email]);
      expect([conflict.code, conflict.out]).toEqual([3, '']);
    });

    it('a senha não fica em claro no banco', async () => {
      const email = newEmail();
      const secret = `senha-${randomUUID()}`;
      expect((await cli(['facilitator', 'create', '--email', email], secret)).code).toBe(0);
      const hash = (await facilitator(email))?.credential?.hash ?? '';
      expect(hash).toMatch(/^\$argon2id\$/);
      expect(await new Argon2PasswordHasher().verify(secret, hash)).toBe(true);
      expect(hash).not.toContain(secret);
    });

    it('uso, política e entrada inválidos saem com 2 e não criam nada', async () => {
      const email = newEmail();
      const before = await h.db.client.userIdentity.count();
      const runs = [
        await cli(['facilitator', 'create', '--email', email, '--password', PASSWORD]),
        await cli([]),
        await cli(['facilitator', 'create', '--email', email], 'curta'),
        await cli(['facilitator', 'create', '--email', email], ''),
        await cli(['facilitator', 'create', '--email', email], `${PASSWORD}\n${PASSWORD}\n`),
        await cli(['facilitator', 'create', '--email', 'sem-arroba'], PASSWORD),
        await cli(['workspace', 'create', '--alias', 'INVALIDO']),
      ];
      for (const run of runs) {
        expect([run.code, run.out]).toEqual([2, '']);
        expect(run.err).not.toContain(PASSWORD);
        expect(run.err).not.toContain(email);
        expect(run.err).not.toMatch(/\n\s+at |Error:|INVALIDO|sem-arroba/);
      }
      expect(await h.db.client.userIdentity.count()).toBe(before);
    });

    it('banco ausente, inacessível ou sem privilégio sai com 1, sem credenciais', async () => {
      const alias = newAlias();
      const args = ['workspace', 'create', '--alias', alias];
      const runs = [
        await cli(args, null, ''),
        await cli(args, null, 'postgresql://usuario:segredo@127.0.0.1:1/banco'),
        await cli(args, null, inject('appDatabaseUrl')),
      ];
      const appPassword = new URL(inject('appDatabaseUrl')).password;
      for (const run of runs) {
        expect([run.code, run.out]).toEqual([1, '']);
        expect(run.err).not.toMatch(/segredo|usuario|postgresql:|INSERT|\n\s+at /);
        expect(run.err).not.toContain(appPassword);
      }
      expect(runs[2]?.err).toContain('42501');
      expect(await workspace(alias)).toBeNull();
    });
  });
});
