import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ReconciliationError } from '../../src/reconciliation/domain/errors.js';
import { balanceOf, counts, fundedWorkspace, type Harness, harness, opKey, settle } from './payment-execution/support.js';

describe('reconciliação em PostgreSQL real', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  async function rejection(promise: Promise<unknown>): Promise<ReconciliationError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationError);
      return error as ReconciliationError;
    }
    throw new Error('esperava rejeição');
  }

  async function activeWorkspace(): Promise<{ workspaceId: string; contra: string; a: string; b: string }> {
    const ws = await fundedWorkspace(h, [1_000n, 500n]);
    const [a, b] = ws.accounts as [string, string];
    const moved = await h.service.execute({
      workspaceId: ws.workspaceId,
      operationKey: opKey(),
      debitAccountId: a,
      creditAccountId: b,
      amountCents: 250n,
    });
    await h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: moved.operationId });
    return { workspaceId: ws.workspaceId, contra: ws.contra, a, b };
  }

  it('workspace com transferências e estorno é consistente', async () => {
    const ws = await activeWorkspace();
    const report = await h.reconciliation.reconcile(ws.workspaceId);
    expect(report).toEqual({
      workspaceId: ws.workspaceId,
      accountCount: 3,
      operationCount: 4,
      consistent: true,
      divergences: [],
    });
  });

  it('saldo alterado fora do ledger é relatado na conta certa e o outro workspace segue consistente', async () => {
    const tampered = await activeWorkspace();
    const untouched = await activeWorkspace();
    // Simula uma escrita indevida no saldo materializado (somente teste).
    await h.db.client.$executeRaw`UPDATE "account" SET "balance_cents" = "balance_cents" + 7 WHERE "id" = ${tampered.b}::uuid`;

    const report = await h.reconciliation.reconcile(tampered.workspaceId);
    expect(report.consistent).toBe(false);
    expect(report.divergences).toEqual([
      { type: 'BALANCE_MISMATCH', accountId: tampered.b, recordedCents: 507n, ledgerCents: 500n },
      { type: 'WORKSPACE_TOTAL_NONZERO', totalCents: 7n },
    ]);
    expect((await h.reconciliation.reconcile(untouched.workspaceId)).consistent).toBe(true);
  });

  it('não altera dados', async () => {
    const ws = await activeWorkspace();
    const before = { counts: await counts(h, ws.workspaceId), a: await balanceOf(h, ws.a), b: await balanceOf(h, ws.b) };
    await h.reconciliation.reconcile(ws.workspaceId);
    await h.reconciliation.reconcile(ws.workspaceId);
    expect({ counts: await counts(h, ws.workspaceId), a: await balanceOf(h, ws.a), b: await balanceOf(h, ws.b) }).toEqual(before);
  });

  it('workspace inexistente é WORKSPACE_NOT_FOUND e entrada inválida é INVALID_INPUT', async () => {
    expect((await rejection(h.reconciliation.reconcile('00000000-0000-4000-8000-000000000000'))).code).toBe('WORKSPACE_NOT_FOUND');
    expect((await rejection(h.reconciliation.reconcile('nao-e-uuid'))).code).toBe('INVALID_INPUT');
  });

  it('workspace sem contas é consistente', async () => {
    const workspace = await h.db.client.workspace.create({ data: {}, select: { id: true } });
    expect(await h.reconciliation.reconcile(workspace.id)).toMatchObject({ accountCount: 0, operationCount: 0, consistent: true });
  });

  it('não relata divergência falsa durante movimentações e estornos concorrentes', async () => {
    const ws = await fundedWorkspace(h, [400n, 400n, 400n, 400n]);
    const ids = ws.accounts;
    const movements = Array.from({ length: 40 }, (_, i) =>
      h.service.execute({
        workspaceId: ws.workspaceId,
        operationKey: opKey(),
        debitAccountId: ids[i % 4]!,
        creditAccountId: ids[(i + 1 + (i % 3)) % 4]!,
        amountCents: BigInt(5 + (i % 11)),
      }),
    );
    const reports = Array.from({ length: 10 }, () => h.reconciliation.reconcile(ws.workspaceId));
    const [moved, checked] = await Promise.all([settle(movements), settle(reports)]);
    expect(checked.errors).toEqual([]);
    for (const report of checked.ok) {
      expect(report.divergences).toEqual([]);
    }
    const reversals = await settle(
      moved.ok.slice(0, 10).map((r) =>
        h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey('rev'), originalOperationId: r.operationId }),
      ),
    );
    const final = await h.reconciliation.reconcile(ws.workspaceId);
    expect(final.consistent).toBe(true);
    expect(final.operationCount).toBe(4 + moved.ok.length + reversals.ok.length);
  });

  it('relata operações desequilibradas encontradas no banco', async () => {
    const ws = await fundedWorkspace(h, [0n]);
    const [a] = ws.accounts as [string];
    // Somente teste: desliga triggers e chaves estrangeiras nesta transação para gravar um estado que
    // as restrições normalmente impedem (uma operação com um só lançamento e outra sem lançamentos).
    const ids = await h.db.client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      const insert = (amount: bigint) => tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "payment_operation"
          ("workspace_id", "operation_key", "fingerprint", "debit_account_id", "credit_account_id", "amount_cents")
        VALUES (${ws.workspaceId}::uuid, ${opKey('unbal')}, ${'c'.repeat(64)}, ${ws.contra}::uuid, ${a}::uuid, ${amount})
        RETURNING "id"::text AS "id"`;
      const single = (await insert(10n))[0]!.id;
      const empty = (await insert(20n))[0]!.id;
      await tx.$executeRaw`
        INSERT INTO "ledger_entry" ("workspace_id", "operation_id", "account_id", "amount_cents")
        VALUES (${ws.workspaceId}::uuid, ${single}::uuid, ${ws.contra}::uuid, ${-10n})`;
      return { single, empty };
    });

    const report = await h.reconciliation.reconcile(ws.workspaceId);
    expect(report.consistent).toBe(false);
    const unbalanced = report.divergences
      .filter((d) => d.type === 'UNBALANCED_OPERATION')
      .sort((x, y) => x.entryCount - y.entryCount);
    expect(unbalanced).toEqual([
      { type: 'UNBALANCED_OPERATION', operationId: ids.empty, entryCount: 0, sumCents: 0n },
      { type: 'UNBALANCED_OPERATION', operationId: ids.single, entryCount: 1, sumCents: -10n },
    ]);
    expect(report.divergences.filter((d) => d.type === 'BALANCE_MISMATCH')).toEqual([
      { type: 'BALANCE_MISMATCH', accountId: ws.contra, recordedCents: 0n, ledgerCents: -10n },
    ]);
  });
});
