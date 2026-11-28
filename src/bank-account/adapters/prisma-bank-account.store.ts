import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { insertAudit } from '../../audit/adapters/insert-audit.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { readCustomerAccount } from '../../payment-execution/adapters/prisma-account-ledger.reader.js';
import { changeAccountStatus } from '../../payment-execution/adapters/prisma-payment-execution.store.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockFacilitatorUse } from '../../persistence/facilitator-locks.js';
import { lockWorkspaceUse } from '../../persistence/workspace-locks.js';
import type { BankAccountStore, StatusChangeResult, StoredCustomerAccount } from '../application/bank-account.service.js';
import type { BankAccountStatus } from '../domain/account-status.js';

const TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 };

function isStatus(value: string): value is BankAccountStatus {
  return value === 'ACTIVE' || value === 'BLOCKED';
}

export class PrismaBankAccountStore implements BankAccountStore {
  constructor(private readonly client: PrismaClient) {}

  view(workspaceId: string, customerId: string): Promise<StoredCustomerAccount | null> {
    return this.guard(async () => {
      const account = await readCustomerAccount(this.client, workspaceId, customerId);
      if (account === null) {
        return null;
      }
      const history = await this.client.$queryRaw<{ fromStatus: string; toStatus: string; justification: string; changedBy: string; changedAt: Date }[]>`
        SELECT "from_status"::text AS "fromStatus", "to_status"::text AS "toStatus", "justification",
               "changed_by"::text AS "changedBy", "changed_at" AS "changedAt"
          FROM "account_status_change"
         WHERE "workspace_id" = ${workspaceId}::uuid AND "account_id" = ${account.accountId}::uuid
         ORDER BY "changed_at" DESC, "id" DESC`;
      if (!isStatus(account.status) || history.some((h) => !isStatus(h.fromStatus) || !isStatus(h.toStatus))) {
        throw new IdentityError('ACCESS_CHECK_FAILED');
      }
      return {
        customerId,
        accountId: account.accountId,
        status: account.status,
        balance: account.balance,
        history: history.map((h) => ({
          fromStatus: h.fromStatus as BankAccountStatus,
          toStatus: h.toStatus as BankAccountStatus,
          justification: h.justification,
          changedBy: h.changedBy,
          changedAt: h.changedAt.toISOString(),
        })),
      };
    });
  }

  change(access: WorkspaceAccess, customerId: string, status: BankAccountStatus, justification: string, correlationId: string): Promise<StatusChangeResult> {
    return this.guard(() =>
      this.client.$transaction(async (tx): Promise<StatusChangeResult> => {
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
        const [link] = await tx.$queryRaw<{ accountId: string }[]>`
          SELECT "account_id"::text AS "accountId" FROM "customer_account"
           WHERE "identity_id" = ${customerId}::uuid AND "workspace_id" = ${access.workspaceId}::uuid`;
        if (link === undefined) {
          return { kind: 'NOT_FOUND' };
        }
        const previous = await changeAccountStatus(tx, access.workspaceId, link.accountId, status);
        if (previous === null) {
          return { kind: 'NOT_FOUND' };
        }
        if (previous === status) {
          return { kind: 'UNCHANGED', accountId: link.accountId, status };
        }
        await tx.$executeRaw`
          INSERT INTO "account_status_change" ("workspace_id", "account_id", "from_status", "to_status", "justification", "changed_by")
          VALUES (${access.workspaceId}::uuid, ${link.accountId}::uuid, ${previous}::"account_status", ${status}::"account_status",
                  ${justification}, ${access.identityId}::uuid)`;
        await insertAudit(tx, {
          actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
          workspaceId: access.workspaceId,
          operation: status === 'BLOCKED' ? 'ACCOUNT_BLOCK' : 'ACCOUNT_UNBLOCK',
          resource: 'ACCOUNT',
          resourceId: link.accountId,
          changed: true,
          correlationId,
        });
        return { kind: 'CHANGED', accountId: link.accountId, status };
      }, TRANSACTION),
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
