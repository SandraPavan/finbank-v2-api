import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PaymentExecutionError } from '../../../src/payment-execution/domain/errors.js';
import {
  balanceOf,
  counts,
  expectLedgerConsistent,
  fundedWorkspace,
  type Harness,
  harness,
  opKey,
  operationRow,
  rejection,
  settle,
} from './support.js';

function codeOf(error: unknown): string {
  return error instanceof PaymentExecutionError ? `${error.code}:${error.technicalCode ?? ''}` : 'NON_TYPED';
}

describe('PaymentExecution: estorno compensatório em PostgreSQL real', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'), inject('appDatabaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  async function transfer(workspaceId: string, from: string, to: string, amount: bigint): Promise<string> {
    const result = await h.service.execute({
      workspaceId,
      operationKey: opKey(),
      debitAccountId: from,
      creditAccountId: to,
      amountCents: amount,
    });
    return result.operationId;
  }

  it('estorno total grava operação vinculada, lançamentos invertidos e restaura os saldos', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const original = await transfer(ws.workspaceId, a, b, 300n);
    const originalBefore = await operationRow(h, original);
    const before = await counts(h, ws.workspaceId);

    const result = await h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original });

    expect(result).toMatchObject({
      type: 'REVERSAL',
      reversesOperationId: original,
      debitAccountId: b,
      creditAccountId: a,
      amountCents: 300n,
      replayed: false,
    });
    expect(await balanceOf(h, a)).toBe(1_000n);
    expect(await balanceOf(h, b)).toBe(0n);
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 1, entries: before.entries + 2 });
    const entries = await h.db.client.ledgerEntry.findMany({
      where: { operationId: result.operationId },
      select: { accountId: true, amountCents: true },
      orderBy: { amountCents: 'asc' },
    });
    expect(entries).toEqual([
      { accountId: b, amountCents: -300n },
      { accountId: a, amountCents: 300n },
    ]);
    expect(await operationRow(h, original)).toEqual(originalBefore);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('estorna uma movimentação a partir da contrapartida', async () => {
    const ws = await fundedWorkspace(h, [0n]);
    const [a] = ws.accounts as [string];
    const funding = await transfer(ws.workspaceId, ws.contra, a, 500n);
    await h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: funding });
    expect(await balanceOf(h, a)).toBe(0n);
    expect(await balanceOf(h, ws.contra)).toBe(0n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('repetição com a mesma chave devolve o mesmo estorno sem novos efeitos', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const original = await transfer(ws.workspaceId, a, b, 300n);
    const command = { workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original };
    const first = await h.service.reverse(command);
    const before = await counts(h, ws.workspaceId);
    expect(await h.service.reverse({ ...command })).toEqual({ ...first, replayed: true });
    expect(await counts(h, ws.workspaceId)).toEqual(before);
    expect(await balanceOf(h, a)).toBe(1_000n);
  });

  it('mesma chave com outra operação de origem ou já usada por transferência é IDEMPOTENCY_CONFLICT', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const first = await transfer(ws.workspaceId, a, b, 300n);
    const second = await transfer(ws.workspaceId, a, b, 100n);
    const key = opKey('rev');
    await h.service.reverse({ workspaceId: ws.workspaceId, operationKey: key, originalOperationId: first });
    const transferKey = opKey('tr');
    await h.service.execute({ workspaceId: ws.workspaceId, operationKey: transferKey, debitAccountId: a, creditAccountId: b, amountCents: 1n });
    const before = await counts(h, ws.workspaceId);

    const otherOrigin = await rejection(
      h.service.reverse({ workspaceId: ws.workspaceId, operationKey: key, originalOperationId: second }),
    );
    const transferKeyUsed = await rejection(
      h.service.reverse({ workspaceId: ws.workspaceId, operationKey: transferKey, originalOperationId: second }),
    );
    for (const error of [otherOrigin, transferKeyUsed]) {
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.message).not.toContain(key);
      expect(error.message).not.toContain(transferKey);
    }
    expect(await counts(h, ws.workspaceId)).toEqual(before);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('segundo estorno com outra chave é ALREADY_REVERSED e não altera nada', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const original = await transfer(ws.workspaceId, a, b, 300n);
    await h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original });
    const before = await counts(h, ws.workspaceId);
    const error = await rejection(
      h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original }),
    );
    expect(error.code).toBe('ALREADY_REVERSED');
    expect(await counts(h, ws.workspaceId)).toEqual(before);
    expect(await balanceOf(h, a)).toBe(1_000n);
  });

  it('estorno de estorno é NOT_REVERSIBLE', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const original = await transfer(ws.workspaceId, a, b, 300n);
    const reversal = await h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original });
    const before = await counts(h, ws.workspaceId);
    const error = await rejection(
      h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: reversal.operationId }),
    );
    expect(error.code).toBe('NOT_REVERSIBLE');
    expect(await counts(h, ws.workspaceId)).toEqual(before);
  });

  it('operação inexistente ou de outro workspace é OPERATION_NOT_FOUND, sem efeito e sem eco', async () => {
    const ws1 = await fundedWorkspace(h, [1_000n, 0n]);
    const ws2 = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws1.accounts as [string, string];
    const original = await transfer(ws1.workspaceId, a, b, 300n);
    const before1 = await counts(h, ws1.workspaceId);
    const before2 = await counts(h, ws2.workspaceId);

    const crossed = await rejection(
      h.service.reverse({ workspaceId: ws2.workspaceId, operationKey: opKey('rev'), originalOperationId: original }),
    );
    const missing = await rejection(
      h.service.reverse({
        workspaceId: ws1.workspaceId,
        operationKey: opKey('rev'),
        originalOperationId: '00000000-0000-4000-8000-000000000000',
      }),
    );
    for (const error of [crossed, missing]) {
      expect(error.code).toBe('OPERATION_NOT_FOUND');
      expect(error.message).not.toContain(original);
    }
    expect(await counts(h, ws1.workspaceId)).toEqual(before1);
    expect(await counts(h, ws2.workspaceId)).toEqual(before2);
    expect(await balanceOf(h, b)).toBe(300n);
  });

  it('sem saldo na conta comum a debitar é INSUFFICIENT_FUNDS, sem efeito e sem consumir a chave', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n, 0n]);
    const [a, b, c] = ws.accounts as [string, string, string];
    const original = await transfer(ws.workspaceId, a, b, 300n);
    await transfer(ws.workspaceId, b, c, 300n);
    const command = { workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original };
    const before = await counts(h, ws.workspaceId);

    expect((await rejection(h.service.reverse(command))).code).toBe('INSUFFICIENT_FUNDS');
    expect(await counts(h, ws.workspaceId)).toEqual(before);
    expect(await balanceOf(h, a)).toBe(700n);

    await transfer(ws.workspaceId, c, b, 300n);
    const result = await h.service.reverse({ ...command });
    expect(result.replayed).toBe(false);
    expect(await balanceOf(h, a)).toBe(1_000n);
    expect(await balanceOf(h, b)).toBe(0n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('10 estornos paralelos com a mesma chave executam uma única vez', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const original = await transfer(ws.workspaceId, a, b, 300n);
    const before = await counts(h, ws.workspaceId);
    const command = { workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original };
    const { ok, errors } = await settle(Array.from({ length: 10 }, () => h.service.reverse({ ...command })));
    expect(errors.map(codeOf)).toEqual([]);
    expect(new Set(ok.map((r) => r.operationId)).size).toBe(1);
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 1, entries: before.entries + 2 });
    expect(await balanceOf(h, a)).toBe(1_000n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('8 estornos paralelos da mesma operação com chaves diferentes: exatamente um executa', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const original = await transfer(ws.workspaceId, a, b, 300n);
    const before = await counts(h, ws.workspaceId);
    const { ok, errors } = await settle(
      Array.from({ length: 8 }, () =>
        h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original }),
      ),
    );
    expect(ok).toHaveLength(1);
    expect(errors.map(codeOf)).toEqual(Array.from({ length: 7 }, () => 'ALREADY_REVERSED:'));
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 1, entries: before.entries + 2 });
    expect(await balanceOf(h, a)).toBe(1_000n);
    expect(await balanceOf(h, b)).toBe(0n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('estornos e transferências cruzadas em paralelo terminam sem deadlock e com equilíbrio', async () => {
    const ws = await fundedWorkspace(h, [5_000n, 5_000n]);
    const [a, b] = ws.accounts as [string, string];
    const originals: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      originals.push(await transfer(ws.workspaceId, i % 2 === 0 ? a : b, i % 2 === 0 ? b : a, BigInt(10 + i)));
    }
    const before = await counts(h, ws.workspaceId);
    const work = [
      ...originals.map((original) =>
        h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: original }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        h.service.execute({
          workspaceId: ws.workspaceId,
          operationKey: opKey(),
          debitAccountId: i % 2 === 0 ? b : a,
          creditAccountId: i % 2 === 0 ? a : b,
          amountCents: BigInt(1 + (i % 5)),
        }),
      ),
    ];
    const { ok, errors } = await settle(work);
    expect(errors.map(codeOf)).toEqual([]);
    expect(ok).toHaveLength(40);
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 40, entries: before.entries + 80 });
    expect((await balanceOf(h, a)) + (await balanceOf(h, b))).toBe(10_000n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });
});
