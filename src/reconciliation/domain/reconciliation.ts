import { ReconciliationError } from './errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Conta com o saldo materializado e a soma dos seus lançamentos, lidos no mesmo snapshot. */
export interface AccountSnapshot {
  readonly accountId: string;
  readonly recordedCents: bigint;
  readonly ledgerCents: bigint;
}

/** Operação cujos lançamentos não são exatamente dois somando zero. */
export interface UnbalancedOperationSnapshot {
  readonly operationId: string;
  readonly entryCount: number;
  readonly sumCents: bigint;
}

export interface WorkspaceSnapshot {
  readonly accounts: readonly AccountSnapshot[];
  readonly operationCount: number;
  readonly unbalancedOperations: readonly UnbalancedOperationSnapshot[];
}

export type Divergence =
  | {
      readonly type: 'BALANCE_MISMATCH';
      readonly accountId: string;
      readonly recordedCents: bigint;
      readonly ledgerCents: bigint;
    }
  | { readonly type: 'UNBALANCED_OPERATION'; readonly operationId: string; readonly entryCount: number; readonly sumCents: bigint }
  | { readonly type: 'WORKSPACE_TOTAL_NONZERO'; readonly totalCents: bigint };

/** Evidência da reconciliação. Somente relata: nenhuma correção é feita. */
export interface ReconciliationReport {
  readonly workspaceId: string;
  readonly accountCount: number;
  readonly operationCount: number;
  readonly consistent: boolean;
  readonly divergences: readonly Divergence[];
}

export function parseWorkspaceId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw new ReconciliationError('INVALID_INPUT');
  }
  return raw;
}

/** Compara saldo materializado e ledger, o equilíbrio das operações e o total do workspace. */
export function reconcile(workspaceId: string, snapshot: WorkspaceSnapshot): ReconciliationReport {
  const divergences: Divergence[] = [];
  let totalCents = 0n;
  for (const account of snapshot.accounts) {
    totalCents += account.recordedCents;
    if (account.recordedCents !== account.ledgerCents) {
      divergences.push(
        Object.freeze({
          type: 'BALANCE_MISMATCH',
          accountId: account.accountId,
          recordedCents: account.recordedCents,
          ledgerCents: account.ledgerCents,
        }),
      );
    }
  }
  for (const operation of snapshot.unbalancedOperations) {
    if (operation.entryCount !== 2 || operation.sumCents !== 0n) {
      divergences.push(
        Object.freeze({
          type: 'UNBALANCED_OPERATION',
          operationId: operation.operationId,
          entryCount: operation.entryCount,
          sumCents: operation.sumCents,
        }),
      );
    }
  }
  if (totalCents !== 0n) {
    divergences.push(Object.freeze({ type: 'WORKSPACE_TOTAL_NONZERO', totalCents }));
  }
  return Object.freeze({
    workspaceId,
    accountCount: snapshot.accounts.length,
    operationCount: snapshot.operationCount,
    consistent: divergences.length === 0,
    divergences: Object.freeze(divergences),
  });
}
