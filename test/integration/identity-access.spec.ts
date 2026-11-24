// Vínculos e consulta de acesso em PostgreSQL real: dados preparados pelo dono, consulta pela execução.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaWorkspaceAccessReader } from '../../src/identity/adapters/prisma-workspace-access.reader.js';
import { WorkspaceAccessService } from '../../src/identity/application/workspace-access.service.js';
import { normalizeEmail } from '../../src/identity/domain/email.js';
import { IdentityError } from '../../src/identity/domain/errors.js';
import { databaseErrorCode } from '../../src/persistence/database-errors.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';
import { type Harness, harness, newWorkspace, settle, sqlState } from './payment-execution/support.js';

describe('identidade e vínculo com workspace', () => {
  let h: Harness;
  let access: WorkspaceAccessService;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'), inject('appDatabaseUrl'));
    access = new WorkspaceAccessService(new PrismaWorkspaceAccessReader(h.app.client));
  });

  afterAll(async () => {
    await h?.close();
  });

  let sequence = 0;
  const newEmail = (): string => `pessoa-${(sequence += 1)}-${randomUUID()}@example.test`;

  async function customer(workspaceId: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE', email = newEmail()): Promise<string> {
    const data = { workspaceId, status, email, profile: 'CUSTOMER' as const };
    return (await h.db.client.userIdentity.create({ data, select: { id: true } })).id;
  }

  async function facilitator(status: 'ACTIVE' | 'DISABLED' = 'ACTIVE', email = newEmail()): Promise<string> {
    const data = { status, email, profile: 'FACILITATOR' as const };
    return (await h.db.client.userIdentity.create({ data, select: { id: true } })).id;
  }

  async function link(workspaceId: string, identityId: string, status: 'ACTIVE' | 'REVOKED' = 'ACTIVE'): Promise<void> {
    await h.db.client.workspaceMembership.create({ data: { workspaceId, identityId, role: 'FACILITATOR', status } });
  }

  async function denial(identityId: string, workspaceId: string): Promise<IdentityError> {
    const error = await access.resolve(identityId, workspaceId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityError);
    return error as IdentityError;
  }

  async function expectDenied(identityId: string, workspaceId: string): Promise<void> {
    const error = await denial(identityId, workspaceId);
    expect({ code: error.code, message: error.message, technical: error.technicalCode, cause: error.cause }).toEqual({
      code: 'ACCESS_DENIED',
      message: 'Acesso negado ao workspace.',
      technical: undefined,
      cause: undefined,
    });
  }

  describe('consulta', () => {
    it('cliente acessa o próprio workspace e facilitador, o workspace vinculado', async () => {
      const ws = await newWorkspace(h);
      const [c, f] = [await customer(ws), await facilitator()];
      await link(ws, f);
      expect(await access.resolve(c, ws)).toEqual({ identityId: c, workspaceId: ws, role: 'CUSTOMER' });
      expect(await access.resolve(f, ws)).toEqual({ identityId: f, workspaceId: ws, role: 'FACILITATOR' });
    });

    it('nega identidade inexistente, workspace inexistente e ausência de vínculo, sem distinção', async () => {
      const ws = await newWorkspace(h);
      const [c, f] = [await customer(ws), await facilitator()];
      await expectDenied(randomUUID(), ws);
      await expectDenied(c, randomUUID());
      await expectDenied(f, randomUUID());
      await expectDenied(f, ws);
    });

    it('nega identidade desativada e vínculo revogado', async () => {
      const ws = await newWorkspace(h);
      await expectDenied(await customer(ws, 'DISABLED'), ws);
      const disabled = await facilitator('DISABLED');
      await link(ws, disabled);
      await expectDenied(disabled, ws);
      const revoked = await facilitator();
      await link(ws, revoked, 'REVOKED');
      await expectDenied(revoked, ws);
    });

    it('revogar e desativar valem na consulta seguinte', async () => {
      const ws = await newWorkspace(h);
      const [c, f] = [await customer(ws), await facilitator()];
      await link(ws, f);
      const key = { workspaceId_identityId: { workspaceId: ws, identityId: f } };
      await access.resolve(f, ws);
      await h.db.client.workspaceMembership.update({ where: key, data: { status: 'REVOKED' } });
      await expectDenied(f, ws);
      await h.db.client.workspaceMembership.update({ where: key, data: { status: 'ACTIVE' } });
      for (const id of [c, f]) {
        await access.resolve(id, ws);
        await h.db.client.userIdentity.update({ where: { id }, data: { status: 'DISABLED' } });
        await expectDenied(id, ws);
      }
    });

    it('cliente e facilitador de um workspace não acessam o outro', async () => {
      const [wsA, wsB] = [await newWorkspace(h), await newWorkspace(h)];
      const [ca, cb] = [await customer(wsA), await customer(wsB)];
      const [fa, fb] = [await facilitator(), await facilitator()];
      await link(wsA, fa);
      await link(wsB, fb);
      for (const [id, own, other] of [[ca, wsA, wsB], [cb, wsB, wsA], [fa, wsA, wsB], [fb, wsB, wsA]] as const) {
        expect((await access.resolve(id, own)).workspaceId).toBe(own);
        await expectDenied(id, other);
      }
    });

    it('revogar um vínculo do facilitador não afeta os demais', async () => {
      const [wsA, wsB] = [await newWorkspace(h), await newWorkspace(h)];
      const f = await facilitator();
      await link(wsA, f);
      await link(wsB, f, 'REVOKED');
      expect((await access.resolve(f, wsA)).role).toBe('FACILITATOR');
      await expectDenied(f, wsB);
    });

    it('banco indisponível é falha tipada, distinta da negação e sanitizada', async () => {
      const unreachable = new PrismaService({ databaseUrl: 'postgresql://usuario:segredo@127.0.0.1:1/banco' });
      try {
        const service = new WorkspaceAccessService(new PrismaWorkspaceAccessReader(unreachable.client));
        const error = (await service.resolve(randomUUID(), randomUUID()).catch((e: unknown) => e)) as IdentityError;
        expect(error).toBeInstanceOf(IdentityError);
        expect(error.code).toBe('ACCESS_CHECK_FAILED');
        expect(error.message).toBe('Falha ao verificar o acesso ao workspace.');
        expect(error.cause).toBeUndefined();
        expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(/segredo|usuario|127\.0\.0\.1/);
      } finally {
        await unreachable.onModuleDestroy();
      }
    });
  });

  describe('integridade no banco (dono do esquema)', () => {
    const sql = (statement: string, ...values: (string | null)[]) => h.db.client.$executeRawUnsafe(statement, ...values);
    const LINK = 'INSERT INTO "workspace_membership" ("workspace_id", "identity_id", "role", "status") VALUES ($1::uuid, $2::uuid, ';
    const IDENTITY = 'INSERT INTO "user_identity" ("profile", "workspace_id", "email", "status") VALUES ';
    const create = (profile: string, workspaceId: string | null, email: string) =>
      sql(`${IDENTITY}('${profile}', $1::uuid, $2, 'ACTIVE')`, workspaceId, email);

    it('cliente exige um workspace existente e facilitador não tem workspace próprio', async () => {
      const ws = await newWorkspace(h);
      expect(await sqlState(create('CUSTOMER', null, newEmail()))).toBe('23514');
      expect(await sqlState(create('CUSTOMER', randomUUID(), newEmail()))).toBe('23503');
      expect(await sqlState(create('FACILITATOR', ws, newEmail()))).toBe('23514');
      expect(await sqlState(create('STUDENT', null, newEmail()))).toBe('22P02');
    });

    it('perfil, e-mail e estado são obrigatórios e sem valor padrão', async () => {
      expect(await sqlState(sql(`${IDENTITY}(DEFAULT, NULL, 'a@b', 'ACTIVE')`))).toBe('23502');
      expect(await sqlState(sql(`${IDENTITY}('FACILITATOR', NULL, DEFAULT, 'ACTIVE')`))).toBe('23502');
      expect(await sqlState(sql(`${IDENTITY}('FACILITATOR', NULL, 'a@b', DEFAULT)`))).toBe('23502');
      expect(await sqlState(sql(`${IDENTITY}('FACILITATOR', NULL, 'a@b', 'PENDING')`))).toBe('22P02');
    });

    it.each(['Ana@example.test', ' ana@example.test', 'ana@example.test ', 'ana', '@b', 'a@', 'a@b@c', 'a b@c', 'josé@b', 'ana@b\n', ''])(
      'recusa e-mail não normalizado: %j',
      async (email) => {
        expect(await sqlState(create('FACILITATOR', null, email))).toBe('23514');
      },
    );

    it('aceita no banco a forma produzida pela normalização e recusa acima do limite', async () => {
      const ws = await newWorkspace(h);
      for (const raw of ['  [X]_^`{|}~+A.b@Example.TEST ', `${'A'.repeat(252)}@b`]) {
        await create('CUSTOMER', ws, normalizeEmail(raw));
      }
      expect(await sqlState(create('CUSTOMER', ws, `${'a'.repeat(253)}@b`))).toBe('22001');
    });

    it('e-mail de cliente é único por workspace e pode repetir em outro', async () => {
      const [wsA, wsB] = [await newWorkspace(h), await newWorkspace(h)];
      const email = newEmail();
      await create('CUSTOMER', wsA, email);
      await create('CUSTOMER', wsB, email);
      expect(await sqlState(create('CUSTOMER', wsA, email))).toBe('23505');
    });

    it('e-mail de facilitador é único entre facilitadores e independe dos clientes', async () => {
      const ws = await newWorkspace(h);
      const email = newEmail();
      await create('CUSTOMER', ws, email);
      await create('FACILITATOR', null, email);
      expect(await sqlState(create('FACILITATOR', null, email))).toBe('23505');
    });

    it.each(['CUSTOMER', 'FACILITATOR'])('inserções paralelas do mesmo e-mail: um único sucesso (%s)', async (profile) => {
      const ws = profile === 'CUSTOMER' ? await newWorkspace(h) : null;
      const email = newEmail();
      const { ok, errors } = await settle(Array.from({ length: 8 }, () => create(profile, ws, email)));
      expect(ok).toHaveLength(1);
      expect(errors.map((e) => databaseErrorCode(e))).toEqual(Array.from({ length: 7 }, () => '23505'));
      expect(await h.db.client.userIdentity.count({ where: { email } })).toBe(1);
    });

    it('identificador, perfil e workspace da identidade são imutáveis; e-mail e estado podem mudar', async () => {
      const [wsA, wsB] = [await newWorkspace(h), await newWorkspace(h)];
      const c = await customer(wsA);
      const f = await facilitator();
      const set = (id: string, change: string, ...values: string[]) =>
        sql(`UPDATE "user_identity" SET ${change} WHERE "id" = $1::uuid`, id, ...values);
      expect(await sqlState(set(c, '"workspace_id" = $2::uuid', wsB))).toBe('23001');
      expect(await sqlState(set(c, `"profile" = 'FACILITATOR', "workspace_id" = NULL`))).toBe('23001');
      expect(await sqlState(set(f, `"profile" = 'CUSTOMER', "workspace_id" = $2::uuid`, wsA))).toBe('23001');
      expect(await sqlState(set(c, '"id" = $2::uuid', randomUUID()))).toBe('23001');
      const email = newEmail();
      await set(c, `"email" = $2, "status" = 'DISABLED'`, email);
      expect(await h.db.client.userIdentity.findUniqueOrThrow({ where: { id: c } })).toMatchObject({
        email, status: 'DISABLED', profile: 'CUSTOMER', workspaceId: wsA,
      });
    });

    it('vínculo administrativo é recusado para cliente, com qualquer papel declarado', async () => {
      const ws = await newWorkspace(h);
      const c = await customer(ws);
      expect(await sqlState(sql(`${LINK}'CUSTOMER', 'ACTIVE')`, ws, c))).toBe('23514');
      expect(await sqlState(sql(`${LINK}'FACILITATOR', 'ACTIVE')`, ws, c))).toBe('23503');
      const f = await facilitator();
      await link(ws, f);
      expect(
        await sqlState(sql('UPDATE "workspace_membership" SET "identity_id" = $1::uuid WHERE "identity_id" = $2::uuid', c, f)),
      ).toBe('23503');
    });

    it('um único vínculo por par, sem órfãos, papel e estado explícitos', async () => {
      const [ws, f] = [await newWorkspace(h), await facilitator()];
      expect(await sqlState(sql(`${LINK}DEFAULT, 'ACTIVE')`, ws, f))).toBe('23502');
      expect(await sqlState(sql(`${LINK}'FACILITATOR', DEFAULT)`, ws, f))).toBe('23502');
      expect(await sqlState(sql(`${LINK}'FACILITATOR', 'PENDING')`, ws, f))).toBe('22P02');
      expect(await sqlState(sql(`${LINK}'FACILITATOR', 'ACTIVE')`, randomUUID(), f))).toBe('23503');
      expect(await sqlState(sql(`${LINK}'FACILITATOR', 'ACTIVE')`, ws, randomUUID()))).toBe('23503');
      await link(ws, f, 'REVOKED');
      expect(await sqlState(sql(`${LINK}'FACILITATOR', 'ACTIVE')`, ws, f))).toBe('23505');
    });

    it('não apaga identidade com vínculo nem workspace com vínculo ou cliente', async () => {
      const [linked, owned] = [await newWorkspace(h), await newWorkspace(h)];
      const f = await facilitator();
      await link(linked, f);
      await customer(owned);
      // RESTRICT gera 23001 no PostgreSQL 18 (23503 em versões anteriores).
      expect(await sqlState(sql('DELETE FROM "user_identity" WHERE "id" = $1::uuid', f))).toMatch(/^(23001|23503)$/);
      for (const ws of [linked, owned]) {
        expect(await sqlState(sql('DELETE FROM "workspace" WHERE "id" = $1::uuid', ws))).toMatch(/^(23001|23503)$/);
      }
    });
  });

  describe('alias do workspace (dono do esquema)', () => {
    const newAlias = (): string => `t-${randomUUID()}`;
    const setAlias = (id: string, alias: string | null) =>
      h.db.client.$executeRaw`UPDATE "workspace" SET "alias" = ${alias} WHERE "id" = ${id}::uuid`;
    const ownersOf = async (alias: string): Promise<string[]> =>
      (await h.app.client.workspace.findMany({ where: { alias }, select: { id: true } })).map((w) => w.id);

    it('é opcional, único e o identificador do workspace não muda', async () => {
      const [a, b, c] = [await newWorkspace(h), await newWorkspace(h), await newWorkspace(h)];
      const alias = newAlias();
      await setAlias(a, alias);
      expect(await sqlState(setAlias(b, alias))).toBe('23505');
      const rest = await h.db.client.workspace.findMany({ where: { id: { in: [b, c] } } });
      expect(rest.map((w) => w.alias)).toEqual([null, null]);
      expect(
        await sqlState(h.db.client.$executeRaw`UPDATE "workspace" SET "id" = ${randomUUID()}::uuid WHERE "id" = ${c}::uuid`),
      ).toBe('23001');
    });

    it.each(['ab', '-abc', 'abc-', 'ABC', 'a_b', 'a b', 'ação', 'abc\n', ''])('recusa formato inválido: %j', async (alias) => {
      expect(await sqlState(setAlias(await newWorkspace(h), alias))).toBe('23514');
    });

    it('passa de um workspace a outro numa transação, sem instante com dois donos ou nenhum', async () => {
      const [from, to] = [await newWorkspace(h), await newWorkspace(h)];
      const alias = newAlias();
      await setAlias(from, alias);
      await h.db.client.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "workspace" SET "alias" = NULL WHERE "id" = ${from}::uuid`;
        expect(await ownersOf(alias)).toEqual([from]);
        await tx.$executeRaw`UPDATE "workspace" SET "alias" = ${alias} WHERE "id" = ${to}::uuid`;
        expect(await ownersOf(alias)).toEqual([from]);
      });
      expect(await ownersOf(alias)).toEqual([to]);
    });

    it('disputa pelo mesmo alias tem um único vencedor', async () => {
      const ids = await Promise.all(Array.from({ length: 6 }, () => newWorkspace(h)));
      const alias = newAlias();
      const { ok, errors } = await settle(ids.map((id) => setAlias(id, alias)));
      expect(ok).toHaveLength(1);
      expect(errors.map((e) => databaseErrorCode(e))).toEqual(Array.from({ length: 5 }, () => '23505'));
      expect(await ownersOf(alias)).toHaveLength(1);
    });
  });
});
