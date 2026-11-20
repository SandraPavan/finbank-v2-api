import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { counts, fundedWorkspace, type Harness, harness, opKey, sqlState } from './support.js';

describe('PaymentExecution: imutabilidade de operações e lançamentos (PostgreSQL real)', () => {
  let h: Harness;
  let workspaceId: string;
  let operationId: string;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'));
    const ws = await fundedWorkspace(h, [100n, 0n]);
    workspaceId = ws.workspaceId;
    const result = await h.service.execute({
      workspaceId,
      operationKey: opKey(),
      debitAccountId: ws.accounts[0],
      creditAccountId: ws.accounts[1],
      amountCents: 40n,
    });
    operationId = result.operationId;
  });

  afterAll(async () => {
    await h?.close();
  });

  it.each([
    ['UPDATE em ledger_entry', () => h.db.client.$executeRaw`UPDATE ledger_entry SET amount_cents = amount_cents * 2 WHERE operation_id = ${operationId}::uuid`],
    ['DELETE em ledger_entry', () => h.db.client.$executeRaw`DELETE FROM ledger_entry WHERE operation_id = ${operationId}::uuid`],
    ['UPDATE em payment_operation', () => h.db.client.$executeRaw`UPDATE payment_operation SET amount_cents = 1 WHERE id = ${operationId}::uuid`],
    ['DELETE em payment_operation', () => h.db.client.$executeRaw`DELETE FROM payment_operation WHERE id = ${operationId}::uuid`],
    ['TRUNCATE em ledger_entry', () => h.db.client.$executeRawUnsafe('TRUNCATE ledger_entry CASCADE')],
    ['TRUNCATE em payment_operation', () => h.db.client.$executeRawUnsafe('TRUNCATE payment_operation CASCADE')],
  ])('%s é rejeitado pelo banco', async (_label, statement) => {
    expect(await sqlState(statement())).toBe('23001');
    expect(await counts(h, workspaceId)).toMatchObject({ operations: 2, entries: 4 });
  });

  it('a API do Prisma também não consegue alterar nem remover lançamentos', async () => {
    expect(await sqlState(h.db.client.ledgerEntry.updateMany({ where: { operationId }, data: { amountCents: 1n } }))).toBe('23001');
    expect(await sqlState(h.db.client.ledgerEntry.deleteMany({ where: { operationId } }))).toBe('23001');
  });
});
