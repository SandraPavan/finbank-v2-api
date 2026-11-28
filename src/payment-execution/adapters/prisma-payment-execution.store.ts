import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { databaseErrorCode } from '../../persistence/database-errors.js';
import { lockWorkspaceUse } from '../../persistence/workspace-locks.js';
import type {
  AccountStatus,
  AccountView,
  LockedAccount,
  PaymentExecutionStore,
  PaymentExecutionTransaction,
  RegisterOperationInput,
  RegisterOperationResult,
  StoredOperation,
  WorkspaceStatus,
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

const OPERATION_SELECT = {
  id: true,
  type: true,
  reversesOperationId: true,
  modality: true,
  fingerprint: true,
  debitAccountId: true,
  creditAccountId: true,
  amountCents: true,
} as const;

type OperationRow = Prisma.PaymentOperationGetPayload<{ select: typeof OPERATION_SELECT }>;

function toStored(row: OperationRow): StoredOperation {
  return {
    operationId: row.id,
    type: row.type,
    reversesOperationId: row.reversesOperationId,
    modality: row.modality,
    fingerprint: row.fingerprint,
    debitAccountId: row.debitAccountId,
    creditAccountId: row.creditAccountId,
    amountCents: row.amountCents,
  };
}

class PrismaPaymentExecutionTransaction implements PaymentExecutionTransaction {
  constructor(private readonly tx: Tx) {}

  async lockWorkspace(workspaceId: string): Promise<WorkspaceStatus | null> {
    await lockWorkspaceUse(this.tx, workspaceId);
    const rows = await this.tx.$queryRaw<{ status: WorkspaceStatus }[]>`
      SELECT "status"::text AS "status" FROM "workspace" WHERE "id" = ${workspaceId}::uuid`;
    return rows[0]?.status ?? null;
  }

  async findContraAccount(workspaceId: string): Promise<string | null> {
    const rows = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS "id" FROM "account" WHERE "workspace_id" = ${workspaceId}::uuid AND "kind" = 'CONTRA'`;
    return rows[0]?.id ?? null;
  }

  async findOperation(workspaceId: string, operationId: string): Promise<StoredOperation | null> {
    const operation = await this.tx.paymentOperation.findUnique({
      where: { workspaceId_id: { workspaceId, id: operationId } },
      select: OPERATION_SELECT,
    });
    return operation === null ? null : toStored(operation);
  }

  async registerOperation(input: RegisterOperationInput): Promise<RegisterOperationResult> {
    // ON CONFLICT sem alvo cobre a chave (workspace, operationKey) e o vínculo único do estorno.
    // Em conflito com transação concorrente, espera ela terminar: se confirmou, nada é inserido
    // e a operação existente é lida pela chave e, não havendo, pela operação de origem.
    const inserted = await this.tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "payment_operation"
        ("workspace_id", "operation_key", "fingerprint", "type", "reverses_operation_id", "modality",
         "debit_account_id", "credit_account_id", "amount_cents")
      VALUES (${input.workspaceId}::uuid, ${input.operationKey}, ${input.fingerprint},
              ${input.type}::"operation_type", ${input.reversesOperationId}::uuid, ${input.modality}::"payment_modality",
              ${input.debitAccountId}::uuid, ${input.creditAccountId}::uuid, ${input.amountCents})
      ON CONFLICT DO NOTHING
      RETURNING "id"::text AS "id"`;
    const created = inserted[0];
    if (created !== undefined) {
      return { outcome: 'CREATED', operationId: created.id };
    }
    const existing = await this.tx.paymentOperation.findUnique({
      where: { workspaceId_operationKey: { workspaceId: input.workspaceId, operationKey: input.operationKey } },
      select: OPERATION_SELECT,
    });
    if (existing !== null) {
      return { outcome: 'KEY_EXISTS', existing: toStored(existing) };
    }
    if (input.reversesOperationId !== null) {
      const reversal = await this.tx.paymentOperation.findUnique({
        where: {
          workspaceId_reversesOperationId: {
            workspaceId: input.workspaceId,
            reversesOperationId: input.reversesOperationId,
          },
        },
        select: { id: true },
      });
      if (reversal !== null) {
        return { outcome: 'ALREADY_REVERSED' };
      }
    }
    throw new PaymentExecutionError('EXECUTION_FAILED');
  }

  async lockAccounts(workspaceId: string, accountIds: readonly string[]): Promise<readonly LockedAccount[]> {
    // FOR NO KEY UPDATE em ordem de id: serializa alterações de saldo sem conflitar com as
    // travas KEY SHARE das chaves estrangeiras, evitando deadlock entre movimentações cruzadas.
    const rows = await this.tx.$queryRaw<{ id: string; kind: AccountKind; status: AccountStatus; balance_cents: bigint }[]>`
      SELECT "id"::text AS "id", "kind"::text AS "kind", "status"::text AS "status", "balance_cents"
        FROM "account"
       WHERE "workspace_id" = ${workspaceId}::uuid
         AND "id" = ANY(${[...accountIds]}::uuid[])
       ORDER BY "id"
         FOR NO KEY UPDATE`;
    return rows.map((row) => ({ id: row.id, kind: row.kind, status: row.status, balanceCents: row.balance_cents }));
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

/**
 * Abre a conta comum de um cliente, com saldo zero, dentro da transação de quem chama (aprovação do onboarding).
 * Única outra inserção de conta além de `createAccount`; não movimenta nada nem escreve saldo.
 */
export async function openCustomerAccount(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, workspaceId: string): Promise<string> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "account" ("workspace_id", "kind") VALUES (${workspaceId}::uuid, 'STANDARD') RETURNING "id"::text AS "id"`;
  if (row === undefined) {
    throw new PaymentExecutionError('EXECUTION_FAILED');
  }
  return row.id;
}

/**
 * Muda o estado de uma conta comum do workspace dentro da transação de quem chama, sob a mesma trava de linha
 * das movimentações: bloqueio e movimentação ficam serializados. Nunca toca o saldo.
 * Devolve o estado anterior, ou null se a conta comum não existe no workspace.
 */
export async function changeAccountStatus(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>,
  workspaceId: string,
  accountId: string,
  status: AccountStatus,
): Promise<AccountStatus | null> {
  const [row] = await tx.$queryRaw<{ status: AccountStatus }[]>`
    SELECT "status"::text AS "status" FROM "account"
     WHERE "workspace_id" = ${workspaceId}::uuid AND "id" = ${accountId}::uuid AND "kind" = 'STANDARD'
     FOR NO KEY UPDATE`;
  if (row === undefined) {
    return null;
  }
  if (row.status !== status) {
    await tx.$executeRaw`
      UPDATE "account" SET "status" = ${status}::"account_status" WHERE "workspace_id" = ${workspaceId}::uuid AND "id" = ${accountId}::uuid`;
  }
  return row.status;
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
      // Última defesa do banco: saldo negativo em conta comum, operação desequilibrada ou estorno incoerente.
      return new PaymentExecutionError('EXECUTION_FAILED', { technicalCode, cause: error });
    case NUMERIC_OUT_OF_RANGE:
      return new PaymentExecutionError('AMOUNT_OUT_OF_RANGE', { technicalCode });
  }
  return new PaymentExecutionError('EXECUTION_FAILED', { technicalCode, cause: error });
}
