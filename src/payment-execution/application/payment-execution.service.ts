import { type CreditCommand, creditFingerprint, parseCreditCommand } from '../domain/credit.js';
import { PaymentExecutionError } from '../domain/errors.js';
import { type OperationType, parseReversalCommand, reversalFingerprint, reversalMovement } from '../domain/reversal.js';
import {
  balanceAfterCredit,
  balanceAfterDebit,
  ledgerEntriesFor,
  type Movement,
  type PaymentModality,
  parseAccountKind,
  parseTransferCommand,
  parseUuid,
  transferFingerprint,
} from '../domain/transfer.js';
import type {
  AccountView,
  PaymentExecutionStore,
  PaymentExecutionTransaction,
  RegisterOperationInput,
} from './payment-execution.store.js';

export interface ExecutionResult {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly type: OperationType;
  /** Operação estornada (somente REVERSAL). */
  readonly reversesOperationId: string | null;
  /** Origem funcional (somente TRANSFER, quando informada). */
  readonly modality: PaymentModality | null;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amountCents: bigint;
  /** true quando a chave já tinha sido executada com o mesmo conteúdo. */
  readonly replayed: boolean;
}

/**
 * PaymentExecution: único caminho que altera saldos materializados.
 * Lançamentos e saldos mudam na mesma transação; a idempotência compara o conteúdo.
 * Correções são operações compensatórias (estorno), nunca edição do ledger.
 */
export class PaymentExecutionService {
  constructor(private readonly store: PaymentExecutionStore) {}

  async openAccount(rawWorkspaceId: unknown, rawKind: unknown): Promise<AccountView> {
    const workspaceId = parseUuid(rawWorkspaceId, 'workspaceId');
    const kind = parseAccountKind(rawKind);
    return this.store.createAccount(workspaceId, kind);
  }

  async execute(raw: unknown): Promise<ExecutionResult> {
    const command = parseTransferCommand(raw);
    const fingerprint = transferFingerprint(command);

    return this.store.transaction((tx) =>
      run(tx, {
        workspaceId: command.workspaceId,
        operationKey: command.operationKey,
        fingerprint,
        type: 'TRANSFER',
        reversesOperationId: null,
        modality: command.modality,
        debitAccountId: command.debitAccountId,
        creditAccountId: command.creditAccountId,
        amountCents: command.amountCents,
      }),
    );
  }

  /**
   * Crédito educacional: da contrapartida do workspace para uma conta comum ativa, com idempotência
   * própria. Limites e autorização ficam com o caso de uso que o chama.
   */
  async credit(raw: unknown): Promise<ExecutionResult> {
    const command = parseCreditCommand(raw);
    return this.store.transaction((tx) => creditIn(tx, command));
  }

  /** Estorno total de uma transferência: nova operação vinculada, contas invertidas, mesmo valor. */
  async reverse(raw: unknown): Promise<ExecutionResult> {
    const command = parseReversalCommand(raw);
    const fingerprint = reversalFingerprint(command);

    return this.store.transaction(async (tx) => {
      const original = await tx.findOperation(command.workspaceId, command.originalOperationId);
      if (original === null) {
        throw new PaymentExecutionError('OPERATION_NOT_FOUND');
      }
      const movement: Movement = reversalMovement(original);
      return run(tx, {
        workspaceId: command.workspaceId,
        operationKey: command.operationKey,
        fingerprint,
        type: 'REVERSAL',
        reversesOperationId: original.operationId,
        modality: null,
        ...movement,
      });
    });
  }
}

/**
 * Crédito educacional na transação recebida: a mesma lógica serve à transação própria e à de quem chama
 * (por exemplo, o crédito por HTTP, que grava registro e auditoria na mesma transação).
 */
export async function creditInTransaction(tx: PaymentExecutionTransaction, raw: unknown): Promise<ExecutionResult> {
  return creditIn(tx, parseCreditCommand(raw));
}

