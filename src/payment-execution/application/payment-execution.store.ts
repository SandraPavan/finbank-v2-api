import type { OperationType } from '../domain/reversal.js';
import type { AccountKind, LedgerEntryDraft } from '../domain/transfer.js';

/** Operação já registrada no workspace. */
export interface StoredOperation {
  readonly operationId: string;
  readonly type: OperationType;
  /** Operação estornada (somente REVERSAL). */
  readonly reversesOperationId: string | null;
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
  readonly type: OperationType;
  readonly reversesOperationId: string | null;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amountCents: bigint;
}

/**
 * CREATED: operação nova registrada. KEY_EXISTS: a chave já existe no workspace (repetição ou conflito,
 * decidido pela aplicação). ALREADY_REVERSED: a operação de origem já tem outro estorno.
 */
export type RegisterOperationResult =
  | { readonly outcome: 'CREATED'; readonly operationId: string }
  | { readonly outcome: 'KEY_EXISTS'; readonly existing: StoredOperation }
  | { readonly outcome: 'ALREADY_REVERSED' };

/**
 * Unidade de trabalho transacional. Toda a decisão financeira fica na aplicação;
 * o adaptador apenas persiste, trava e traduz erros do banco para erros tipados.
 */
export interface PaymentExecutionTransaction {
  /** Operação do workspace pelo id; operação de outro workspace não é devolvida. */
  findOperation(workspaceId: string, operationId: string): Promise<StoredOperation | null>;
  /** Registra a operação; chave existente ou estorno já existente não inserem nada. */
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
