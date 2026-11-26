import { insertAudit } from '../../audit/adapters/insert-audit.js';
import type { AuditOperation, AuditResource } from '../../audit/domain/audit.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { WorkspaceModality } from '../../identity/domain/workspace-modality.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { BootstrapOutcome, IdentityState, MembershipState, OperatorStore } from '../application/operator.store.js';
import { AdministrationError } from '../domain/errors.js';
import { lockFacilitatorChange, type Transaction, TRANSACTION_OPTIONS } from './administration-sql.js';
import { issueTemporaryCredential } from './temporary-credential-sql.js';

type Audit = (operation: AuditOperation, resource: AuditResource, resourceId: string, workspaceId: string | null, changed?: boolean) => Promise<void>;

/** Conecta como dono do esquema: a execução não cria identidades, credenciais, vínculos nem workspaces. */
export class PrismaOperatorStore implements OperatorStore {
  constructor(private readonly client: PrismaClient) {}

  facilitatorExists(email: string): Promise<boolean> {
    return this.guard(async () => (await findFacilitator(this.client, email)) !== null);
  }

  bootstrap(input: { alias: string; email: string; hash: string | null; correlationId: string }): Promise<BootstrapOutcome> {
    return this.transaction(input.correlationId, async (tx, audit) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('finbank:bootstrap', 0))`;
      const newWorkspace = await insertWorkspace(tx, input.alias, 'ISOLATED');
      const workspaceId = newWorkspace ?? (await workspaceOf(tx, input.alias));
      let facilitatorId = input.hash === null ? null : await insertIdentity(tx, 'FACILITATOR', input.email, null, input.hash);
      const facilitatorCreated = facilitatorId !== null;
      if (facilitatorId === null) {
        const found = await requireFacilitator(tx, input.email);
        await lockFacilitatorChange(tx, found);
        if ((await facilitatorState(tx, found)) !== 'ACTIVE') {
          throw new AdministrationError('FACILITATOR_DISABLED');
        }
        facilitatorId = found;
      }
      const membership = await membershipState(tx, workspaceId, facilitatorId);
      if (membership === 'REVOKED') {
        throw new AdministrationError('MEMBERSHIP_REVOKED');
      }
      if (newWorkspace !== null) {
        await audit('WORKSPACE_CREATE', 'WORKSPACE', workspaceId, workspaceId);
      }
      if (facilitatorCreated) {
        await audit('FACILITATOR_CREATE', 'IDENTITY', facilitatorId, null);
      }
      if (membership === null) {
        await putMembership(tx, workspaceId, facilitatorId, 'ACTIVE');
        await audit('MEMBERSHIP_GRANT', 'MEMBERSHIP', facilitatorId, workspaceId);
      }
      if (newWorkspace === null && !facilitatorCreated && membership !== null) {
        await audit('BOOTSTRAP', 'WORKSPACE', workspaceId, workspaceId, false);
      }
      return { workspaceCreated: newWorkspace !== null, facilitatorCreated, membershipCreated: membership === null };
    });
  }

  createWorkspace(alias: string, modality: WorkspaceModality, correlationId: string): Promise<void> {
    return this.transaction(correlationId, async (tx, audit) => {
      const id = created(await insertWorkspace(tx, alias, modality));
      await audit('WORKSPACE_CREATE', 'WORKSPACE', id, id);
    });
  }

  createFacilitator(email: string, hash: string, correlationId: string): Promise<void> {
    return this.transaction(correlationId, async (tx, audit) => {
      const id = created(await insertIdentity(tx, 'FACILITATOR', email, null, hash));
      await audit('FACILITATOR_CREATE', 'IDENTITY', id, null);
    });
  }

  createCustomer(alias: string, email: string, hash: string, correlationId: string): Promise<void> {
    return this.transaction(correlationId, async (tx, audit) => {
      const workspaceId = await workspaceOf(tx, alias);
      const id = created(await insertIdentity(tx, 'CUSTOMER', email, workspaceId, hash));
      await audit('CUSTOMER_CREATE', 'IDENTITY', id, workspaceId);
    });
  }

  setFacilitatorState(email: string, state: IdentityState, correlationId: string): Promise<boolean> {
    return this.transaction(correlationId, async (tx, audit) => {
      const id = await requireFacilitator(tx, email);
      await lockFacilitatorChange(tx, id);
      const changed = (await facilitatorState(tx, id)) !== state;
      if (changed) {
        await tx.$executeRaw`UPDATE "user_identity" SET "status" = ${state}::"identity_status" WHERE "id" = ${id}::uuid`;
      }
      await audit(state === 'DISABLED' ? 'FACILITATOR_DISABLE' : 'FACILITATOR_ENABLE', 'IDENTITY', id, null, changed);
      return changed;
    });
  }

  setMembership(alias: string, email: string, state: MembershipState, correlationId: string): Promise<boolean> {
    return this.transaction(correlationId, async (tx, audit) => {
      const workspaceId = await workspaceOf(tx, alias);
      const id = await requireFacilitator(tx, email);
      await lockFacilitatorChange(tx, id);
      const current = await membershipState(tx, workspaceId, id);
      if (current === null && state === 'REVOKED') {
        throw new AdministrationError('NOT_FOUND');
      }
      const changed = current !== state;
      if (changed) {
        await putMembership(tx, workspaceId, id, state);
      }
      await audit(state === 'REVOKED' ? 'MEMBERSHIP_REVOKE' : 'MEMBERSHIP_GRANT', 'MEMBERSHIP', id, workspaceId, changed);
      return changed;
    });
  }

  issueFacilitatorCredential(email: string, hash: string, hours: number, correlationId: string): Promise<Date> {
    return this.transaction(correlationId, async (tx, audit) => {
      const id = await requireFacilitator(tx, email);
      await lockFacilitatorChange(tx, id);
      const expiresAt = (await facilitatorState(tx, id)) === 'ACTIVE' ? await issueTemporaryCredential(tx, id, hash, hours) : null;
      if (expiresAt === null) {
        throw new AdministrationError('IDENTITY_STATE');
      }
      await audit('PASSWORD_RESET_ISSUE', 'IDENTITY', id, null);
      return expiresAt;
    });
  }

  private transaction<T>(correlationId: string, work: (tx: Transaction, audit: Audit) => Promise<T>): Promise<T> {
    return this.guard(() =>
      this.client.$transaction(
        (tx) =>
          work(tx, (operation, resource, resourceId, workspaceId, changed = true) =>
            insertAudit(tx, { actor: { type: 'OPERATOR' }, operation, resource, resourceId, workspaceId, changed, correlationId }),
          ),
        TRANSACTION_OPTIONS,
      ),
    );
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof AdministrationError ? error : new AdministrationError('ADMINISTRATION_FAILED', databaseErrorCode(error));
    }
  }
}

function created(id: string | null): string {
  if (id === null) {
    throw new AdministrationError('ALREADY_EXISTS');
  }
  return id;
}

/** A modalidade é sempre explícita aqui, sem depender do valor padrão da coluna. */
async function insertWorkspace(tx: Transaction, alias: string, modality: WorkspaceModality): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "workspace" ("alias", "modality") VALUES (${alias}, ${modality}::"workspace_modality")
    ON CONFLICT DO NOTHING RETURNING "id"::text AS "id"`;
  return rows[0]?.id ?? null;
}

async function workspaceOf(tx: Transaction, alias: string): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id"::text AS "id" FROM "workspace" WHERE "alias" = ${alias}`;
  if (rows[0] === undefined) {
    throw new AdministrationError('NOT_FOUND');
  }
  return rows[0].id;
}

