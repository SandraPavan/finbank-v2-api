import type { PrismaClient } from '../../generated/prisma/client.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { FacilitatorWorkspacesReader, PageRequest, WorkspaceSummary } from '../application/facilitator-workspaces.reader.js';
import { IdentityError } from '../domain/errors.js';

/** Adaptador PostgreSQL/Prisma, somente leitura. */
export class PrismaFacilitatorWorkspacesReader implements FacilitatorWorkspacesReader {
  constructor(private readonly client: PrismaClient) {}

  list(identityId: string, page: PageRequest): Promise<WorkspaceSummary[]> {
    return this.guard(
      () => this.client.$queryRaw<WorkspaceSummary[]>`
        SELECT w."id"::text AS "workspaceId", w."alias"
          FROM "user_identity" i
          JOIN "workspace_membership" m ON m."identity_id" = i."id" AND m."status" = 'ACTIVE'
          JOIN "workspace" w ON w."id" = m."workspace_id"
         WHERE i."id" = ${identityId}::uuid AND i."status" = 'ACTIVE' AND i."profile" = 'FACILITATOR'
         ORDER BY w."created_at", w."id"
         LIMIT ${page.limit}::int OFFSET ${page.offset}::int`,
    );
  }

  find(identityId: string, workspaceId: string): Promise<WorkspaceSummary | null> {
    return this.guard(async () => {
      const rows = await this.client.$queryRaw<WorkspaceSummary[]>`
        SELECT w."id"::text AS "workspaceId", w."alias"
          FROM "user_identity" i
          JOIN "workspace_membership" m ON m."identity_id" = i."id" AND m."status" = 'ACTIVE'
          JOIN "workspace" w ON w."id" = m."workspace_id"
         WHERE i."id" = ${identityId}::uuid AND i."status" = 'ACTIVE' AND i."profile" = 'FACILITATOR'
           AND w."id" = ${workspaceId}::uuid`;
      return rows[0] ?? null;
    });
  }

  private async guard<T>(query: () => PromiseLike<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      throw new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
