import { insertAudit } from '../../audit/adapters/insert-audit.js';
import type { AuditOperation } from '../../audit/domain/audit.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { PageRequest } from '../../identity/application/facilitator-workspaces.reader.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { CredentialIssue, CustomerAdministrationStore, CustomerSummary } from '../application/customer-administration.store.js';
import type { IdentityState } from '../application/operator.store.js';
import { lockFacilitatorUse, type Transaction, TRANSACTION_OPTIONS } from './administration-sql.js';
import { issueTemporaryCredential } from './temporary-credential-sql.js';

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
    return this.onCustomer(access, customerId, false, async (tx, current) => {
      const changed = current !== state;
      if (changed) {
        await tx.$executeRaw`
          UPDATE "user_identity" SET "status" = ${state}::"identity_status"
           WHERE "id" = ${customerId}::uuid AND "workspace_id" = ${access.workspaceId}::uuid AND "profile" = 'CUSTOMER'`;
      }
      await this.audit(tx, access, customerId, state === 'DISABLED' ? 'CUSTOMER_DISABLE' : 'CUSTOMER_ENABLE', changed, correlationId);
      return true;
    });
  }

  issueCredential(access: WorkspaceAccess, customerId: string, hash: string, hours: number, correlationId: string): Promise<CredentialIssue> {
    return this.onCustomer<CredentialIssue>(access, customerId, 'DENIED', async (tx, current) => {
      const expiresAt = current === 'ACTIVE' ? await issueTemporaryCredential(tx, customerId, hash, hours) : null;
      if (expiresAt === null) {
        return 'CONFLICT';
      }
      await this.audit(tx, access, customerId, 'PASSWORD_RESET_ISSUE', true, correlationId);
      return expiresAt;
    });
  }

  /** Reconfere o acesso do ator e trava o cliente do workspace; senão devolve `denied`. */
  private onCustomer<T>(
    access: WorkspaceAccess,
    customerId: string,
    denied: T,
    work: (tx: Transaction, status: string) => Promise<T>,
  ): Promise<T> {
    return this.guard(() =>
      this.client.$transaction(async (tx) => {
        await lockFacilitatorUse(tx, access.identityId);
        const allowed = await tx.$queryRaw<unknown[]>`
          SELECT 1 AS "ok" FROM "user_identity" f
            JOIN "workspace_membership" m ON m."identity_id" = f."id" AND m."status" = 'ACTIVE'
           WHERE f."id" = ${access.identityId}::uuid AND f."status" = 'ACTIVE' AND f."profile" = 'FACILITATOR'
             AND m."workspace_id" = ${access.workspaceId}::uuid`;
        if (allowed.length !== 1) {
          return denied;
        }
        const [customer] = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status"::text AS "status" FROM "user_identity"
           WHERE "id" = ${customerId}::uuid AND "workspace_id" = ${access.workspaceId}::uuid AND "profile" = 'CUSTOMER'
             FOR NO KEY UPDATE`;
        return customer === undefined ? denied : work(tx, customer.status);
      }, TRANSACTION_OPTIONS),
    );
  }

  private audit(
    tx: Transaction,
    access: WorkspaceAccess,
    customerId: string,
    operation: AuditOperation,
    changed: boolean,
    correlationId: string,
  ): Promise<void> {
    return insertAudit(tx, {
      actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
      workspaceId: access.workspaceId,
      operation,
      resource: 'IDENTITY',
      resourceId: customerId,
      changed,
      correlationId,
    });
  }

  private async guard<T>(work: () => PromiseLike<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
