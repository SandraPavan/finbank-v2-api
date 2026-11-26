import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { insertAudit } from '../../audit/adapters/insert-audit.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { IdentityError } from '../../identity/domain/errors.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockFacilitatorUse } from '../../persistence/facilitator-locks.js';
import type { EducationalConfigStore, PublishResult } from '../application/educational-config.service.js';
import { PRESET_ALL, PRESET_NONE, type Preset, type WorkspaceEducationalConfig } from '../educational-mode.js';

interface Row {
  readonly workspaceId: string;
  readonly revision: number;
  readonly catalogVersion: string;
  readonly mode: string;
  readonly preset: string | null;
  readonly labCodeHash: string | null;
  readonly enabledDefectIds: string[] | null;
}

function toConfig(row: Row): WorkspaceEducationalConfig {
  const base = { workspaceId: row.workspaceId, revision: row.revision, catalogVersion: row.catalogVersion };
  if (row.mode === 'CONTROLLED') {
    return Object.freeze({ ...base, mode: 'CONTROLLED', enabledDefectIds: Object.freeze([...(row.enabledDefectIds ?? [])]) });
  }
  let preset: Preset;
  if (row.preset === 'LAB' && row.labCodeHash !== null) {
    preset = Object.freeze({ kind: 'LAB', codeHash: row.labCodeHash });
  } else if (row.preset === 'ALL') {
    preset = PRESET_ALL;
  } else if (row.preset === 'NONE') {
    preset = PRESET_NONE;
  } else {
    // Linha fora do formato: falha, nunca uma configuração adivinhada.
    throw new IdentityError('ACCESS_CHECK_FAILED');
  }
  return Object.freeze({ ...base, mode: 'STUDENT', preset });
}

const UNIQUE_VIOLATION = '23505';

export class PrismaEducationalConfigStore implements EducationalConfigStore {
  constructor(private readonly client: PrismaClient) {}

  current(workspaceId: string): Promise<WorkspaceEducationalConfig | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<Row[]>`
        SELECT "workspace_id"::text AS "workspaceId", "revision", "catalog_version" AS "catalogVersion", "mode"::text AS "mode",
               "preset"::text AS "preset", "lab_code_hash" AS "labCodeHash", "enabled_defect_ids" AS "enabledDefectIds"
          FROM "educational_config_revision" WHERE "workspace_id" = ${workspaceId}::uuid
         ORDER BY "revision" DESC LIMIT 1`;
      return rows[0] === undefined ? null : toConfig(rows[0]);
    });
  }

  publish(access: WorkspaceAccess, next: WorkspaceEducationalConfig, correlationId: string): Promise<PublishResult> {
    const preset = next.mode === 'STUDENT' ? next.preset.kind : null;
    const codeHash = next.mode === 'STUDENT' && next.preset.kind === 'LAB' ? next.preset.codeHash : null;
    const defects = next.mode === 'CONTROLLED' ? [...next.enabledDefectIds] : null;
    return this.guard(async () => {
      try {
        return await this.client.$transaction(
          async (tx) => {
            await lockFacilitatorUse(tx, access.identityId);
            const allowed = await tx.$queryRaw<unknown[]>`
              SELECT 1 AS "ok" FROM "user_identity" f
                JOIN "workspace_membership" m ON m."identity_id" = f."id" AND m."status" = 'ACTIVE'
               WHERE f."id" = ${access.identityId}::uuid AND f."status" = 'ACTIVE' AND f."profile" = 'FACILITATOR'
                 AND m."workspace_id" = ${next.workspaceId}::uuid`;
            if (allowed.length !== 1) {
              return 'DENIED' as const;
            }
            const [row] = await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO "educational_config_revision"
                ("workspace_id", "revision", "catalog_version", "mode", "preset", "lab_code_hash", "enabled_defect_ids", "created_by")
              VALUES (${next.workspaceId}::uuid, ${next.revision}::int, ${next.catalogVersion}, ${next.mode}::"educational_mode",
                      ${preset}::"educational_preset", ${codeHash}, ${defects}::text[], ${access.identityId}::uuid)
              RETURNING "id"::text AS "id"`;
            await insertAudit(tx, {
              actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
              workspaceId: next.workspaceId,
              operation: 'EDUCATIONAL_CONFIG_CHANGE',
              resource: 'EDUCATIONAL_CONFIG_REVISION',
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
