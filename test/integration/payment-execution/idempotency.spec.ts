import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  balanceOf,
  counts,
  expectLedgerConsistent,
  fundedWorkspace,
  type Harness,
  harness,
  opKey,
  rejection,
  settle,
} from './support.js';

describe('PaymentExecution: idempotência por operação e workspace (PostgreSQL real)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'), inject('appDatabaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  it('repetição com o mesmo conteúdo devolve o mesmo resultado sem nova execução', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const command = { workspaceId: ws.workspaceId, operationKey: opKey(), debitAccountId: a, creditAccountId: b, amountCents: 250n };
    const before = await counts(h, ws.workspaceId);
    const first = await h.service.execute(command);
    const again = await h.service.execute({ ...command });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 1, entries: before.entries + 2 });
    expect(await balanceOf(h, a)).toBe(750n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it.each([
    ['outro valor', (c: Record<string, unknown>) => ({ ...c, amountCents: 251n })],
    ['outra conta de destino', (c: Record<string, unknown>, other: string) => ({ ...c, creditAccountId: other })],
    ['origem e destino invertidos', (c: Record<string, unknown>) => ({ ...c, debitAccountId: c['creditAccountId'], creditAccountId: c['debitAccountId'] })],
  ])('mesma chave com %s é IDEMPOTENCY_CONFLICT e não altera nada', async (_label, change) => {
    const ws = await fundedWorkspace(h, [1_000n, 1_000n, 0n]);
    const [a, b, c] = ws.accounts as [string, string, string];
    const command = { workspaceId: ws.workspaceId, operationKey: opKey(), debitAccountId: a, creditAccountId: b, amountCents: 250n };
    await h.service.execute(command);
    const before = await counts(h, ws.workspaceId);
    const error = await rejection(h.service.execute(change(command, c)));
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(error.message).not.toContain(command.operationKey);
    expect(await counts(h, ws.workspaceId)).toEqual(before);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('a mesma chave em outro workspace é uma operação independente', async () => {
    const one = await fundedWorkspace(h, [500n, 0n]);
    const two = await fundedWorkspace(h, [500n, 0n]);
    const key = opKey('shared');
    const r1 = await h.service.execute({ workspaceId: one.workspaceId, operationKey: key, debitAccountId: one.accounts[0], creditAccountId: one.accounts[1], amountCents: 100n });
    const r2 = await h.service.execute({ workspaceId: two.workspaceId, operationKey: key, debitAccountId: two.accounts[0], creditAccountId: two.accounts[1], amountCents: 300n });
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(false);
    expect(r2.operationId).not.toBe(r1.operationId);
    expect(await balanceOf(h, one.accounts[0]!)).toBe(400n);
    expect(await balanceOf(h, two.accounts[0]!)).toBe(200n);
  });

  it('operação rejeitada não consome a chave: a nova tentativa pode ser executada', async () => {
    const ws = await fundedWorkspace(h, [100n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const command = { workspaceId: ws.workspaceId, operationKey: opKey(), debitAccountId: a, creditAccountId: b, amountCents: 150n };
    expect((await rejection(h.service.execute(command))).code).toBe('INSUFFICIENT_FUNDS');
    await h.service.execute({ workspaceId: ws.workspaceId, operationKey: opKey(), debitAccountId: ws.contra, creditAccountId: a, amountCents: 50n });
    const retried = await h.service.execute(command);
    expect(retried.replayed).toBe(false);
    expect(await balanceOf(h, a)).toBe(0n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('10 chamadas paralelas com a mesma chave executam uma única vez e devolvem o mesmo id', async () => {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const command = { workspaceId: ws.workspaceId, operationKey: opKey(), debitAccountId: a, creditAccountId: b, amountCents: 100n };
    const before = await counts(h, ws.workspaceId);
    const { ok, errors } = await settle(Array.from({ length: 10 }, () => h.service.execute({ ...command })));
    expect(errors).toEqual([]);
    expect(new Set(ok.map((r) => r.operationId)).size).toBe(1);
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await counts(h, ws.workspaceId)).toEqual({ operations: before.operations + 1, entries: before.entries + 2 });
    expect(await balanceOf(h, a)).toBe(900n);
    await expectLedgerConsistent(h, ws.workspaceId);
  });

  it('chamadas paralelas com a mesma chave e conteúdos diferentes: uma executa, as demais conflitam', async () => {
    const ws = await fundedWorkspace(h, [10_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const key = opKey();
    const { ok, errors } = await settle(
      Array.from({ length: 8 }, (_, i) =>
        h.service.execute({ workspaceId: ws.workspaceId, operationKey: key, debitAccountId: a, creditAccountId: b, amountCents: BigInt(100 + i) }),
      ),
    );
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    expect(errors).toHaveLength(7);
    expect(errors.every((e) => (e as { code?: string }).code === 'IDEMPOTENCY_CONFLICT')).toBe(true);
    await expectLedgerConsistent(h, ws.workspaceId);
  });
});