async function creditIn(tx: PaymentExecutionTransaction, command: CreditCommand): Promise<ExecutionResult> {
  const contra = await tx.findContraAccount(command.workspaceId);
  if (contra === null) {
    throw new PaymentExecutionError('CONTRA_ACCOUNT_MISSING');
  }
  if (contra === command.accountId) {
    throw new PaymentExecutionError('ACCOUNT_NOT_ELIGIBLE');
  }
  return run(
    tx,
    {
      workspaceId: command.workspaceId,
      operationKey: command.operationKey,
      fingerprint: creditFingerprint(command),
      type: 'EDUCATIONAL_CREDIT',
      reversesOperationId: null,
      modality: null,
      debitAccountId: contra,
      creditAccountId: command.accountId,
      amountCents: command.amountCents,
    },
    command.ceilingCents,
  );
}

/**
 * Registra a operação e, se for nova, aplica lançamentos e saldos na transação recebida.
 * A repetição é devolvida antes das conferências de estado: não movimenta nada.
 */
async function run(tx: PaymentExecutionTransaction, input: RegisterOperationInput, ceilingCents: bigint | null = null): Promise<ExecutionResult> {
  const workspaceStatus = await tx.lockWorkspace(input.workspaceId);
  const registration = await tx.registerOperation(input);
  if (registration.outcome === 'ALREADY_REVERSED') {
    throw new PaymentExecutionError('ALREADY_REVERSED');
  }
  if (registration.outcome === 'KEY_EXISTS') {
    const existing = registration.existing;
    if (existing.fingerprint !== input.fingerprint) {
      throw new PaymentExecutionError('IDEMPOTENCY_CONFLICT');
    }
    return Object.freeze({
      operationId: existing.operationId,
      workspaceId: input.workspaceId,
      type: existing.type,
      reversesOperationId: existing.reversesOperationId,
      modality: existing.modality,
      debitAccountId: existing.debitAccountId,
      creditAccountId: existing.creditAccountId,
      amountCents: existing.amountCents,
      replayed: true,
    });
  }

  if (workspaceStatus === null) {
    throw new PaymentExecutionError('ACCOUNT_NOT_FOUND');
  }
  if (workspaceStatus !== 'ACTIVE') {
    throw new PaymentExecutionError('WORKSPACE_ARCHIVED');
  }
  const locked = await tx.lockAccounts(input.workspaceId, [input.debitAccountId, input.creditAccountId]);
  const debit = locked.find((account) => account.id === input.debitAccountId);
  const credit = locked.find((account) => account.id === input.creditAccountId);
  if (debit === undefined || credit === undefined) {
    throw new PaymentExecutionError('ACCOUNT_NOT_FOUND');
  }
  if (debit.status !== 'ACTIVE' || credit.status !== 'ACTIVE') {
    throw new PaymentExecutionError('ACCOUNT_BLOCKED');
  }
  if (input.type === 'EDUCATIONAL_CREDIT' && (debit.kind !== 'CONTRA' || credit.kind !== 'STANDARD')) {
    throw new PaymentExecutionError('ACCOUNT_NOT_ELIGIBLE');
  }
  // Teto acumulado sob a trava da conta: créditos simultâneos são somados um depois do outro.
  if (ceilingCents !== null) {
    const previous = await tx.sumEducationalCredits(input.workspaceId, credit.id, registration.operationId);
    if (previous + input.amountCents > ceilingCents) {
      throw new PaymentExecutionError('CREDIT_LIMIT_EXCEEDED');
    }
  }

  const debitBalance = balanceAfterDebit(debit.kind, debit.balanceCents, input.amountCents);
  const creditBalance = balanceAfterCredit(credit.balanceCents, input.amountCents);

  await tx.insertEntries(input.workspaceId, registration.operationId, ledgerEntriesFor(input));
  await tx.setBalance(input.workspaceId, debit.id, debitBalance);
  await tx.setBalance(input.workspaceId, credit.id, creditBalance);

  return Object.freeze({
    operationId: registration.operationId,
    workspaceId: input.workspaceId,
    type: input.type,
    reversesOperationId: input.reversesOperationId,
    modality: input.modality,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
    amountCents: input.amountCents,
    replayed: false,
  });
}
