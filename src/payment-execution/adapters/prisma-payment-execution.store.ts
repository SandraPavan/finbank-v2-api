import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import type {
  AccountView,
  LockedAccount,
  PaymentExecutionStore,
  PaymentExecutionTransaction,
  RegisterOperationInput,
  RegisterOperationResult,
} from '../application/payment-execution.store.js';
import { PaymentExecutionError } from '../domain/errors.js';
import type { AccountKind, LedgerEntryDraft } from '../domain/transfer.js';

/** Limites técnicos da transação interativa (não são metas operacionais). */
export const TRANSACTION_MAX_WAIT_MS = 5_000;
export const TRANSACTION_TIMEOUT_MS = 10_000;

// SQLSTATE do PostgreSQL traduzidos para erros tipados.
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NUMERIC_OUT_OF_RANGE = '22003';

type Tx = Prisma.TransactionClient;

class PrismaPaymentExecutionTransaction implements PaymentExecutionTransaction {
  constructor(private readonly tx: Tx) {}

  async registerOperation(input: RegisterOperationInput): Promise<RegisterOperationResult> {
    // ON CONFLICT espera a transação concorrente com a mesma chave terminar:
    // se ela confirmou, nada é inserido e a operação existente é lida e comparada.
    const inserted = await this.tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "payment_operation"
        ("workspace_id", "operation_key", "fingerprint", "debit_account_id", "credit_account_id", "amount_cents")
      VALUES (${input.workspaceId}::uuid, ${input.operationKey}, ${input.fingerprint},
              ${input.debitAccountId}::uuid, ${input.creditAccountId}::uuid, ${input.amountCents})
      ON CONFLICT ("workspace_id", "operation_key") DO NOTHING
      RETURNING "id"::text AS "id"`;
    const created = inserted[0];
    if (created !== undefined) {
      return { created: true, operationId: created.id };
    }
    const existing = await this.tx.paymentOperation.findUnique({
      where: { workspaceId_operationKey: { workspaceId: input.workspaceId, operationKey: input.operationKey } },
      select: { id: true, fingerprint: true, debitAccountId: true, creditAccountId: true, amountCents: true },
    });
    if (existing === null) {
      throw new PaymentExecutionError('EXECUTION_FAILED');
    }
    return {
      created: false,
      existing: {
        operationId: existing.id,
        fingerprint: existing.fingerprint,
        debitAccountId: existing.debitAccountId,
        creditAccountId: existing.creditAccountId,
        amountCents: existing.amountCents,
      },
    };
  }

  async lockAccounts(workspaceId: string, accountIds: readonly string[]): Promise<readonly LockedAccount[]> {
    // FOR NO KEY UPDATE em ordem de id: serializa alterações de saldo sem conflitar com as
    // travas KEY SHARE das chaves estrangeiras, evitando deadlock entre movimentações cruzadas.
    const rows = await this.tx.$queryRaw<{ id: string; kind: AccountKind; balance_cents: bigint }[]>`
      SELECT "id"::text AS "id", "kind"::text AS "kind", "balance_cents"
        FROM "account"
       WHERE "workspace_id" = ${workspaceId}::uuid
         AND "id" = ANY(${[...accountIds]}::uuid[])
       ORDER BY "id"
         FOR NO KEY UPDATE`;
    return rows.map((row) => ({ id: row.id, kind: row.kind, balanceCents: row.balance_cents }));
  }

  async insertEntries(workspaceId: string, operationId: string, entries: readonly LedgerEntryDraft[]): Promise<void> {
    await this.tx.ledgerEntry.createMany({
      data: entries.map((entry) => ({
        workspaceId,
        operationId,
        accountId: entry.accountId,
        amountCents: entry.amountCents,
      })),
    });
  }

  async setBalance(workspaceId: string, accountId: string, balanceCents: bigint): Promise<void> {
    await this.tx.account.update({
      where: { workspaceId_id: { workspaceId, id: accountId } },
      data: { balanceCents },
    });
  }
}

/** Adaptador PostgreSQL/Prisma do PaymentExecution. */
export class PrismaPaymentExecutionStore implements PaymentExecutionStore {
  constructor(private readonly client: PrismaClient) {}

  async transaction<T>(work: (tx: PaymentExecutionTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction((tx) => work(new PrismaPaymentExecutionTransaction(tx)), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: TRANSACTION_MAX_WAIT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
      });
    } catch (error) {
      throw translate(error, 'ACCOUNT_NOT_FOUND');
    }
  }

  async createAccount(workspaceId: string, kind: AccountKind): Promise<AccountView> {
    try {
      const account = await this.client.account.create({
        data: { workspaceId, kind },
        select: { id: true, workspaceId: true, kind: true, balanceCents: true },
      });
      return Object.freeze({ ...account });
    } catch (error) {
      throw translate(error, 'WORKSPACE_NOT_FOUND');
    }
  }
}

function translate(error: unknown, onForeignKey: 'ACCOUNT_NOT_FOUND' | 'WORKSPACE_NOT_FOUND'): PaymentExecutionError {
  if (error instanceof PaymentExecutionError) {
    return error;
  }
  const technicalCode = databaseErrorCode(error);
  switch (technicalCode) {
    case FOREIGN_KEY_VIOLATION:
      return new PaymentExecutionError(onForeignKey, { technicalCode });
    case UNIQUE_VIOLATION:
      if (onForeignKey === 'WORKSPACE_NOT_FOUND') {
        return new PaymentExecutionError('DUPLICATE_CONTRA_ACCOUNT', { technicalCode });
      }
      break;
    case CHECK_VIOLATION:
      // Última defesa do banco: saldo negativo em conta comum ou operação desequilibrada.
      return new PaymentExecutionError('EXECUTION_FAILED', { technicalCode, cause: error });
    case NUMERIC_OUT_OF_RANGE:
      return new PaymentExecutionError('AMOUNT_OUT_OF_RANGE', { technicalCode });
  }
  return new PaymentExecutionError('EXECUTION_FAILED', { technicalCode, cause: error });
}
