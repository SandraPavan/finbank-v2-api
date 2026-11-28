import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { insertAudit } from '../../audit/adapters/insert-audit.js';
import { IdentityError } from '../../identity/domain/errors.js';
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import { creditWithin, ensureContraAccount } from '../../payment-execution/adapters/prisma-payment-execution.store.js';
import { PaymentExecutionError } from '../../payment-execution/domain/errors.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockFacilitatorUse } from '../../persistence/facilitator-locks.js';
import { lockWorkspaceUse } from '../../persistence/workspace-locks.js';
import type { CreditInput, CreditResult, EducationalCreditStore } from '../application/educational-credit.service.js';

const TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 };

/** Chave do núcleo derivada de tipo, ator e chave do pedido (ADR 011); o núcleo a torna única por workspace. */
export function creditOperationKey(actorId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`educational-credit|${actorId}|${idempotencyKey}`, 'utf8').digest('hex');
}

/** Recusas do núcleo que viram resultado; as demais seguem como falha. */
const PAYMENT_OUTCOMES: Partial<Record<string, CreditResult['kind']>> = {
  ACCOUNT_BLOCKED: 'BLOCKED',
  CREDIT_LIMIT_EXCEEDED: 'LIMIT',
  IDEMPOTENCY_CONFLICT: 'CONFLICT',
  WORKSPACE_ARCHIVED: 'ARCHIVED',
  ACCOUNT_NOT_FOUND: 'NOT_FOUND',
};

export class PrismaEducationalCreditStore implements EducationalCreditStore {
  constructor(private readonly client: PrismaClient) {}

  async credit(access: WorkspaceAccess, input: CreditInput, correlationId: string): Promise<CreditResult> {
    const operationKey = creditOperationKey(access.identityId, input.idempotencyKey);
    try {
      return await this.client.$transaction(async (tx): Promise<CreditResult> => {
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
           WHERE "identity_id" = ${input.customerId}::uuid AND "workspace_id" = ${access.workspaceId}::uuid`;
        if (link === undefined) {
          return { kind: 'NOT_FOUND' };
        }
        // Repetição antes dos limites: um limite reduzido depois não recusa um crédito já executado.
        const [previous] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"::text AS "id" FROM "payment_operation"
           WHERE "workspace_id" = ${access.workspaceId}::uuid AND "operation_key" = ${operationKey}`;
        if (previous === undefined && input.amountCents > input.limits.maxPerOperationCents) {
          return { kind: 'LIMIT' };
        }
        await ensureContraAccount(tx, access.workspaceId);
        const result = await creditWithin(tx, {
          workspaceId: access.workspaceId,
          operationKey,
          accountId: link.accountId,
          amountCents: input.amountCents,
          ceilingCents: input.limits.maxPerAccountCents,
        });
        if (result.replayed) {
          const [record] = await tx.$queryRaw<{ id: string; justification: string; createdBy: string }[]>`
            SELECT "id"::text AS "id", "justification", "created_by"::text AS "createdBy" FROM "educational_credit"
             WHERE "operation_id" = ${result.operationId}::uuid`;
          if (record === undefined || record.justification !== input.justification || record.createdBy !== access.identityId) {
            return { kind: 'CONFLICT' };
          }
          return { kind: 'CREDITED', replayed: true, credit: { creditId: record.id, operationId: result.operationId, accountId: link.accountId, amountCents: result.amountCents } };
        }
        const [record] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "educational_credit" ("workspace_id", "operation_id", "account_id", "amount_cents", "justification", "created_by", "operation_key")
          VALUES (${access.workspaceId}::uuid, ${result.operationId}::uuid, ${link.accountId}::uuid, ${input.amountCents},
                  ${input.justification}, ${access.identityId}::uuid, ${operationKey})
          RETURNING "id"::text AS "id"`;
        if (record === undefined) {
          throw new IdentityError('ACCESS_CHECK_FAILED');
        }
        await insertAudit(tx, {
          actor: { type: 'IDENTITY', identityId: access.identityId, profile: access.role },
          workspaceId: access.workspaceId,
          operation: 'EDUCATIONAL_CREDIT',
          resource: 'EDUCATIONAL_CREDIT',
          resourceId: record.id,
          changed: true,
          correlationId,
        });
        return { kind: 'CREDITED', replayed: false, credit: { creditId: record.id, operationId: result.operationId, accountId: link.accountId, amountCents: result.amountCents } };
      }, TRANSACTION);
    } catch (error) {
      if (error instanceof PaymentExecutionError) {
        const outcome = PAYMENT_OUTCOMES[error.code];
        if (outcome !== undefined && outcome !== 'CREDITED') {
          return { kind: outcome };
        }
      }
      throw error instanceof IdentityError ? error : new IdentityError('ACCESS_CHECK_FAILED', databaseErrorCode(error));
    }
  }
}
