import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { FacilitatorWorkspacesReader, PageRequest, WorkspaceSummary } from '../application/facilitator-workspaces.reader.js';
import { IdentityError } from '../domain/errors.js';
import { isWorkspaceModality } from '../domain/workspace-modality.js';

interface Row {
  readonly workspaceId: string;
  readonly alias: string | null;
  readonly modality: string;
  readonly status: string;
  readonly active: boolean;
  readonly revision: number;
}

/** Só a situação do código de inscrição; o hash não sai do banco. */
const SUMMARY = Prisma.sql`
  w."id"::text AS "workspaceId", w."alias", w."modality"::text AS "modality", w."status"::text AS "status",
  coalesce(c."code_hash" IS NOT NULL, false) AS "active", coalesce(c."revision", 0) AS "revision"`;
const ENROLLMENT = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT "code_hash", "revision" FROM "workspace_enrollment_code"
     WHERE "workspace_id" = w."id" ORDER BY "revision" DESC LIMIT 1
  ) c ON true`;

function toSummary(row: Row): WorkspaceSummary {
  if (!isWorkspaceModality(row.modality) || (row.status !== 'ACTIVE' && row.status !== 'ARCHIVED')) {
    throw new IdentityError('ACCESS_CHECK_FAILED');
  }
  return {
    workspaceId: row.workspaceId,
    alias: row.alias,
    modality: row.modality,
    status: row.status,
    enrollment: { active: row.active, revision: row.revision, required: row.modality === 'SHARED' },
  };
}

/** Adaptador PostgreSQL/Prisma, somente leitura. */
export class PrismaFacilitatorWorkspacesReader implements FacilitatorWorkspacesReader {
  constructor(private readonly client: PrismaClient) {}

  list(identityId: string, page: PageRequest): Promise<WorkspaceSummary[]> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<Row[]>`
        SELECT ${SUMMARY}
          FROM "user_identity" i
          JOIN "workspace_membership" m ON m."identity_id" = i."id" AND m."status" = 'ACTIVE'
          JOIN "workspace" w ON w."id" = m."workspace_id"
          ${ENROLLMENT}
         WHERE i."id" = ${identityId}::uuid AND i."status" = 'ACTIVE' AND i."profile" = 'FACILITATOR'
         ORDER BY w."created_at", w."id"
         LIMIT ${page.limit}::int OFFSET ${page.offset}::int`;
      return rows.map(toSummary);
    });
  }

  find(identityId: string, workspaceId: string): Promise<WorkspaceSummary | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<Row[]>`
        SELECT ${SUMMARY}
          FROM "user_identity" i
          JOIN "workspace_membership" m ON m."identity_id" = i."id" AND m."status" = 'ACTIVE'
          JOIN "workspace" w ON w."id" = m."workspace_id"
          ${ENROLLMENT}
         WHERE i."id" = ${identityId}::uuid AND i."status" = 'ACTIVE' AND i."profile" = 'FACILITATOR'
           AND w."id" = ${workspaceId}::uuid`;
      return rows[0] === undefined ? null : toSummary(rows[0]);
    });
  }

  private async guard<T>(query: () => PromiseLike<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      throw error instanceof IdentityError ? error : new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
