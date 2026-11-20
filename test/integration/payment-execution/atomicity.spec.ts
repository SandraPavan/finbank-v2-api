import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MAX_CENTS } from '../../../src/payment-execution/domain/money.js';
import {
  balanceOf,
  counts,
  expectLedgerConsistent,
  fundedWorkspace,
  type Harness,
  harness,
  newWorkspace,
  opKey,
  rejection,
  sqlState,
} from './support.js';

describe('PaymentExecution: atomicidade e equilíbrio (PostgreSQL real)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  it('movimentação grava dois lançamentos equilibrados e atualiza os dois saldos', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const result = await h.service.execute({
      workspaceId: ws.workspaceId,
      operationKey: opKey(),
      debitAccountId: a,
      creditAccountId: b,
      amountCents: 400n,
    });
    expect(result.replayed).toBe(false);
    expect(await balanceOf(h, a)).toBe(600n);
    expect(await balanceOf(h, b)).toBe(400n);
    const entries = await h.db.client.ledgerEntry.findMany({
      where: { operationId: result.operationId },
      select: { accountId: true, amountCents: true },
      orderBy: { amountCents: 'asc' },
    });
    expect(entries).toEqual([
      { accountId: a, amountCents: -400n },
      { accountId: b, amountCents: 400n },
    ]);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('a contrapartida financia contas comuns e fica negativa; o total do workspace é zero', async () => {
    const ws = await fundedWorkspace(h, [700n, 300n]);
    expect(await balanceOf(h, ws.contra)).toBe(-1_000n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('falha real do PostgreSQL no último passo desfaz operação, lançamentos e o débito já aplicado', async () => {
    const ws = await fundedWorkspace(h, [500n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const before = await counts(h, ws.workspaceId);
    // Injeção de falha no próprio banco: o UPDATE do saldo de destino (último passo,
    // depois da operação, dos lançamentos e do débito) é rejeitado pelo PostgreSQL.
    await h.db.client.$executeRawUnsafe(`
      CREATE FUNCTION test_fail_credit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha injetada' USING ERRCODE = 'P0001'; END; $$`);
    await h.db.client.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_credit BEFORE UPDATE ON account FOR EACH ROW
      WHEN (OLD.id = '${b}'::uuid) EXECUTE FUNCTION test_fail_credit()`);
    try {
      const error = await rejection(
        h.service.execute({
          workspaceId: ws.workspaceId,
          operationKey: opKey(),
          debitAccountId: a,
          creditAccountId: b,
          amountCents: 200n,
        }),
      );
      expect(error.code).toBe('EXECUTION_FAILED');
      expect(error.technicalCode).toBe('P0001');
    } finally {
      await h.db.client.$executeRawUnsafe('DROP TRIGGER test_fail_credit ON account');
      await h.db.client.$executeRawUnsafe('DROP FUNCTION test_fail_credit()');
    }
    expect(await counts(h, ws.workspaceId)).toEqual(before);
    expect(await balanceOf(h, a)).toBe(500n);
    expect(await balanceOf(h, b)).toBe(0n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('saldo insuficiente é INSUFFICIENT_FUNDS e não deixa operação nem lançamento', async () => {
    const ws = await fundedWorkspace(h, [100n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const before = await counts(h, ws.workspaceId);
    const error = await rejection(
      h.service.execute({ workspaceId: ws.workspaceId, operationKey: opKey(), debitAccountId: a, creditAccountId: b, amountCents: 101n }),
    );
    expect(error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await counts(h, ws.workspaceId)).toEqual(before);
    expect(await balanceOf(h, a)).toBe(100n);
  });

  it('crédito que estouraria o limite técnico é AMOUNT_OUT_OF_RANGE, sem efeito', async () => {
    const workspaceId = await newWorkspace(h);
    const contra = (await h.service.openAccount(workspaceId, 'CONTRA')).id;
    const rich = (await h.service.openAccount(workspaceId, 'STANDARD')).id;
    await h.service.execute({ workspaceId, operationKey: opKey(), debitAccountId: contra, creditAccountId: rich, amountCents: MAX_CENTS });
    const before = await counts(h, workspaceId);
    const error = await rejection(
      h.service.execute({ workspaceId, operationKey: opKey(), debitAccountId: contra, creditAccountId: rich, amountCents: 1n }),
    );
    expect(error.code).toBe('AMOUNT_OUT_OF_RANGE');
    expect(await counts(h, workspaceId)).toEqual(before);
    expect(await balanceOf(h, rich)).toBe(MAX_CENTS);
  });

  it('o banco rejeita no commit uma operação gravada sem lançamentos equilibrados', async () => {
    const ws = await fundedWorkspace(h, [0n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const insertOperation = (amount: bigint, entries: [string, bigint][]) =>
      h.db.client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO payment_operation (workspace_id, operation_key, fingerprint, debit_account_id, credit_account_id, amount_cents)
          VALUES (${ws.workspaceId}::uuid, ${opKey()}, ${'0'.repeat(64)}, ${a}::uuid, ${b}::uuid, ${amount})
          RETURNING id::text AS id`;
        const id = rows[0]!.id;
        for (const [account, value] of entries) {
          await tx.$executeRaw`
            INSERT INTO ledger_entry (workspace_id, operation_id, account_id, amount_cents)
            VALUES (${ws.workspaceId}::uuid, ${id}::uuid, ${account}::uuid, ${value})`;
        }
      });
    expect(await sqlState(insertOperation(10n, []))).toBe('23514');
    expect(await sqlState(insertOperation(10n, [[a, -10n]]))).toBe('23514');
    expect(await sqlState(insertOperation(10n, [[a, -10n], [b, 9n]]))).toBe('23514');
    expect(await sqlState(insertOperation(10n, [[a, 10n], [b, -10n]]))).toBe('23514');
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: 0, entries: 0 });
  });

  it('o banco rejeita saldo negativo em conta comum mesmo fora da aplicação', async () => {
    const ws = await fundedWorkspace(h, [0n]);
    expect(
      await sqlState(h.db.client.$executeRaw`UPDATE account SET balance_cents = -1 WHERE id = ${ws.accounts[0]}::uuid`),
    ).toBe('23514');
  });
});
