import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { insertAudit } from '../../audit/adapters/insert-audit.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { isWorkspaceModality } from '../../identity/domain/workspace-modality.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockFacilitatorUse } from '../../persistence/facilitator-locks.js';
import { lockWorkspaceUse } from '../../persistence/workspace-locks.js';
import type { EnrollmentState, EnrollmentStore, EnrollmentWrite } from '../application/enrollment.service.js';
import type { EnrollmentCodeHash } from '../domain/enrollment-code.js';

const HASH = /^[0-9a-f]{64}$/;

export class PrismaEnrollmentStore implements EnrollmentStore {
  constructor(private readonly client: PrismaClient) {}

  state(workspaceId: string): Promise<EnrollmentState | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<{ modality: string; codeHash: string | null; revision: number }[]>`
        SELECT w."modality"::text AS "modality", c."code_hash" AS "codeHash", coalesce(c."revision", 0) AS "revision"
          FROM "workspace" w
          LEFT JOIN LATERAL (
            SELECT "code_hash", "revision" FROM "workspace_enrollment_code"
             WHERE "workspace_id" = w."id" ORDER BY "revision" DESC LIMIT 1
          ) c ON true
         WHERE w."id" = ${workspaceId}::uuid`;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      // Linha fora do formato: falha, nunca uma situação adivinhada.
      if (!isWorkspaceModality(row.modality) || (row.codeHash !== null && !HASH.test(row.codeHash))) {
        throw new IdentityError('ACCESS_CHECK_FAILED');
      }
      return Object.freeze({ modality: row.modality, currentHash: row.codeHash as EnrollmentCodeHash | null, revision: row.revision });
    });
  }

  write(access: WorkspaceAccess, hash: EnrollmentCodeHash | null, correlationId: string): Promise<EnrollmentWrite> {
    return this.guard(() =>
      this.client.$transaction(
        async (tx): Promise<EnrollmentWrite> => {
          await lockFacilitatorUse(tx, access.identityId);
          const allowed = await tx.$queryRaw<unknown[]>`
            SELECT 1 AS "ok" FROM "user_identity" f
              JOIN "workspace_membership" m ON m."identity_id" = f."id" AND m."status" = 'ACTIVE'
             WHERE f."id" = ${access.identityId}::uuid AND f."status" = 'ACTIVE' AND f."profile" = 'FACILITATOR'
               AND m."workspace_id" = ${access.workspaceId}::uuid`;
          if (allowed.length !== 1) {
            return { kind: 'DENIED' };
          }
          await lockWorkspaceUse(tx, access.workspaceId);
          const [workspace] = await tx.$queryRaw<{ status: string }[]>`
            SELECT "status"::text AS "status" FROM "workspace" WHERE "id" = ${access.workspaceId}::uuid`;
          if (workspace?.status !== 'ACTIVE') {
            return { kind: 'ARCHIVED' };
          }
          // Serializa as gravações do mesmo workspace: revisões consecutivas, sem disputa pela chave.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finbank:enrollment:${access.workspaceId}`}, 0))`;
          const [last] = await tx.$queryRaw<{ revision: number; codeHash: string | null }[]>`
            SELECT "revision", "code_hash" AS "codeHash" FROM "workspace_enrollment_code"
             WHERE "workspace_id" = ${access.workspaceId}::uuid ORDER BY "revision" DESC LIMIT 1`;
          const current = last?.revision ?? 0;
          if (hash === null && (last?.codeHash ?? null) === null) {
            return { kind: 'UNCHANGED', revision: current };
          }
          const revision = current + 1;
          const [row] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "workspace_enrollment_code" ("workspace_id", "revision", "code_hash", "created_by")
            VALUES (${access.workspaceId}::uuid, ${revision}::int, ${hash}, ${access.identityId}::uuid)
            RETURNING "id"::text AS "id"`;
          await insertAudit(tx, {
            actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
            workspaceId: access.workspaceId,
            operation: hash === null ? 'ENROLLMENT_CODE_REVOKE' : 'ENROLLMENT_CODE_ISSUE',
            resource: 'ENROLLMENT_CODE_REVISION',
            resourceId: row?.id ?? '',
            changed: true,
            correlationId,
          });
          return { kind: 'WRITTEN', revision };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 },
      ),
    );
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof IdentityError ? error : new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
