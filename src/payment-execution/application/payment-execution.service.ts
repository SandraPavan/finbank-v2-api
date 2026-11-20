import { PaymentExecutionError } from '../domain/errors.js';
import {
  balanceAfterCredit,
  balanceAfterDebit,
  ledgerEntriesFor,
  parseAccountKind,
  parseTransferCommand,
  parseUuid,
  transferFingerprint,
} from '../domain/transfer.js';
import type { AccountView, PaymentExecutionStore } from './payment-execution.store.js';

export interface ExecutionResult {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amountCents: bigint;
  /** true quando a chave já tinha sido executada com o mesmo conteúdo. */
  readonly replayed: boolean;
}

/**
 * PaymentExecution: único caminho que altera saldos materializados.
 * Lançamentos e saldos mudam na mesma transação; a idempotência compara o conteúdo.
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

    return this.store.transaction(async (tx) => {
      const registration = await tx.registerOperation({ ...command, fingerprint });
      if (!registration.created) {
        const existing = registration.existing;
        if (existing.fingerprint !== fingerprint) {
          throw new PaymentExecutionError('IDEMPOTENCY_CONFLICT');
        }
        return Object.freeze({
          operationId: existing.operationId,
          workspaceId: command.workspaceId,
          debitAccountId: existing.debitAccountId,
          creditAccountId: existing.creditAccountId,
          amountCents: existing.amountCents,
          replayed: true,
        });
      }

      const locked = await tx.lockAccounts(command.workspaceId, [command.debitAccountId, command.creditAccountId]);
      const debit = locked.find((account) => account.id === command.debitAccountId);
      const credit = locked.find((account) => account.id === command.creditAccountId);
      if (debit === undefined || credit === undefined) {
        throw new PaymentExecutionError('ACCOUNT_NOT_FOUND');
      }

      const debitBalance = balanceAfterDebit(debit.kind, debit.balanceCents, command.amountCents);
      const creditBalance = balanceAfterCredit(credit.balanceCents, command.amountCents);

      await tx.insertEntries(command.workspaceId, registration.operationId, ledgerEntriesFor(command));
      await tx.setBalance(command.workspaceId, debit.id, debitBalance);
      await tx.setBalance(command.workspaceId, credit.id, creditBalance);

      return Object.freeze({
        operationId: registration.operationId,
        workspaceId: command.workspaceId,
        debitAccountId: command.debitAccountId,
        creditAccountId: command.creditAccountId,
        amountCents: command.amountCents,
        replayed: false,
      });
    });
  }
}
