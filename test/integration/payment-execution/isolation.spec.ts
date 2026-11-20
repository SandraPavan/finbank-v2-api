import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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

describe('PaymentExecution: isolamento por workspace (dois workspaces, PostgreSQL real)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'), inject('appDatabaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  it.each([
    ['destino', 'credit'],
    ['origem', 'debit'],
  ] as const)('conta de %s em outro workspace é ACCOUNT_NOT_FOUND e nada muda em nenhum dos dois', async (_label, side) => {
    const one = await fundedWorkspace(h, [500n]);
    const two = await fundedWorkspace(h, [500n]);
    const [mine, foreign] = [one.accounts[0]!, two.accounts[0]!];
    const before = [await counts(h, one.workspaceId), await counts(h, two.workspaceId)];
    const error = await rejection(
      h.service.execute({
        workspaceId: one.workspaceId,
        operationKey: opKey(),
        debitAccountId: side === 'debit' ? foreign : mine,
        creditAccountId: side === 'debit' ? mine : foreign,
        amountCents: 100n,
      }),
    );
    expect(error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(error.message).not.toContain(foreign);
    expect([await counts(h, one.workspaceId), await counts(h, two.workspaceId)]).toEqual(before);
    expect(await balanceOf(h, mine)).toBe(500n);
    expect(await balanceOf(h, foreign)).toBe(500n);
  });

  it('conta inexistente devolve o mesmo erro que conta de outro workspace', async () => {
    const one = await fundedWorkspace(h, [500n]);
    const error = await rejection(
      h.service.execute({ workspaceId: one.workspaceId, operationKey: opKey(), debitAccountId: one.accounts[0], creditAccountId: randomUUID(), amountCents: 1n }),
    );
    expect(error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('workspace informado diferente do dono das duas contas é ACCOUNT_NOT_FOUND', async () => {
    const owner = await fundedWorkspace(h, [500n, 0n]);
    const other = await newWorkspace(h);
    const error = await rejection(
      h.service.execute({ workspaceId: other, operationKey: opKey(), debitAccountId: owner.accounts[0], creditAccountId: owner.accounts[1], amountCents: 1n }),
    );
    expect(error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(await balanceOf(h, owner.accounts[0]!)).toBe(500n);
  });

  it('o banco rejeita operação e lançamento que misturam workspaces, mesmo por SQL direto', async () => {
    const one = await fundedWorkspace(h, [100n]);
    const two = await fundedWorkspace(h, [100n]);
    expect(await sqlState(h.db.client.$executeRaw`
      INSERT INTO payment_operation (workspace_id, operation_key, fingerprint, debit_account_id, credit_account_id, amount_cents)
      VALUES (${one.workspaceId}::uuid, ${opKey()}, ${'0'.repeat(64)}, ${one.accounts[0]}::uuid, ${two.accounts[0]}::uuid, 1)`)).toBe('23503');

    const existing = await h.db.client.paymentOperation.findFirstOrThrow({ where: { workspaceId: one.workspaceId }, select: { id: true } });
    expect(await sqlState(h.db.client.$executeRaw`
      INSERT INTO ledger_entry (workspace_id, operation_id, account_id, amount_cents)
      VALUES (${two.workspaceId}::uuid, ${existing.id}::uuid, ${two.accounts[0]}::uuid, 1)`)).toBe('23503');
    await expectLedgerConsistent(h, one.workspaceId);
    await expectLedgerConsistent(h, two.workspaceId);
  });

  it('abrir conta em workspace inexistente é WORKSPACE_NOT_FOUND; segunda contrapartida é rejeitada', async () => {
    expect((await rejection(h.service.openAccount(randomUUID(), 'STANDARD'))).code).toBe('WORKSPACE_NOT_FOUND');
    const ws = await newWorkspace(h);
    await h.service.openAccount(ws, 'CONTRA');
    expect((await rejection(h.service.openAccount(ws, 'CONTRA'))).code).toBe('DUPLICATE_CONTRA_ACCOUNT');
    const other = await newWorkspace(h);
    expect((await h.service.openAccount(other, 'CONTRA')).kind).toBe('CONTRA');
  });
});
