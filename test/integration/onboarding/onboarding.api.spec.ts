// Solicitação de abertura por HTTP: PactumJS e PostgreSQL real.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityError } from '../../../src/identity/domain/errors.js';
import { PrismaOnboardingStore } from '../../../src/onboarding/adapters/prisma-onboarding.store.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';
import { Browser, call, type Reply, startApp } from '../authentication/http-support.js';
import { type AuthHarness, authHarness, PASSWORD, type Person } from '../authentication/support.js';
import { sqlState } from '../payment-execution/support.js';

const ARGON2ID = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;
// CPFs sintéticos de teste com dígitos verificadores válidos.
const CPF = '529.982.247-25';
const CPF_DIGITS = '52998224725';
const OTHER_CPF = '111.444.777-35';

describe('onboarding (PactumJS, PostgreSQL real)', () => {
  let h: AuthHarness;
  let server: { app: NestExpressApplication; url: string };
  let ws: Person;
  let f: Person;
  let desk: Browser;

  const requests = (p: Person = ws) =>
    h.db.client.onboardingRequest.findMany({ where: { workspaceId: p.workspaceId ?? '' }, orderBy: { createdAt: 'asc' } });
  const body = (p: Person = ws, overrides: Record<string, unknown> = {}) => ({
    alias: p.alias, name: 'Ana Fictícia', cpf: CPF, birthDate: '1990-05-17', email: `ana-${randomUUID()}@example.test`,
    phone: '(11) 98765-4321', password: PASSWORD, ...overrides,
  });

  /** Visitante: contexto pré-autenticado com token CSRF, sem sessão. */
  async function visitor(): Promise<Browser> {
    const browser = new Browser(server.url);
    expect((await browser.send('GET', '/csrf')).status).toBe(200);
    return browser;
  }
  const submit = async (json: unknown, browser?: Browser, headers: Record<string, string> = {}) =>
    (browser ?? (await visitor())).api('POST', '/onboarding/requests', json, headers);

  function problem(reply: Reply, status: number, code: string): void {
    expect({ status: reply.status, code: reply.body['code'] }).toEqual({ status, code });
  }

  async function workspace(modality: 'SHARED' | 'ISOLATED' = 'ISOLATED'): Promise<Person> {
    const created = await h.db.client.workspace.create({ data: { alias: `t-${randomUUID()}`, modality }, select: { id: true, alias: true } });
    await h.db.client.workspaceMembership.create({ data: { workspaceId: created.id, identityId: f.id, role: 'FACILITATOR', status: 'ACTIVE' } });
    return { ...f, workspaceId: created.id, alias: created.alias };
  }
  const setClock = async (p: Person, date: string) => {
    const base = (await desk.api('GET', `/facilitator/workspaces/${p.workspaceId}/clock`)).body['revision'];
    expect((await desk.api('PATCH', `/facilitator/workspaces/${p.workspaceId}/clock`, { baseRevision: base, date })).status).toBe(200);
  };
  const issueCode = async (p: Person) => (await desk.api('POST', `/facilitator/workspaces/${p.workspaceId}/enrollment-code`)).body['code'] as string;

  beforeAll(async () => {
    h = await authHarness();
    server = await startApp({ COOKIE_TRANSPORT: 'local-http', LOGIN_MAX_ATTEMPTS: '3' });
  });

  beforeEach(async () => {
    f = await h.facilitator();
    desk = new Browser(server.url);
    expect((await desk.login(f, PASSWORD)).status).toBe(200);
    ws = await workspace();
  });

  afterAll(async () => {
    await server?.app.close();
    await h?.close();
  });

  it('solicitação válida grava PENDING normalizada, com hash Argon2id, data simulada, revisão e instante real', async () => {
    await setClock(ws, '2027-03-15');
    const started = Date.now();
    const browser = await visitor();
    const sent = body(ws, { name: '  Ana   Fictícia ', email: 'Ana.Ficticia@Example.TEST', phone: '+55 (11) 98765-4321' });
    const reply = await submit(sent, browser);
    expect(reply.status).toBe(201);
    expect(Object.keys(reply.body).sort()).toEqual(['requestId', 'status']);
    expect(reply.body['status']).toBe('PENDING');
    const [row] = await requests();
    expect(row).toMatchObject({
      id: reply.body['requestId'], status: 'PENDING', name: 'Ana Fictícia', cpf: CPF_DIGITS, email: 'ana.ficticia@example.test',
      phone: '11987654321', clockRevision: 1,
    });
    expect(row?.passwordHash).toMatch(ARGON2ID);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(row?.birthDate.toISOString().slice(0, 10)).toBe('1990-05-17');
    expect(row?.businessDate.toISOString().slice(0, 10)).toBe('2027-03-15');
    expect(Math.abs((row?.createdAt.getTime() ?? 0) - started)).toBeLessThan(60_000);
    expect(reply.setCookies).toEqual([]);
    expect((await browser.send('GET', '/me')).status).toBe(401);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['CPF com verificador errado', { cpf: '529.982.247-24' }, ['cpf']],
    ['CPF repetido', { cpf: '111.111.111-11' }, ['cpf']],
    ['CPF curto', { cpf: '5299822472' }, ['cpf']],
    ['nascimento inexistente', { birthDate: '1990-02-30' }, ['birthDate']],
    ['nascimento antes de 1900', { birthDate: '1899-12-31' }, ['birthDate']],
    ['nascimento em outro formato', { birthDate: '17/05/1990' }, ['birthDate']],
    ['telefone sem DDD', { phone: '98765-4321' }, ['phone']],
    ['telefone de outro país', { phone: '+1 212 555 0100' }, ['phone']],
    ['e-mail sem arroba', { email: 'ana.example.test' }, ['email']],
    ['nome curto', { name: 'A' }, ['name']],
    ['nome com controle', { name: 'Ana\u0000Maria' }, ['name']],
    ['senha curta', { password: 'curta' }, ['password']],
    ['tipo errado', { cpf: 52998224725 }, ['cpf']],
    ['vários campos', { cpf: '52998224724', phone: 'x', password: 'curta' }, ['cpf', 'phone', 'password']],
  ])('%s: 400 com o campo, sem eco e sem gravar', async (_label, overrides, fields) => {
    const reply = await submit(body(ws, overrides));
    problem(reply, 400, 'VALIDATION_ERROR');
    expect(reply.body['errors']).toEqual(fields.map((field) => ({ field })));
    for (const value of Object.values(overrides)) {
      if (typeof value === 'string' && value.length > 3) {
        expect(reply.text).not.toContain(value);
      }
    }
    expect(await requests()).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['campo extra', { status: 'APPROVED' }], ['workspace forjado', { workspaceId: randomUUID() }],
  ])('%s: 400 sem gravar', async (_label, extra) => {
    problem(await submit({ ...body(), ...(extra as object) }), 400, 'VALIDATION_ERROR');
    problem(await submit([]), 400, 'VALIDATION_ERROR');
    expect(await requests()).toEqual([]);
  });

  describe('idade pela data simulada', () => {
    it('exatamente 18 anos é aceito; um dia a menos é 422; nascimento no futuro simulado é 400', async () => {
      await setClock(ws, '2027-06-10');
      problem(await submit(body(ws, { birthDate: '2009-06-11' })), 422, 'ONBOARDING_UNDERAGE');
      problem(await submit(body(ws, { birthDate: '2027-06-11' })), 400, 'VALIDATION_ERROR');
      expect((await submit(body(ws, { birthDate: '2009-06-10' }))).status).toBe(201);
    });

    it('29 de fevereiro: completa a idade em 1º de março no ano não bissexto', async () => {
      await setClock(ws, '2026-02-28');
      problem(await submit(body(ws, { birthDate: '2008-02-29' })), 422, 'ONBOARDING_UNDERAGE');
      await setClock(ws, '2026-03-01');
      expect((await submit(body(ws, { birthDate: '2008-02-29' }))).status).toBe(201);
    });

    it('mudar o relógio afeta as solicitações seguintes, não as gravadas', async () => {
      await setClock(ws, '2030-01-01');
      expect((await submit(body(ws, { birthDate: '2011-12-31' }))).status).toBe(201);
      await setClock(ws, '2020-01-01');
      problem(await submit(body(ws, { birthDate: '2011-12-31', cpf: OTHER_CPF })), 422, 'ONBOARDING_UNDERAGE');
      const rows = await requests();
      expect(rows.map((r) => [r.status, r.businessDate.toISOString().slice(0, 10), r.clockRevision])).toEqual([['PENDING', '2030-01-01', 1]]);
    });
  });

  describe('unicidade por workspace', () => {
    it('CPF (com ou sem máscara) ou e-mail repetido dá 409 com o campo, sem eco', async () => {
      const first = body();
      expect((await submit(first)).status).toBe(201);
      const cpf = await submit(body(ws, { cpf: CPF_DIGITS }));
      problem(cpf, 409, 'ONBOARDING_DUPLICATE');
      expect(cpf.body['errors']).toEqual([{ field: 'cpf' }]);
      const email = await submit(body(ws, { cpf: OTHER_CPF, email: first.email.toUpperCase() }));
      expect(email.body['errors']).toEqual([{ field: 'email' }]);
      const both = await submit({ ...first });
      expect(both.body['errors']).toEqual([{ field: 'cpf' }, { field: 'email' }]);
      expect(`${cpf.text}${email.text}${both.text}`).not.toMatch(new RegExp(`${CPF_DIGITS}|${first.email}`, 'i'));
      expect(await requests()).toHaveLength(1);
    });

    it('os mesmos dados são aceitos em outro workspace', async () => {
      const sent = body();
      expect((await submit(sent)).status).toBe(201);
      const other = await workspace();
      expect((await submit({ ...sent, alias: other.alias })).status).toBe(201);
    });

    it('solicitação REJECTED libera CPF e e-mail', async () => {
      const sent = body();
      await submit(sent);
      await h.db.client.onboardingRequest.updateMany({ where: { workspaceId: ws.workspaceId ?? '' }, data: { status: 'REJECTED' } });
      expect((await submit(sent)).status).toBe(201);
      expect((await requests()).map((r) => r.status)).toEqual(['REJECTED', 'PENDING']);
    });

    it('e-mail de cliente existente no workspace também é recusado', async () => {
      const customer = await h.customer();
      const reply = await submit(body({ ...ws, workspaceId: customer.workspaceId, alias: customer.alias }, { email: customer.email }));
      problem(reply, 409, 'ONBOARDING_DUPLICATE');
      expect(reply.body['errors']).toEqual([{ field: 'email' }]);
    });

    it.each(['cpf', 'email'] as const)('vinte submissões simultâneas com o mesmo %s gravam uma', async (field) => {
      const shared = body();
      const replies = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          submit(field === 'cpf' ? { ...shared, email: `p${i}-${randomUUID()}@example.test` } : { ...shared, cpf: i === 0 ? CPF : OTHER_CPF }),
        ),
      );
      const created = replies.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);
      for (const reply of replies.filter((r) => r.status !== 201)) {
        problem(reply, 409, 'ONBOARDING_DUPLICATE');
        expect(reply.body['errors']).toContainEqual({ field });
      }
      expect(await requests()).toHaveLength(1);
    });
  });

  describe('código de inscrição', () => {
    it('SHARED: sem código vigente 422 REQUIRED; código errado 422 INVALID; certo aceito', async () => {
      const shared = await workspace('SHARED');
      problem(await submit(body(shared)), 422, 'ENROLLMENT_CODE_REQUIRED');
      problem(await submit(body(shared, { enrollmentCode: 'AB12-CD34-EF56' })), 422, 'ENROLLMENT_CODE_INVALID');
      const code = await issueCode(shared);
      problem(await submit(body(shared)), 422, 'ENROLLMENT_CODE_REQUIRED');
      problem(await submit(body(shared, { enrollmentCode: 'AB12-CD34-EF56' })), 422, 'ENROLLMENT_CODE_INVALID');
      const accepted = await submit(body(shared, { enrollmentCode: code.toLowerCase().replace(/-/g, '') }));
      expect(accepted.status).toBe(201);
      expect(accepted.text).not.toContain(code);
    });

    it('ISOLATED sem código vigente aceita sem código; com código vigente, passa a exigir', async () => {
      expect((await submit(body())).status).toBe(201);
      const code = await issueCode(ws);
      problem(await submit(body(ws, { cpf: OTHER_CPF })), 422, 'ENROLLMENT_CODE_REQUIRED');
      expect((await submit(body(ws, { cpf: OTHER_CPF, enrollmentCode: code }))).status).toBe(201);
    });

    it('códigos inválidos repetidos levam a 429 com Retry-After, por alias e e-mail', async () => {
      const shared = await workspace('SHARED');
      const code = await issueCode(shared);
      const sent = body(shared, { enrollmentCode: 'AB12-CD34-EF56' });
      for (let i = 0; i < 3; i += 1) {
        problem(await submit(sent), 422, 'ENROLLMENT_CODE_INVALID');
      }
      const limited = await submit({ ...sent, enrollmentCode: code });
      problem(limited, 429, 'RATE_LIMIT_EXCEEDED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Outra pessoa da turma não é afetada.
      expect((await submit(body(shared, { cpf: OTHER_CPF, enrollmentCode: code }))).status).toBe(201);
      expect((await requests(shared)).map((r) => r.cpf)).toEqual(['11144477735']);
    });
  });

  describe('acesso e contexto', () => {
    it('alias inexistente 404; workspace arquivado 409; sem CSRF 403; não exige nem abre sessão', async () => {
      problem(await submit(body({ ...ws, alias: `t-${randomUUID()}` })), 404, 'RESOURCE_NOT_FOUND');
      await h.db.client.workspace.update({ where: { id: ws.workspaceId ?? '' }, data: { status: 'ARCHIVED' } });
      problem(await submit(body()), 409, 'WORKSPACE_ARCHIVED');
      problem(await call(server.url, 'POST', '/api/v1/onboarding/requests', { json: body() }), 403, 'CSRF_VALIDATION_FAILED');
      problem(await submit(body(), await visitor(), { 'x-csrf-token': 'x'.repeat(43) }), 403, 'CSRF_VALIDATION_FAILED');
      expect(await requests()).toEqual([]);
    });

    // Sessão restrita: coberta para toda rota do contrato em administration/recovery.api.spec.ts.
    it('com sessão normal, vale o token da sessão e ela continua a mesma', async () => {
      const customer = await h.customer();
      const browser = new Browser(server.url);
      await browser.login(customer, PASSWORD);
      const reply = await submit(body(), browser);
      expect(reply.status).toBe(201);
      expect(reply.setCookies).toEqual([]);
      expect((await browser.send('GET', '/me')).body).toMatchObject({ identityId: customer.id });
    });
  });

  it('nada pessoal em respostas de erro; banco inacessível é falha tipada e sanitizada', async () => {
    const replies = [
      await submit(body(ws, { birthDate: '2020-01-01' })),
      await submit(body(ws, { cpf: '52998224724', email: 'x@y' })),
    ];
    for (const reply of replies) {
      expect(reply.text).not.toMatch(/Ana|Fict|52998224|98765|senha de teste/);
    }
    const down = new PrismaService({ databaseUrl: 'postgresql://usuario:segredo@127.0.0.1:1/banco' });
    try {
      const error = (await new PrismaOnboardingStore(down.client).findWorkspace('turma').catch((e: unknown) => e)) as IdentityError;
      expect(error).toMatchObject({ name: 'IdentityError', code: 'ACCESS_CHECK_FAILED' });
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
    } finally {
      await down.onModuleDestroy();
    }
  });

  it('no banco: formatos e unicidade garantidos também para inserção direta', async () => {
    const insert = (cpf: string, phone: string, hash: string, status = 'PENDING', email = `x-${randomUUID()}@example.test`) =>
      sqlState(h.app.client.$executeRaw`
        INSERT INTO "onboarding_request" ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision")
        VALUES (${ws.workspaceId}::uuid, ${status}::"onboarding_status", 'Ana Fictícia', ${cpf}, DATE '1990-01-01', ${email}, ${phone}, ${hash},
                DATE '2026-01-01', 0)`);
    const hash = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`;
    expect(await insert('5299822472a', '11987654321', hash)).toBe('23514');
    expect(await insert('529.982.247-25', '11987654321', hash)).toBe('22001');
    expect(await insert(CPF_DIGITS, '01987654321', hash)).toBe('23514');
    expect(await insert(CPF_DIGITS, '11987654321', PASSWORD)).toBe('23514');
    await h.app.client.$executeRaw`
      INSERT INTO "onboarding_request" ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision")
      VALUES (${ws.workspaceId}::uuid, 'PENDING', 'Ana Fictícia', ${CPF_DIGITS}, DATE '1990-01-01', 'unico@example.test', '11987654321', ${hash}, DATE '2026-01-01', 0)`;
    expect(await insert(CPF_DIGITS, '11987654321', hash)).toBe('23505');
    expect(await insert(OTHER_CPF.replace(/\D/g, ''), '11987654321', hash, 'PENDING', 'unico@example.test')).toBe('23505');
    await h.app.client.$executeRaw`
      INSERT INTO "onboarding_request" ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision")
      VALUES (${ws.workspaceId}::uuid, 'REJECTED', 'Ana Fictícia', ${CPF_DIGITS}, DATE '1990-01-01', 'unico@example.test', '11987654321', ${hash}, DATE '2026-01-01', 0)`;
    expect(await requests()).toHaveLength(2);
  });
});
