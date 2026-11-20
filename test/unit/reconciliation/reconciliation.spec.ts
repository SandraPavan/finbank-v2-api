import { describe, expect, it } from 'vitest';
import type { ReconciliationReader } from '../../../src/reconciliation/application/reconciliation.reader.js';
import { ReconciliationService } from '../../../src/reconciliation/application/reconciliation.service.js';
import { ReconciliationError } from '../../../src/reconciliation/domain/errors.js';
import { reconcile, type WorkspaceSnapshot } from '../../../src/reconciliation/domain/reconciliation.js';

const WS = '0b6f7c1e-4a2d-4c3b-9e8f-112233445566';
const A = '1a1a1a1a-1111-4111-8111-111111111111';
const B = '2b2b2b2b-2222-4222-8222-222222222222';
const C = '3c3c3c3c-3333-4333-8333-333333333333';
const OP = '5e5e5e5e-5555-4555-8555-555555555555';

const clean: WorkspaceSnapshot = {
  accounts: [
    { accountId: C, recordedCents: -500n, ledgerCents: -500n },
    { accountId: A, recordedCents: 300n, ledgerCents: 300n },
    { accountId: B, recordedCents: 200n, ledgerCents: 200n },
  ],
  operationCount: 3,
  unbalancedOperations: [],
};

describe('reconcile', () => {
  it('workspace consistente não tem divergências', () => {
    const report = reconcile(WS, clean);
    expect(report).toEqual({ workspaceId: WS, accountCount: 3, operationCount: 3, consistent: true, divergences: [] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.divergences)).toBe(true);
  });

  it('saldo gravado diferente do ledger é BALANCE_MISMATCH e desequilibra o total', () => {
    const report = reconcile(WS, {
      ...clean,
      accounts: clean.accounts.map((a) => (a.accountId === B ? { ...a, recordedCents: 207n } : a)),
    });
    expect(report.consistent).toBe(false);
    expect(report.divergences).toEqual([
      { type: 'BALANCE_MISMATCH', accountId: B, recordedCents: 207n, ledgerCents: 200n },
      { type: 'WORKSPACE_TOTAL_NONZERO', totalCents: 7n },
    ]);
  });

  it('operação desequilibrada é UNBALANCED_OPERATION', () => {
    const report = reconcile(WS, { ...clean, unbalancedOperations: [{ operationId: OP, entryCount: 1, sumCents: -5n }] });
    expect(report.divergences).toEqual([{ type: 'UNBALANCED_OPERATION', operationId: OP, entryCount: 1, sumCents: -5n }]);
  });

  it('ignora linha equilibrada recebida por engano do adaptador', () => {
    const report = reconcile(WS, { ...clean, unbalancedOperations: [{ operationId: OP, entryCount: 2, sumCents: 0n }] });
    expect(report.consistent).toBe(true);
  });

  it('preserva valores acima do inteiro seguro do JavaScript', () => {
    const big = 2n ** 60n;
    const report = reconcile(WS, {
      accounts: [{ accountId: A, recordedCents: big + 1n, ledgerCents: big }],
      operationCount: 1,
      unbalancedOperations: [],
    });
    expect(report.divergences[0]).toEqual({ type: 'BALANCE_MISMATCH', accountId: A, recordedCents: big + 1n, ledgerCents: big });
  });

  it('workspace sem contas nem operações é consistente', () => {
    expect(reconcile(WS, { accounts: [], operationCount: 0, unbalancedOperations: [] }).consistent).toBe(true);
  });
});

describe('ReconciliationService', () => {
  function serviceWith(snapshot: WorkspaceSnapshot | null): { service: ReconciliationService; reads: string[] } {
    const reads: string[] = [];
    const reader: ReconciliationReader = {
      readSnapshot: (workspaceId) => {
        reads.push(workspaceId);
        return Promise.resolve(snapshot);
      },
    };
    return { service: new ReconciliationService(reader), reads };
  }

  async function rejection(promise: Promise<unknown>): Promise<ReconciliationError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationError);
      return error as ReconciliationError;
    }
    throw new Error('esperava rejeição');
  }

  it('reconcilia o snapshot lido', async () => {
    const { service, reads } = serviceWith(clean);
    expect((await service.reconcile(WS)).consistent).toBe(true);
    expect(reads).toEqual([WS]);
  });

  it.each([['número', 1], ['maiúsculo', WS.toUpperCase()], ['vazio', ''], ['nulo', null]])(
    'workspace %s é INVALID_INPUT sem leitura',
    async (_label, raw) => {
      const { service, reads } = serviceWith(clean);
      const error = await rejection(service.reconcile(raw));
      expect(error.code).toBe('INVALID_INPUT');
      expect(reads).toEqual([]);
    },
  );

  it('workspace inexistente é WORKSPACE_NOT_FOUND', async () => {
    const { service } = serviceWith(null);
    expect((await rejection(service.reconcile(WS))).code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('código técnico fora da allowlist é descartado', () => {
    expect(new ReconciliationError('RECONCILIATION_FAILED', { technicalCode: 'senha=x y' }).technicalCode).toBeUndefined();
    expect(new ReconciliationError('RECONCILIATION_FAILED', { technicalCode: '40001' }).technicalCode).toBe('40001');
  });
});
