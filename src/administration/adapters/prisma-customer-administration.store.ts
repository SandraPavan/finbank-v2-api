import type { PrismaClient } from '../../generated/prisma/client.js';
import type { PageRequest } from '../../identity/application/facilitator-workspaces.reader.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { CustomerAdministrationStore, CustomerSummary } from '../application/customer-administration.store.js';
import type { IdentityState } from '../application/operator.store.js';
import { insertAudit, lockFacilitatorUse, TRANSACTION_OPTIONS } from './administration-sql.js';

export class PrismaCustomerAdministrationStore implements CustomerAdministrationStore {
  constructor(private readonly client: PrismaClient) {}

  list(access: WorkspaceAccess, page: PageRequest): Promise<CustomerSummary[]> {
    return this.guard(
      () => this.client.$queryRaw<CustomerSummary[]>`
        SELECT c."id"::text AS "customerId", c."email", c."status"::text AS "status"
          FROM "user_identity" f
          JOIN "workspace_membership" m ON m."identity_id" = f."id" AND m."status" = 'ACTIVE'
          JOIN "user_identity" c ON c."workspace_id" = m."workspace_id" AND c."profile" = 'CUSTOMER'
         WHERE f."id" = ${access.identityId}::uuid AND f."status" = 'ACTIVE' AND f."profile" = 'FACILITATOR'
           AND m."workspace_id" = ${access.workspaceId}::uuid
         ORDER BY c."created_at", c."id"
         LIMIT ${page.limit}::int OFFSET ${page.offset}::int`,
    );
  }

  setState(access: WorkspaceAccess, customerId: string, state: IdentityState, correlationId: string): Promise<boolean> {
    return this.guard(() =>
      this.client.$transaction(async (tx) => {
        await lockFacilitatorUse(tx, access.identityId);
        const allowed = await tx.$queryRaw<unknown[]>`
          SELECT 1 AS "ok" FROM "user_identity" f
            JOIN "workspace_membership" m ON m."identity_id" = f."id" AND m."status" = 'ACTIVE'
           WHERE f."id" = ${access.identityId}::uuid AND f."status" = 'ACTIVE' AND f."profile" = 'FACILITATOR'
             AND m."workspace_id" = ${access.workspaceId}::uuid`;
        if (allowed.length !== 1) {
          return false;
        }
        const [customer] = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status"::text AS "status" FROM "user_identity"
           WHERE "id" = ${customerId}::uuid AND "workspace_id" = ${access.workspaceId}::uuid AND "profile" = 'CUSTOMER'
             FOR NO KEY UPDATE`;
        if (customer === undefined) {
          return false;
        }
        const changed = customer.status !== state;
        if (changed) {
          await tx.$executeRaw`
            UPDATE "user_identity" SET "status" = ${state}::"identity_status"
             WHERE "id" = ${customerId}::uuid AND "workspace_id" = ${access.workspaceId}::uuid AND "profile" = 'CUSTOMER'`;
        }
        await insertAudit(tx, {
          actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
          workspaceId: access.workspaceId,
          operation: state === 'DISABLED' ? 'CUSTOMER_DISABLE' : 'CUSTOMER_ENABLE',
          resource: 'IDENTITY',
          resourceId: customerId,
          changed,
          correlationId,
        });
        return true;
      }, TRANSACTION_OPTIONS),
    );
  }

  private async guard<T>(work: () => PromiseLike<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
