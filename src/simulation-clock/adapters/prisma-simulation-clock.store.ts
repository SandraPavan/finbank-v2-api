import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { insertAudit } from '../../audit/adapters/insert-audit.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockFacilitatorUse } from '../../persistence/facilitator-locks.js';
import { lockWorkspaceUse } from '../../persistence/workspace-locks.js';
import type { ClockPublishResult, ClockState, SimulationClockStore } from '../application/simulation-clock.service.js';
import { type BusinessDate, CLOCK_TIME_ZONE, parseBusinessDate } from '../domain/business-date.js';

const UNIQUE_VIOLATION = '23505';

export class PrismaSimulationClockStore implements SimulationClockStore {
  constructor(private readonly client: PrismaClient) {}

  current(workspaceId: string): Promise<ClockState | null> {
    return this.guard(async () => {
      // Sem revisão gravada, a data de criação do workspace no fuso do relógio (revisão 0), calculada pelo banco.
      const rows = await this.client.$queryRaw<{ date: string; revision: number }[]>`
        SELECT to_char(coalesce(r."business_date", (w."created_at" AT TIME ZONE ${CLOCK_TIME_ZONE})::date), 'YYYY-MM-DD') AS "date",
               coalesce(r."revision", 0) AS "revision"
          FROM "workspace" w
          LEFT JOIN LATERAL (
            SELECT "business_date", "revision" FROM "simulation_clock_revision"
             WHERE "workspace_id" = w."id" ORDER BY "revision" DESC LIMIT 1
          ) r ON true
         WHERE w."id" = ${workspaceId}::uuid`;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      // Linha fora do formato (workspace criado fora da faixa): falha, nunca uma data adivinhada.
      let date: BusinessDate;
      try {
        date = parseBusinessDate(row.date);
      } catch {
        throw new IdentityError('ACCESS_CHECK_FAILED');
      }
      return Object.freeze({ date, revision: row.revision });
    });
  }

  publish(access: WorkspaceAccess, revision: number, date: BusinessDate, correlationId: string): Promise<ClockPublishResult> {
    return this.guard(async () => {
      try {
        return await this.client.$transaction(
          async (tx) => {
            await lockFacilitatorUse(tx, access.identityId);
            const allowed = await tx.$queryRaw<unknown[]>`
              SELECT 1 AS "ok" FROM "user_identity" f
                JOIN "workspace_membership" m ON m."identity_id" = f."id" AND m."status" = 'ACTIVE'
               WHERE f."id" = ${access.identityId}::uuid AND f."status" = 'ACTIVE' AND f."profile" = 'FACILITATOR'
                 AND m."workspace_id" = ${access.workspaceId}::uuid`;
            if (allowed.length !== 1) {
              return 'DENIED' as const;
            }
            await lockWorkspaceUse(tx, access.workspaceId);
            const [workspace] = await tx.$queryRaw<{ status: string }[]>`
              SELECT "status"::text AS "status" FROM "workspace" WHERE "id" = ${access.workspaceId}::uuid`;
            if (workspace?.status !== 'ACTIVE') {
              return 'ARCHIVED' as const;
            }
            const [row] = await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO "simulation_clock_revision" ("workspace_id", "revision", "business_date", "created_by")
              VALUES (${access.workspaceId}::uuid, ${revision}::int, ${date}::date, ${access.identityId}::uuid)
              RETURNING "id"::text AS "id"`;
            await insertAudit(tx, {
              actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
              workspaceId: access.workspaceId,
              operation: 'SIMULATION_CLOCK_CHANGE',
              resource: 'SIMULATION_CLOCK_REVISION',
              resourceId: row?.id ?? '',
              changed: true,
              correlationId,
            });
            return 'PUBLISHED' as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 },
        );
      } catch (error) {
        if (databaseErrorCode(error) === UNIQUE_VIOLATION) {
          return 'CONFLICT';
        }
        throw error;
      }
    });
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof IdentityError ? error : new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