/** Identidade e credencial juntas; null se o e-mail já está em uso no mesmo escopo. */
async function insertIdentity(
  tx: Transaction,
  profile: 'CUSTOMER' | 'FACILITATOR',
  email: string,
  workspaceId: string | null,
  hash: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "user_identity" ("status", "profile", "email", "workspace_id")
    VALUES ('ACTIVE', ${profile}::"membership_role", ${email}, ${workspaceId}::uuid)
    ON CONFLICT DO NOTHING RETURNING "id"::text AS "id"`;
  const id = rows[0]?.id ?? null;
  if (id !== null) {
    await tx.$executeRaw`INSERT INTO "password_credential" ("identity_id", "hash") VALUES (${id}::uuid, ${hash})`;
  }
  return id;
}

async function findFacilitator(tx: Transaction, email: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS "id" FROM "user_identity" WHERE "profile" = 'FACILITATOR' AND "email" = ${email}`;
  return rows[0]?.id ?? null;
}

async function requireFacilitator(tx: Transaction, email: string): Promise<string> {
  const id = await findFacilitator(tx, email);
  if (id === null) {
    throw new AdministrationError('NOT_FOUND');
  }
  return id;
}

async function facilitatorState(tx: Transaction, id: string): Promise<string | undefined> {
  const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "user_identity" WHERE "id" = ${id}::uuid`;
  return rows[0]?.status;
}

async function membershipState(tx: Transaction, workspaceId: string, identityId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "workspace_membership"
     WHERE "workspace_id" = ${workspaceId}::uuid AND "identity_id" = ${identityId}::uuid`;
  return rows[0]?.status ?? null;
}

async function putMembership(tx: Transaction, workspaceId: string, identityId: string, state: MembershipState): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "workspace_membership" ("workspace_id", "identity_id", "role", "status")
    VALUES (${workspaceId}::uuid, ${identityId}::uuid, 'FACILITATOR', ${state}::"membership_status")
    ON CONFLICT ("workspace_id", "identity_id") DO UPDATE SET "status" = EXCLUDED."status"`;
}
