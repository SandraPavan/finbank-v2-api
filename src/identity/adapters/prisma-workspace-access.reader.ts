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
        SELECT m."role"::text AS "role"
          FROM "workspace_membership" m
          JOIN "user_identity" i ON i."id" = m."identity_id"
         WHERE m."identity_id" = ${identityId}::uuid
           AND m."workspace_id" = ${workspaceId}::uuid
           AND m."status" = 'ACTIVE'
           AND i."status" = 'ACTIVE'`;
      return rows[0]?.role ?? null;
    } catch (error) {
      throw new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
