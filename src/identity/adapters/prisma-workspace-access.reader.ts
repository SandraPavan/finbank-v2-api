import type { PrismaClient } from '../../generated/prisma/client.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { WorkspaceAccessReader } from '../application/workspace-access.reader.js';
import { IdentityError } from '../domain/errors.js';

/** Adaptador PostgreSQL/Prisma: uma única consulta, somente leitura. */
export class PrismaWorkspaceAccessReader implements WorkspaceAccessReader {
  constructor(private readonly client: PrismaClient) {}

  async findActiveRole(identityId: string, workspaceId: string): Promise<string | null> {
    try {
      const rows = await this.client.$queryRaw<{ role: string }[]>`
        SELECT i."profile"::text AS "role"
          FROM "user_identity" i
         WHERE i."id" = ${identityId}::uuid
           AND i."status" = 'ACTIVE'
           AND (
             (i."profile" = 'CUSTOMER' AND i."workspace_id" = ${workspaceId}::uuid)
             OR (i."profile" = 'FACILITATOR' AND EXISTS (
               SELECT 1 FROM "workspace_membership" m
                WHERE m."identity_id" = i."id"
                  AND m."workspace_id" = ${workspaceId}::uuid
                  AND m."status" = 'ACTIVE'))
           )`;
      return rows[0]?.role ?? null;
    } catch (error) {
      throw new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
