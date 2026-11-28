// Leitura do saldo materializado e dos lançamentos de uma conta de cliente. Somente SELECT: nada aqui escreve.
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { AccountStatus } from '../application/payment-execution.store.js';

type Reader = Pick<PrismaClient, '$queryRaw'>;

/** Conta comum ligada ao cliente no workspace, com o saldo materializado em centavos. */
export interface CustomerAccountBalance {
  readonly accountId: string;
  readonly status: AccountStatus;
  readonly balance: bigint;
}

/** Lançamento da conta com a operação que o originou. Valor com sinal: positivo entra, negativo sai. */
export interface AccountLedgerRow {
  readonly entryId: string;
  readonly operationId: string;
  readonly type: string;
  readonly modality: string | null;
  readonly amountCents: bigint;
  readonly reversesOperationId: string | null;
  readonly occurredAt: Date;
}

/** Posição de continuação: lançamentos estritamente anteriores a (instante, id) na ordem decrescente. */
export interface LedgerPosition {
  readonly occurredAt: Date;
  readonly entryId: string;
}

/** Conta do cliente no workspace; null se o cliente não tem conta nele. */
export async function readCustomerAccount(client: Reader, workspaceId: string, customerId: string): Promise<CustomerAccountBalance | null> {
  const [row] = await client.$queryRaw<{ accountId: string; status: AccountStatus; balance: bigint }[]>`
    SELECT a."id"::text AS "accountId", a."status"::text AS "status", a."balance_cents" AS "balance"
      FROM "customer_account" ca
      JOIN "account" a ON a."workspace_id" = ca."workspace_id" AND a."id" = ca."account_id"
     WHERE ca."identity_id" = ${customerId}::uuid AND ca."workspace_id" = ${workspaceId}::uuid AND a."kind" = 'STANDARD'`;
  return row ?? null;
}

/** Lançamentos de uma conta do workspace, do mais recente ao mais antigo, com desempate pelo id. */
export async function readAccountEntries(
  client: Reader,
  workspaceId: string,
  accountId: string,
  limit: number,
  after: LedgerPosition | null,
): Promise<AccountLedgerRow[]> {
  const continuation =
    after === null ? Prisma.empty : Prisma.sql`AND (e."created_at", e."id") < (${after.occurredAt}::timestamptz, ${after.entryId}::uuid)`;
  return client.$queryRaw<AccountLedgerRow[]>`
    SELECT e."id"::text AS "entryId", e."operation_id"::text AS "operationId", o."type"::text AS "type",
           o."modality"::text AS "modality", e."amount_cents" AS "amountCents",
           o."reverses_operation_id"::text AS "reversesOperationId", e."created_at" AS "occurredAt"
      FROM "ledger_entry" e
      JOIN "payment_operation" o ON o."workspace_id" = e."workspace_id" AND o."id" = e."operation_id"
     WHERE e."workspace_id" = ${workspaceId}::uuid AND e."account_id" = ${accountId}::uuid
       ${continuation}
     ORDER BY e."created_at" DESC, e."id" DESC
     LIMIT ${limit}`;
}
