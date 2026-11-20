import type { AccountKind, LedgerEntryDraft } from '../domain/transfer.js';

/** Operação já registrada para uma chave (workspace + operationKey). */
export interface StoredOperation {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amountCents: bigint;
}

export interface LockedAccount {
  readonly id: string;
  readonly kind: AccountKind;
  readonly balanceCents: bigint;
}

export interface AccountView {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: AccountKind;
  readonly balanceCents: bigint;
}

export interface RegisterOperationInput {
  readonly workspaceId: string;
  readonly operationKey: string;
  readonly fingerprint: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amountCents: bigint;
}

export type RegisterOperationResult =
  | { readonly created: true; readonly operationId: string }
  | { readonly created: false; readonly existing: StoredOperation };

/**
 * Unidade de trabalho transacional. Toda a decisão financeira fica na aplicação;
 * o adaptador apenas persiste, trava e traduz erros do banco para erros tipados.
 */
export interface PaymentExecutionTransaction {
  /** Registra a operação; se a chave já existir no workspace, devolve a existente. */
  registerOperation(input: RegisterOperationInput): Promise<RegisterOperationResult>;
  /** Trava as contas do workspace em ordem de id; contas ausentes não são devolvidas. */
  lockAccounts(workspaceId: string, accountIds: readonly string[]): Promise<readonly LockedAccount[]>;
  insertEntries(workspaceId: string, operationId: string, entries: readonly LedgerEntryDraft[]): Promise<void>;
  setBalance(workspaceId: string, accountId: string, balanceCents: bigint): Promise<void>;
}

export interface PaymentExecutionStore {
  /** Executa `work` numa única transação; qualquer erro desfaz tudo. */
  transaction<T>(work: (tx: PaymentExecutionTransaction) => Promise<T>): Promise<T>;
  /** Cria conta com saldo zero (não é movimentação financeira). */
  createAccount(workspaceId: string, kind: AccountKind): Promise<AccountView>;
}
