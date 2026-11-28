// Política de aprovação, PENDING com credencial de consulta e decisão do facilitador. PactumJS e PostgreSQL real.
import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withAuditFailure } from '../administration/support.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';

const CPF = '529.982.247-25';
const OTHER_CPF = '111.444.777-35';
const HASH = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`;
const sha = (credential: string): string => createHash('sha256').update(credential.replace(/-/g, '')).digest('hex');

describe('política de aprovação e decisão do onboarding (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let f: Person;
  let desk: Browser;
  let ws: { id: string; alias: string };

  const base = (w = ws) => `/facilitator/workspaces/${w.id}`;
  const body = (overrides: Record<string, unknown> = {}) => ({
    alias: ws.alias, name: 'Ana Fictícia', cpf: CPF, birthDate: '1990-05-17', email: `ana-${randomUUID()}@example.test`,
    phone: '(11) 98765-4321', password: PASSWORD, ...overrides,
  });
  async function visitor(): Promise<Browser> {
    const browser = new Browser(server.url);
    await browser.send('GET', '/csrf');
    return browser;
  }
  const submit = async (json: unknown) => (await visitor()).api('POST', '/onboarding/requests', json);
  const consult = async (requestId: unknown, credential: unknown, browser?: Browser) =>
    (browser ?? (await visitor())).api('POST', '/onboarding/requests/status', { requestId, credential });
  const setPolicy = async (mode: 'AUTOMATIC' | 'MANUAL', w = ws) => {
    const current = await desk.api('GET', `${base(w)}/onboarding-policy`);
    return desk.api('PATCH', `${base(w)}/onboarding-policy`, { baseRevision: current.body['revision'], mode });
  };
  const decide = (requestId: string, decision: 'approve' | 'reject', browser = desk, w = ws, headers: Record<string, string> = {}) =>
    browser.api('POST', `${base(w)}/onboarding-requests/${requestId}/${decision}`, undefined, headers);
  const request = (id: string) => h.db.client.onboardingRequest.findUniqueOrThrow({ where: { id } });
  const counts = async () => ({
    identities: await h.db.client.userIdentity.count({ where: { workspaceId: ws.id } }),
    accounts: await h.db.client.account.count({ where: { workspaceId: ws.id } }),
    links: await h.db.client.customerAccount.count({ where: { workspaceId: ws.id } }),
  });

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function newWorkspace(): Promise<{ id: string; alias: string }> {
    const alias = `t-${randomUUID()}`;
    const row = await h.db.client.workspace.create({ data: { alias }, select: { id: true } });
    await h.db.client.workspaceMembership.create({ data: { workspaceId: row.id, identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    return { id: row.id, alias };
  }

  /** PENDING em MANUAL, com a credencial devolvida. */
  async function pendingRequest(overrides: Record<string, unknown> = {}): Promise<{ id: string; credential: string; email: string }> {
    const sent = body(overrides);
    const reply = await submit(sent);
    expect(reply.status).toBe(201);
    return { id: reply.body['requestId'] as string, credential: reply.body['statusCredential'] as string, email: sent.email };
  }

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http', LOGIN_MAX_ATTEMPTS: '3' });
  });

  beforeEach(async () => {
    f = await h.facilitator();
    desk = new Browser(server.url);
    expect((await desk.login(f, PASSWORD)).status).toBe(200);
    ws = await newWorkspace();
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  describe('política', () => {
    it('sem revisão é AUTOMATIC e aprova na submissão; alterações gravam revisões auditadas', async () => {
      expect((await desk.api('GET', `${base()}/onboarding-policy`)).body).toEqual({ workspaceId: ws.id, mode: 'AUTOMATIC', revision: 0 });
      expect((await submit(body())).body).toMatchObject({ status: 'APPROVED' });
      const started = Date.now();
      expect((await setPolicy('MANUAL')).body).toEqual({ workspaceId: ws.id, mode: 'MANUAL', revision: 1 });
      expect((await setPolicy('MANUAL')).body).toEqual({ workspaceId: ws.id, mode: 'MANUAL', revision: 1 });
      expect((await setPolicy('AUTOMATIC')).body).toMatchObject({ mode: 'AUTOMATIC', revision: 2 });
      const rows = await h.db.client.onboardingPolicyRevision.findMany({ where: { workspaceId: ws.id }, orderBy: { revision: 'asc' } });
      expect(rows.map((r) => [r.revision, r.mode, r.createdBy])).toEqual([[1, 'MANUAL', f.id], [2, 'AUTOMATIC', f.id]]);
      rows.forEach((r) => expect(Math.abs(r.createdAt.getTime() - started)).toBeLessThan(60_000));
      const audits = await h.db.client.auditRecord.findMany({ where: { workspaceId: ws.id, operation: 'ONBOARDING_POLICY_CHANGE' } });
      expect(audits.map((a) => [a.actorIdentityId, a.resourceType])).toEqual([[f.id, 'ONBOARDING_POLICY_REVISION'], [f.id, 'ONBOARDING_POLICY_REVISION']]);
    });

    it('base desatualizada 409; corpo inválido 400; arquivado 409; vinte alterações simultâneas: uma vale', async () => {
      await setPolicy('MANUAL');
      problem(await desk.api('PATCH', `${base()}/onboarding-policy`, { baseRevision: 0, mode: 'AUTOMATIC' }), 409, 'ONBOARDING_POLICY_CONFLICT');
      for (const invalid of [{ baseRevision: 1, mode: 'auto' }, { baseRevision: 1 }, { baseRevision: 1, mode: 'MANUAL', revision: 2 }]) {
        problem(await desk.api('PATCH', `${base()}/onboarding-policy`, invalid), 400, 'VALIDATION_ERROR');
      }
      const replies = await Promise.all(Array.from({ length: 20 }, () => desk.api('PATCH', `${base()}/onboarding-policy`, { baseRevision: 1, mode: 'AUTOMATIC' })));
      expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
      replies.filter((r) => r.status !== 200).forEach((r) => problem(r, 409, 'ONBOARDING_POLICY_CONFLICT'));
      await h.db.client.workspace.update({ where: { id: ws.id }, data: { status: 'ARCHIVED' } });
      problem(await setPolicy('MANUAL'), 409, 'WORKSPACE_ARCHIVED');
      expect(await h.db.client.onboardingPolicyRevision.count({ where: { workspaceId: ws.id } })).toBe(2);
    });
  });

  describe('PENDING e consulta', () => {
    it('em MANUAL grava PENDING sem cliente nem login, com a credencial uma única vez (só o hash e 24 h)', async () => {
      await setPolicy('MANUAL');
      const sent = body();
      const reply = await submit(sent);
      expect(reply.status).toBe(201);
      const credential = reply.body['statusCredential'] as string;
      expect(reply.body).toMatchObject({ status: 'PENDING' });
      expect(credential).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
      const row = await request(reply.body['requestId'] as string);
      expect(row).toMatchObject({ status: 'PENDING', identityId: null, decidedAt: null, policyRevision: 1, statusCredentialHash: sha(credential) });
      expect(JSON.stringify(row)).not.toContain(credential);
      const hours = ((row.statusCredentialExpiresAt?.getTime() ?? 0) - row.createdAt.getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(24, 2);
      expect(new Date(reply.body['statusCredentialExpiresAt'] as string).getTime()).toBe(row.statusCredentialExpiresAt?.getTime());
      expect(await counts()).toEqual({ identities: 0, accounts: 0, links: 0 });
      expect((await new Browser(server.url).login({ alias: ws.alias, email: sent.email }, PASSWORD)).status).toBe(401);
      expect(await h.db.client.auditRecord.count({ where: { workspaceId: ws.id, operation: { in: ['ONBOARDING_APPROVE', 'ONBOARDING_REJECT'] } } })).toBe(0);
    });

    it('consulta: certa devolve o estado antes e depois da decisão; errada, alheia, vencida ou inexistente dão o mesmo 404', async () => {
      await setPolicy('MANUAL');
      const first = await pendingRequest();
      const second = await pendingRequest({ cpf: OTHER_CPF });
      const browser = await visitor();
      const ok = await consult(first.id, first.credential.toLowerCase().replace(/-/g, ''), browser);
      expect(ok.body).toEqual({ requestId: first.id, status: 'PENDING' });
      expect(ok.setCookies).toEqual([]);
      expect((await browser.send('GET', '/me')).status).toBe(401);
      await decide(first.id, 'reject');
      expect((await consult(first.id, first.credential)).body).toEqual({ requestId: first.id, status: 'REJECTED' });
      const refusals = [
        await consult(first.id, second.credential),
        await consult(randomUUID(), first.credential),
        await consult('x', first.credential),
        await consult(first.id, 'curta'),
      ];
      // Credencial vencida: solicitação preparada pelo dono com o prazo já no passado.
      const expiredCredential = 'ABCD-EFGH-JKMN-PQRS-TVWX';
      const expired = await h.db.client.onboardingRequest.create({
        data: { workspaceId: ws.id, status: 'PENDING', name: 'Vencida Fictícia', cpf: '12345678909', birthDate: new Date('1990-01-01'),
          email: `vencida-${randomUUID()}@example.test`, phone: '11987654321', passwordHash: HASH, businessDate: new Date('2026-01-01'),
          clockRevision: 0, statusCredentialHash: sha(expiredCredential), statusCredentialExpiresAt: new Date(Date.now() - 1_000) },
      });
      refusals.push(await consult(expired.id, expiredCredential));
      expect((await consult(second.id, second.credential)).body).toMatchObject({ status: 'PENDING' });
      for (const reply of refusals) {
        problem(reply, 404, 'RESOURCE_NOT_FOUND');
        expect(reply.text).not.toMatch(/Ana|example\.test|52998224725/);
      }
      expect(refusals.map((r) => JSON.stringify(Object.keys(r.body).sort()))).toEqual(Array(5).fill(JSON.stringify(['code', 'correlationId', 'status', 'title', 'type'])));
    });

    it('tentativas inválidas repetidas dão 429 com Retry-After, por solicitação', async () => {
      await setPolicy('MANUAL');
      const target = await pendingRequest();
      const other = await pendingRequest({ cpf: OTHER_CPF });
      const wrong = other.credential;
      for (let i = 0; i < 3; i += 1) {
        problem(await consult(target.id, wrong), 404, 'RESOURCE_NOT_FOUND');
      }
      const limited = await consult(target.id, target.credential);
      problem(limited, 429, 'RATE_LIMIT_EXCEEDED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((await consult(other.id, other.credential)).body).toMatchObject({ status: 'PENDING' });
    });

    it('consulta sem CSRF 403', async () => {
      problem(await call(server.url, 'POST', '/api/v1/onboarding/requests/status', { json: { requestId: randomUUID(), credential: 'x' } }), 403, 'CSRF_VALIDATION_FAILED');
    });
  });

  describe('lista do facilitador', () => {
    it('filtra por estado, pagina, mostra só os campos permitidos e nada de outro workspace', async () => {
      await setPolicy('MANUAL');
      const pendings = [await pendingRequest(), await pendingRequest({ cpf: OTHER_CPF })];
      await decide(pendings[1]?.id ?? '', 'reject');
      const other = await newWorkspace();
      await h.db.client.onboardingRequest.create({
        data: { workspaceId: other.id, status: 'PENDING', name: 'Outra Pessoa', cpf: '12345678909', birthDate: new Date('1990-01-01'),
          email: 'outra@example.test', phone: '11987654321', passwordHash: HASH, businessDate: new Date('2026-01-01'), clockRevision: 0 },
      });
      const all = await desk.api('GET', `${base()}/onboarding-requests`);
      expect((all.body['items'] as { requestId: string }[]).map((i) => i.requestId)).toEqual(pendings.map((p) => p.id));
      const [item] = all.body['items'] as Record<string, unknown>[];
      expect(Object.keys(item ?? {}).sort()).toEqual(['businessDate', 'createdAt', 'decidedAt', 'email', 'name', 'requestId', 'status']);
      expect(item).toMatchObject({ status: 'PENDING', name: 'Ana Fictícia', email: pendings[0]?.email, decidedAt: null });
      expect(all.text).not.toMatch(/52998224725|11144477735|98765|argon2|Outra Pessoa/);
      const onlyPending = await desk.api('GET', `${base()}/onboarding-requests?status=PENDING`);
      expect((onlyPending.body['items'] as unknown[]).length).toBe(1);
      const page = await desk.api('GET', `${base()}/onboarding-requests?limit=1`);
      expect(page.body['nextOffset']).toBe(1);
      for (const query of ['status=pending', 'status=PENDING&status=REJECTED', 'x=1', 'limit=0']) {
        problem(await desk.api('GET', `${base()}/onboarding-requests?${query}`), 400, 'VALIDATION_ERROR');
      }
    });

    it('PENDING antiga da DEV-027, sem credencial, aparece e pode ser aprovada', async () => {
      const email = `antiga-${randomUUID()}@example.test`;
      const old = await h.db.client.onboardingRequest.create({
        data: { workspaceId: ws.id, status: 'PENDING', name: 'Antiga Fictícia', cpf: '52998224725', birthDate: new Date('1990-01-01'),
          email, phone: '11987654321', passwordHash: HASH,
          businessDate: new Date('2026-01-01'), clockRevision: 0 },
      });
      expect((await desk.api('GET', `${base()}/onboarding-requests?status=PENDING`)).body['items']).toMatchObject([{ requestId: old.id }]);
      expect((await decide(old.id, 'approve')).body).toEqual({ workspaceId: ws.id, requestId: old.id, status: 'APPROVED' });
      expect(await request(old.id)).toMatchObject({ status: 'APPROVED', statusCredentialHash: null });
      expect(await counts()).toEqual({ identities: 1, accounts: 1, links: 1 });
    });
  });

  describe('decisão', () => {
    it('aprovar cria cliente, senha, conta zerada e vínculo; o login funciona; auditoria do facilitador', async () => {
      await setPolicy('MANUAL');
      const pending = await pendingRequest();
      const reply = await decide(pending.id, 'approve');
      expect(reply.body).toEqual({ workspaceId: ws.id, requestId: pending.id, status: 'APPROVED' });
      const row = await request(pending.id);
      expect(row.status).toBe('APPROVED');
      const link = await h.db.client.customerAccount.findUniqueOrThrow({ where: { identityId: row.identityId ?? '' } });
      expect(await h.db.client.account.findUniqueOrThrow({ where: { id: link.accountId } })).toMatchObject({ kind: 'STANDARD', balanceCents: 0n });
      const login = await new Browser(server.url).login({ alias: ws.alias, email: pending.email }, PASSWORD);
      expect(login.status).toBe(200);
      const [audit] = await h.db.client.auditRecord.findMany({ where: { workspaceId: ws.id, operation: 'ONBOARDING_APPROVE' } });
      expect(audit).toMatchObject({ actorType: 'IDENTITY', actorIdentityId: f.id, actorProfile: 'FACILITATOR', resourceId: pending.id });
      expect(JSON.stringify(audit)).not.toMatch(/Ana|example\.test|52998224725/);
    });

    it('rejeitar libera CPF e e-mail; repetir devolve o estado; a decisão oposta é 409', async () => {
      await setPolicy('MANUAL');
      const pending = await pendingRequest();
      expect((await decide(pending.id, 'reject')).body).toMatchObject({ status: 'REJECTED' });
      expect((await decide(pending.id, 'reject')).body).toMatchObject({ status: 'REJECTED' });
      problem(await decide(pending.id, 'approve'), 409, 'ONBOARDING_ALREADY_DECIDED');
      expect(await counts()).toEqual({ identities: 0, accounts: 0, links: 0 });
      expect(await h.db.client.auditRecord.count({ where: { workspaceId: ws.id, operation: 'ONBOARDING_REJECT' } })).toBe(1);
      await setPolicy('AUTOMATIC');
      expect((await submit(body({ email: pending.email }))).body).toMatchObject({ status: 'APPROVED' });
    });

    it('vinte decisões simultâneas, metade aprovar e metade rejeitar: exatamente uma vale', async () => {
      await setPolicy('MANUAL');
      const pending = await pendingRequest();
      const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => decide(pending.id, i % 2 === 0 ? 'approve' : 'reject')));
      const final = (await request(pending.id)).status;
      for (const reply of replies) {
        if (reply.status === 200) {
          expect(reply.body['status']).toBe(final);
        } else {
          problem(reply, 409, 'ONBOARDING_ALREADY_DECIDED');
        }
      }
      expect(await h.db.client.auditRecord.count({ where: { workspaceId: ws.id, operation: { in: ['ONBOARDING_APPROVE', 'ONBOARDING_REJECT'] } } })).toBe(1);
      expect((await counts()).identities).toBe(final === 'APPROVED' ? 1 : 0);
    });

    it('falha injetada na aprovação ou na auditoria mantém PENDING sem nada criado', async () => {
      await setPolicy('MANUAL');
      const pending = await pendingRequest();
      await h.db.client.$executeRawUnsafe(`
        CREATE FUNCTION "test_decision_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."workspace_id" = '${ws.id}'::uuid THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END $$`);
      await h.db.client.$executeRawUnsafe('CREATE TRIGGER "test_decision_failure" BEFORE INSERT ON "customer_account" FOR EACH ROW EXECUTE FUNCTION "test_decision_failure"()');
      try {
        problem(await decide(pending.id, 'approve'), 503, 'TEMPORARY_UNAVAILABLE');
      } finally {
        await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_decision_failure"() CASCADE');
      }
      await withAuditFailure(h, 'ONBOARDING_REJECT', async () => {
        problem(await decide(pending.id, 'reject'), 503, 'TEMPORARY_UNAVAILABLE');
      });
      expect(await request(pending.id)).toMatchObject({ status: 'PENDING', identityId: null, decidedAt: null });
      expect(await counts()).toEqual({ identities: 0, accounts: 0, links: 0 });
      expect((await decide(pending.id, 'approve')).body).toMatchObject({ status: 'APPROVED' });
    });

    it('e-mail tomado por cliente da CLI: 409 e a solicitação continua PENDING', async () => {
      await setPolicy('MANUAL');
      const pending = await pendingRequest();
      await h.db.client.userIdentity.create({ data: { profile: 'CUSTOMER', status: 'ACTIVE', email: pending.email, workspaceId: ws.id } });
      const reply = await decide(pending.id, 'approve');
      problem(reply, 409, 'ONBOARDING_DUPLICATE');
      expect(reply.body['errors']).toEqual([{ field: 'email' }]);
      expect((await request(pending.id)).status).toBe('PENDING');
      expect((await decide(pending.id, 'reject')).body).toMatchObject({ status: 'REJECTED' });
    });
  });

  describe('acesso', () => {
    it('cliente 403, sem sessão 401, sem CSRF 403, alheio e malformado 404, arquivado 409', async () => {
      await setPolicy('MANUAL');
      const pending = await pendingRequest();
      const other = await newWorkspace();
      const customer = await h.customer();
      const customerBrowser = new Browser(server.url);
      await customerBrowser.login(customer, PASSWORD);
      problem(await decide(pending.id, 'approve', customerBrowser), 403, 'ACCESS_DENIED');
      problem(await call(server.url, 'GET', `/api/v1${base()}/onboarding-requests`), 401, 'AUTH_SESSION_REQUIRED');
      problem(await decide(pending.id, 'approve', desk, ws, { 'x-csrf-token': '' }), 403, 'CSRF_VALIDATION_FAILED');
      problem(await decide(pending.id, 'approve', desk, other), 404, 'RESOURCE_NOT_FOUND');
      for (const id of [randomUUID(), 'x']) {
        problem(await decide(id, 'reject'), 404, 'RESOURCE_NOT_FOUND');
      }
      const stranger = await h.facilitator();
      const strangerBrowser = new Browser(server.url);
      await strangerBrowser.login(stranger, PASSWORD);
      problem(await decide(pending.id, 'approve', strangerBrowser), 404, 'RESOURCE_NOT_FOUND');
      await h.db.client.workspace.update({ where: { id: ws.id }, data: { status: 'ARCHIVED' } });
      problem(await decide(pending.id, 'approve'), 409, 'WORKSPACE_ARCHIVED');
      expect((await request(pending.id)).status).toBe('PENDING');
    });
  });

  describe('banco', () => {
    it('decisão só uma vez, só de PENDING, sem alterar dados; sem apagar; credencial coerente', async () => {
      await setPolicy('MANUAL');
      const pending = await pendingRequest();
      await decide(pending.id, 'reject');
      expect(await sqlState(h.app.client.$executeRaw`UPDATE "onboarding_request" SET "status" = 'APPROVED' WHERE "id" = ${pending.id}::uuid`)).toBe('23001');
      expect(await sqlState(h.db.client.$executeRaw`UPDATE "onboarding_request" SET "name" = 'Outro Nome' WHERE "id" = ${pending.id}::uuid`)).toBe('23001');
      const fresh = await pendingRequest({ cpf: OTHER_CPF });
      expect(await sqlState(h.app.client.$executeRaw`UPDATE "onboarding_request" SET "status" = 'PENDING' WHERE "id" = ${fresh.id}::uuid`)).toBe('23001');
      expect(await sqlState(h.db.client.$executeRaw`DELETE FROM "onboarding_request" WHERE "id" = ${fresh.id}::uuid`)).toBe('23001');
      expect(await sqlState(h.app.client.$executeRaw`
        INSERT INTO "onboarding_request" ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision", "status_credential_hash")
        VALUES (${ws.id}::uuid, 'PENDING', 'Ana Fictícia', '12345678909', DATE '1990-01-01', ${`z-${randomUUID()}@example.test`}, '11987654321', ${HASH}, DATE '2026-01-01', 0, ${'a'.repeat(64)})`)).toBe('23514');
    });
  });
});
