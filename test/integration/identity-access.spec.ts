// Vínculos e consulta de acesso em PostgreSQL real: dados preparados pelo dono, consulta pela execução.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaWorkspaceAccessReader } from '../../src/identity/adapters/prisma-workspace-access.reader.js';
import { WorkspaceAccessService } from '../../src/identity/application/workspace-access.service.js';
import { IdentityError } from '../../src/identity/domain/errors.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';
import { type Harness, harness, newWorkspace, sqlState } from './payment-execution/support.js';

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

  async function identity(status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): Promise<string> {
    return (await h.db.client.userIdentity.create({ data: { status }, select: { id: true } })).id;
  }

  async function link(
    workspaceId: string,
    identityId: string,
    role: 'CUSTOMER' | 'FACILITATOR' = 'CUSTOMER',
    status: 'ACTIVE' | 'REVOKED' = 'ACTIVE',
  ): Promise<void> {
    await h.db.client.workspaceMembership.create({ data: { workspaceId, identityId, role, status } });
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
    it.each(['CUSTOMER', 'FACILITATOR'] as const)('vínculo ativo devolve o papel %s', async (role) => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      await link(ws, id, role);
      expect(await access.resolve(id, ws)).toEqual({ identityId: id, workspaceId: ws, role });
    });

    it('nega identidade inexistente, workspace inexistente e ausência de vínculo, sem distinção', async () => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      await expectDenied(randomUUID(), ws);
      await expectDenied(id, randomUUID());
      await expectDenied(id, ws);
    });

    it.each(['CUSTOMER', 'FACILITATOR'] as const)('nega identidade desativada e vínculo revogado (%s)', async (role) => {
      const ws = await newWorkspace(h);
      const disabled = await identity('DISABLED');
      await link(ws, disabled, role);
      await expectDenied(disabled, ws);
      const revoked = await identity();
      await link(ws, revoked, role, 'REVOKED');
      await expectDenied(revoked, ws);
    });

    it('revogar e desativar valem na consulta seguinte', async () => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      await link(ws, id);
      const key = { workspaceId_identityId: { workspaceId: ws, identityId: id } };
      await access.resolve(id, ws);
      await h.db.client.workspaceMembership.update({ where: key, data: { status: 'REVOKED' } });
      await expectDenied(id, ws);
      await h.db.client.workspaceMembership.update({ where: key, data: { status: 'ACTIVE' } });
      await access.resolve(id, ws);
      await h.db.client.userIdentity.update({ where: { id }, data: { status: 'DISABLED' } });
      await expectDenied(id, ws);
    });

    it.each(['CUSTOMER', 'FACILITATOR'] as const)('%s de um workspace não acessa o outro', async (role) => {
      const [wsA, wsB] = [await newWorkspace(h), await newWorkspace(h)];
      const [a, b] = [await identity(), await identity()];
      await link(wsA, a, role);
      await link(wsB, b, role);
      await access.resolve(a, wsA);
      await access.resolve(b, wsB);
      await expectDenied(a, wsB);
      await expectDenied(b, wsA);
    });

    it('papéis da mesma identidade em workspaces distintos não se misturam', async () => {
      const [wsA, wsB, wsC] = [await newWorkspace(h), await newWorkspace(h), await newWorkspace(h)];
      const id = await identity();
      await link(wsA, id, 'FACILITATOR');
      await link(wsB, id, 'CUSTOMER');
      await link(wsC, id, 'FACILITATOR', 'REVOKED');
      expect((await access.resolve(id, wsA)).role).toBe('FACILITATOR');
      expect((await access.resolve(id, wsB)).role).toBe('CUSTOMER');
      await expectDenied(id, wsC);
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
    const sql = (statement: string, ...values: string[]) => h.db.client.$executeRawUnsafe(statement, ...values);
    const INSERT = 'INSERT INTO "workspace_membership" ("workspace_id", "identity_id", "role", "status") VALUES ($1::uuid, $2::uuid, ';

    it('um único vínculo por par, mesmo com outro papel ou revogado', async () => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      await link(ws, id, 'CUSTOMER', 'REVOKED');
      expect(await sqlState(sql(`${INSERT}'FACILITATOR', 'ACTIVE')`, ws, id))).toBe('23505');
    });

    it('recusa workspace ou identidade inexistente', async () => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      expect(await sqlState(sql(`${INSERT}'CUSTOMER', 'ACTIVE')`, randomUUID(), id))).toBe('23503');
      expect(await sqlState(sql(`${INSERT}'CUSTOMER', 'ACTIVE')`, ws, randomUUID()))).toBe('23503');
    });

    it('recusa papel e estado fora dos previstos', async () => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      expect(await sqlState(sql(`${INSERT}'STUDENT', 'ACTIVE')`, ws, id))).toBe('22P02');
      expect(await sqlState(sql(`${INSERT}'CUSTOMER', 'PENDING')`, ws, id))).toBe('22P02');
      expect(await sqlState(sql(`INSERT INTO "user_identity" ("status") VALUES ('PENDING')`))).toBe('22P02');
    });

    it('papel e estados não têm valor padrão', async () => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      expect(await sqlState(sql(`${INSERT}DEFAULT, 'ACTIVE')`, ws, id))).toBe('23502');
      expect(await sqlState(sql(`${INSERT}'CUSTOMER', DEFAULT)`, ws, id))).toBe('23502');
      expect(await sqlState(sql('INSERT INTO "user_identity" DEFAULT VALUES'))).toBe('23502');
    });

    it('não apaga identidade ou workspace com vínculo', async () => {
      const [ws, id] = [await newWorkspace(h), await identity()];
      await link(ws, id);
      // RESTRICT gera 23001 no PostgreSQL 18 (23503 em versões anteriores).
      expect(await sqlState(sql('DELETE FROM "user_identity" WHERE "id" = $1::uuid', id))).toMatch(/^(23001|23503)$/);
      expect(await sqlState(sql('DELETE FROM "workspace" WHERE "id" = $1::uuid', ws))).toMatch(/^(23001|23503)$/);
    });
  });
});
