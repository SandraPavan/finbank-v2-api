import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PaymentExecutionError } from '../../../src/payment-execution/domain/errors.js';
import { balanceOf, counts, expectLedgerConsistent, fundedWorkspace, type Harness, harness, opKey, settle } from './support.js';

function codeOf(error: unknown): string {
  return error instanceof PaymentExecutionError ? `${error.code}:${error.technicalCode ?? ''}` : 'NON_TYPED';
}

describe('PaymentExecution: concorrência real no PostgreSQL', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  it('20 débitos paralelos de 10 numa conta com 100: exatamente 10 executam e o saldo termina em 0', async () => {
    const ws = await fundedWorkspace(h, [100n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const before = await counts(h, ws.workspaceId);
    const { ok, errors } = await settle(
      Array.from({ length: 20 }, () =>
        h.service.execute({ workspaceId: ws.workspaceId, operationKey: opKey(), debitAccountId: a, creditAccountId: b, amountCents: 10n }),
      ),
    );
    expect(ok).toHaveLength(10);
    expect(errors.map(codeOf)).toEqual(Array.from({ length: 10 }, () => 'INSUFFICIENT_FUNDS:'));
    expect(await balanceOf(h, a)).toBe(0n);
    expect(await balanceOf(h, b)).toBe(100n);
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 10, entries: before.entries + 20 });
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('transferências cruzadas A→B e B→A em paralelo terminam sem deadlock e sem perda', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 1_000n]);
    const [a, b] = ws.accounts as [string, string];
    const before = await counts(h, ws.workspaceId);
    const transfers = Array.from({ length: 50 }, (_, i) =>
      h.service.execute({
        workspaceId: ws.workspaceId,
        operationKey: opKey(),
        debitAccountId: i % 2 === 0 ? a : b,
        creditAccountId: i % 2 === 0 ? b : a,
        amountCents: BigInt(1 + (i % 7)),
      }),
    );
    const { ok, errors } = await settle(transfers);
    expect(errors.map(codeOf)).toEqual([]);
    expect(ok).toHaveLength(50);
    const net = ok.reduce((sum, r) => sum + (r.debitAccountId === a ? -r.amountCents : r.amountCents), 0n);
    expect(await balanceOf(h, a)).toBe(1_000n + net);
    expect(await balanceOf(h, b)).toBe(1_000n - net);
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 50, entries: before.entries + 100 });
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('movimentações paralelas entre várias contas preservam o total e o equilíbrio', async () => {
    const ws = await fundedWorkspace(h, [300n, 300n, 300n, 300n]);
    const ids = ws.accounts;
    const { ok, errors } = await settle(
      Array.from({ length: 40 }, (_, i) =>
        h.service.execute({
          workspaceId: ws.workspaceId,
          operationKey: opKey(),
          debitAccountId: ids[i % 4]!,
          creditAccountId: ids[(i + 1 + (i % 3)) % 4]!,
          amountCents: BigInt(5 + (i % 11)),
        }),
      ),
    );
    expect(errors.filter((e) => codeOf(e) !== 'INSUFFICIENT_FUNDS:')).toEqual([]);
    expect(ok.length + errors.length).toBe(40);
    const balances = await Promise.all(ids.map((id) => balanceOf(h, id)));
    expect(balances.every((value) => value >= 0n)).toBe(true);
    expect(balances.reduce((s, v) => s + v, 0n)).toBe(1_200n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });
});
