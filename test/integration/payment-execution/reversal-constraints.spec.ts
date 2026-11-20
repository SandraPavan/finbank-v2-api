// Garantias do banco para o vínculo do estorno e a identidade das contas, por SQL direto.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { counts, fundedWorkspace, type Harness, harness, opKey, sqlState } from './support.js';

const FINGERPRINT = 'a'.repeat(64);

describe('restrições do estorno e da conta no PostgreSQL', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  interface Row {
    workspaceId: string;
    type: 'TRANSFER' | 'REVERSAL';
    reverses: string | null;
    debit: string;
    credit: string;
    amount: bigint;
  }

  /**
   * Insere a operação com dois lançamentos equilibrados na mesma transação: o trigger adiado de
   * equilíbrio aceitaria o commit, então a rejeição esperada vem da restrição testada.
   */
  function insertOperation(row: Row): Promise<unknown> {
    return h.db.client.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "payment_operation"
          ("workspace_id", "operation_key", "fingerprint", "type", "reverses_operation_id",
           "debit_account_id", "credit_account_id", "amount_cents")
        VALUES (${row.workspaceId}::uuid, ${opKey('sql')}, ${FINGERPRINT}, ${row.type}::"operation_type",
                ${row.reverses}::uuid, ${row.debit}::uuid, ${row.credit}::uuid, ${row.amount})
        RETURNING "id"::text AS "id"`;
      const operationId = inserted[0]?.id;
      await tx.$executeRaw`
        INSERT INTO "ledger_entry" ("workspace_id", "operation_id", "account_id", "amount_cents")
        VALUES (${row.workspaceId}::uuid, ${operationId}::uuid, ${row.debit}::uuid, ${-row.amount}),
               (${row.workspaceId}::uuid, ${operationId}::uuid, ${row.credit}::uuid, ${row.amount})`;
    });
  }

  async function scenario(): Promise<{ workspaceId: string; a: string; b: string; original: string }> {
    const ws = await fundedWorkspace(h, [1_000n, 0n]);
    const [a, b] = ws.accounts as [string, string];
    const result = await h.service.execute({
      workspaceId: ws.workspaceId,
      operationKey: opKey(),
      debitAccountId: a,
      creditAccountId: b,
      amountCents: 300n,
    });
    return { workspaceId: ws.workspaceId, a, b, original: result.operationId };
  }

  it('controle: estorno coerente inserido assim é aceito pelo banco', async () => {
    const s = await scenario();
    const before = await counts(h, s.workspaceId);
    await insertOperation({ workspaceId: s.workspaceId, type: 'REVERSAL', reverses: s.original, debit: s.b, credit: s.a, amount: 300n });
    expect(await counts(h, s.workspaceId)).toEqual({ operations: before.operations + 1, entries: before.entries + 2 });
  });

  it.each([
    ['contas não invertidas', (s: { a: string; b: string }) => ({ debit: s.a, credit: s.b, amount: 300n })],
    ['outro valor', (s: { a: string; b: string }) => ({ debit: s.b, credit: s.a, amount: 299n })],
  ])('estorno com %s é rejeitado (23514)', async (_label, change) => {
    const s = await scenario();
    const before = await counts(h, s.workspaceId);
    const state = await sqlState(
      insertOperation({ workspaceId: s.workspaceId, type: 'REVERSAL', reverses: s.original, ...change(s) }),
    );
    expect(state).toBe('23514');
    expect(await counts(h, s.workspaceId)).toEqual(before);
  });

  it('estorno de um estorno é rejeitado (23514)', async () => {
    const s = await scenario();
    const reversal = await h.service.reverse({ workspaceId: s.workspaceId, operationKey: opKey('rev'), originalOperationId: s.original });
    const state = await sqlState(
      insertOperation({ workspaceId: s.workspaceId, type: 'REVERSAL', reverses: reversal.operationId, debit: s.a, credit: s.b, amount: 300n }),
    );
    expect(state).toBe('23514');
  });

  it('estorno de operação de outro workspace é rejeitado (23503)', async () => {
    const s = await scenario();
    const other = await fundedWorkspace(h, [0n, 0n]);
    const [x, y] = other.accounts as [string, string];
    const state = await sqlState(
      insertOperation({ workspaceId: other.workspaceId, type: 'REVERSAL', reverses: s.original, debit: x, credit: y, amount: 300n }),
    );
    expect(state).toBe('23503');
  });

  it('segundo estorno da mesma operação é rejeitado (23505)', async () => {
    const s = await scenario();
    await h.service.reverse({ workspaceId: s.workspaceId, operationKey: opKey('rev'), originalOperationId: s.original });
    const state = await sqlState(
      insertOperation({ workspaceId: s.workspaceId, type: 'REVERSAL', reverses: s.original, debit: s.b, credit: s.a, amount: 300n }),
    );
    expect(state).toBe('23505');
  });

  it.each([
    ['TRANSFER com vínculo', 'TRANSFER', true],
    ['REVERSAL sem vínculo', 'REVERSAL', false],
  ] as const)('%s é rejeitado (23514)', async (_label, type, linked) => {
    const s = await scenario();
    const state = await sqlState(
      insertOperation({
        workspaceId: s.workspaceId,
        type,
        reverses: linked ? s.original : null,
        debit: s.b,
        credit: s.a,
        amount: 300n,
      }),
    );
    expect(state).toBe('23514');
  });

  it.each([
    ['o tipo', (id: string) => h.db.client.$executeRaw`UPDATE "account" SET "kind" = 'CONTRA' WHERE "id" = ${id}::uuid`],
    [
      'o workspace',
      async (id: string) => {
        const other = await h.db.client.workspace.create({ data: {}, select: { id: true } });
        return h.db.client.$executeRaw`UPDATE "account" SET "workspace_id" = ${other.id}::uuid WHERE "id" = ${id}::uuid`;
      },
    ],
    ['o id', (id: string) => h.db.client.$executeRaw`UPDATE "account" SET "id" = gen_random_uuid() WHERE "id" = ${id}::uuid`],
  ])('alterar %s de uma conta é rejeitado (23001)', async (_label, update) => {
    const ws = await fundedWorkspace(h, [0n]);
    const [a] = ws.accounts as [string];
    expect(await sqlState(update(a))).toBe('23001');
    const account = await h.db.client.account.findUniqueOrThrow({ where: { id: a } });
    expect(account).toMatchObject({ kind: 'STANDARD', workspaceId: ws.workspaceId });
  });
});
