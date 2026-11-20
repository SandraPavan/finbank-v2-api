import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type { ReconciliationReader } from '../application/reconciliation.reader.js';
import { ReconciliationError } from '../domain/errors.js';
import type { WorkspaceSnapshot } from '../domain/reconciliation.js';

/** Limites técnicos da transação de leitura (não são metas operacionais). */
export const READ_MAX_WAIT_MS = 5_000;
export const READ_TIMEOUT_MS = 30_000;

/**
 * Adaptador PostgreSQL/Prisma da reconciliação. Lê tudo numa transação REPEATABLE READ
 * somente leitura: o relatório inteiro vem de um único snapshot, sem travar as execuções.
 * Somas voltam como texto para não perder precisão nem estourar BIGINT.
 */
export class PrismaReconciliationReader implements ReconciliationReader {
  constructor(private readonly client: PrismaClient) {}

  async readSnapshot(workspaceId: string): Promise<WorkspaceSnapshot | null> {
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const workspace = await tx.$queryRaw<{ found: number }[]>`
            SELECT 1::int AS "found" FROM "workspace" WHERE "id" = ${workspaceId}::uuid`;
          if (workspace.length === 0) {
            return null;
          }
          const accounts = await tx.$queryRaw<{ id: string; recorded: string; ledger: string }[]>`
            SELECT a."id"::text AS "id",
                   a."balance_cents"::text AS "recorded",
                   coalesce(sum(e."amount_cents"), 0)::text AS "ledger"
              FROM "account" a
              LEFT JOIN "ledger_entry" e ON e."workspace_id" = a."workspace_id" AND e."account_id" = a."id"
             WHERE a."workspace_id" = ${workspaceId}::uuid
             GROUP BY a."id", a."balance_cents"
             ORDER BY a."id"`;
          const operations = await tx.$queryRaw<{ total: number }[]>`
            SELECT count(*)::int AS "total" FROM "payment_operation" WHERE "workspace_id" = ${workspaceId}::uuid`;
          const unbalanced = await tx.$queryRaw<{ id: string; entries: number; total: string }[]>`
            SELECT o."id"::text AS "id",
                   count(e."id")::int AS "entries",
                   coalesce(sum(e."amount_cents"), 0)::text AS "total"
              FROM "payment_operation" o
              LEFT JOIN "ledger_entry" e ON e."workspace_id" = o."workspace_id" AND e."operation_id" = o."id"
             WHERE o."workspace_id" = ${workspaceId}::uuid
             GROUP BY o."id"
            HAVING count(e."id") <> 2 OR coalesce(sum(e."amount_cents"), 0) <> 0
             ORDER BY o."id"`;
          return {
            accounts: accounts.map((row) => ({
              accountId: row.id,
              recordedCents: BigInt(row.recorded),
              ledgerCents: BigInt(row.ledger),
            })),
            operationCount: operations[0]?.total ?? 0,
            unbalancedOperations: unbalanced.map((row) => ({
              operationId: row.id,
              entryCount: row.entries,
              sumCents: BigInt(row.total),
            })),
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: READ_MAX_WAIT_MS,
          timeout: READ_TIMEOUT_MS,
        },
      );
    } catch (error) {
      throw new ReconciliationError('RECONCILIATION_FAILED', { technicalCode: databaseErrorCode(error), cause: error });
    }
  }
}
