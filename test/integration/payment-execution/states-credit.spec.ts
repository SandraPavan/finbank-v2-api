// Estados de workspace e conta, crédito educacional e modalidade em PostgreSQL real.
// O dono muda os estados, como fará o operador até existirem as histórias de bloqueio e arquivamento.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  balanceOf,
  counts,
  expectLedgerConsistent,
  type FundedWorkspace,
  fundedWorkspace,
  type Harness,
  harness,
  newWorkspace,
  opKey,
  rejection,
  settle,
  sqlState,
} from './support.js';

describe('estados, crédito educacional e modalidade (PostgreSQL real)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(inject('databaseUrl'), inject('appDatabaseUrl'));
  });

  afterAll(async () => {
    await h?.close();
  });

  const block = (id: string) => h.db.client.account.update({ where: { id }, data: { status: 'BLOCKED' } });
  const archive = (id: string) => h.db.client.workspace.update({ where: { id }, data: { status: 'ARCHIVED' } });
  const transfer = (ws: FundedWorkspace, key = opKey(), amountCents = 10n, modality?: string) =>
    h.service.execute({ workspaceId: ws.workspaceId, operationKey: key, debitAccountId: ws.accounts[0], creditAccountId: ws.accounts[1], amountCents, ...(modality ? { modality } : {}) });
  const credit = (ws: FundedWorkspace, key = opKey(), amountCents = 25n, accountId = ws.accounts[1]) =>
    h.service.credit({ workspaceId: ws.workspaceId, operationKey: key, accountId, amountCents });

  async function snapshot(ws: FundedWorkspace) {
    return { counts: await counts(h, ws.workspaceId), balances: await Promise.all([ws.contra, ...ws.accounts].map((id) => balanceOf(h, id))) };
  }

  describe('crédito educacional', () => {
    it('debita a contrapartida e credita a conta comum, com dupla entrada', async () => {
      const ws = await fundedWorkspace(h, [0n, 0n]);
      const result = await credit(ws, opKey(), 150n);
      expect(result).toMatchObject({ type: 'EDUCATIONAL_CREDIT', debitAccountId: ws.contra, creditAccountId: ws.accounts[1], amountCents: 150n, modality: null, replayed: false });
      expect(await balanceOf(h, ws.accounts[1] ?? '')).toBe(150n);
      expect(await balanceOf(h, ws.contra)).toBe(-150n);
      const row = await h.db.client.paymentOperation.findUniqueOrThrow({ where: { id: result.operationId } });
      expect(row).toMatchObject({ type: 'EDUCATIONAL_CREDIT', modality: null, reversesOperationId: null });
      await expectLedgerConsistent(h, ws.workspaceId);
      expect((await h.reconciliation.reconcile(ws.workspaceId)).consistent).toBe(true);
    });

    it('conta de contrapartida, de outro workspace ou inexistente é recusada sem efeito', async () => {
      const [ws, other] = [await fundedWorkspace(h, [0n, 0n]), await fundedWorkspace(h, [0n])];
      const before = await snapshot(ws);
      expect((await rejection(credit(ws, opKey(), 10n, ws.contra))).code).toBe('ACCOUNT_NOT_ELIGIBLE');
      expect((await rejection(credit(ws, opKey(), 10n, other.accounts[0]))).code).toBe('ACCOUNT_NOT_FOUND');
      expect((await rejection(credit(ws, opKey(), 10n, randomUUID()))).code).toBe('ACCOUNT_NOT_FOUND');
      expect(await snapshot(ws)).toEqual(before);
    });

    it('workspace sem contrapartida é erro tipado', async () => {
      const workspaceId = await newWorkspace(h);
      const account = await h.service.openAccount(workspaceId, 'STANDARD');
      expect((await rejection(h.service.credit({ workspaceId, operationKey: opKey(), accountId: account.id, amountCents: 1n }))).code).toBe('CONTRA_ACCOUNT_MISSING');
    });

    it('idempotência: mesma chave e conteúdo repete; conteúdo ou tipo diferente é conflito', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const key = opKey();
      const first = await credit(ws, key, 40n);
      expect(await credit(ws, key, 40n)).toEqual({ ...first, replayed: true });
      expect((await rejection(credit(ws, key, 41n))).code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await rejection(transfer(ws, key, 40n))).code).toBe('IDEMPOTENCY_CONFLICT');
      const transferKey = opKey();
      await transfer(ws, transferKey, 5n);
      expect((await rejection(credit(ws, transferKey, 5n))).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await balanceOf(h, ws.accounts[1] ?? '')).toBe(45n);
    });

    it('cem créditos paralelos com a mesma chave executam uma vez', async () => {
      const ws = await fundedWorkspace(h, [0n, 0n]);
      const key = opKey();
      const { ok, errors } = await settle(Array.from({ length: 100 }, () => credit(ws, key, 7n)));
      expect(errors).toEqual([]);
      expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(ok.map((r) => r.operationId)).size).toBe(1);
      expect(await balanceOf(h, ws.accounts[1] ?? '')).toBe(7n);
      await expectLedgerConsistent(h, ws.workspaceId);
    });

    it('falha real do PostgreSQL no último passo desfaz o crédito inteiro', async () => {
      const ws = await fundedWorkspace(h, [0n, 0n]);
      const target = ws.accounts[1] ?? '';
      const before = await snapshot(ws);
      await h.db.client.$executeRawUnsafe(`
        CREATE FUNCTION test_fail_credit_target() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'falha injetada' USING ERRCODE = 'P0001'; END; $$`);
      await h.db.client.$executeRawUnsafe(`
        CREATE TRIGGER test_fail_credit_target BEFORE UPDATE ON account FOR EACH ROW
        WHEN (OLD.id = '${target}'::uuid) EXECUTE FUNCTION test_fail_credit_target()`);
      try {
        expect(await rejection(credit(ws, opKey(), 30n))).toMatchObject({ code: 'EXECUTION_FAILED', technicalCode: 'P0001' });
      } finally {
        await h.db.client.$executeRawUnsafe('DROP FUNCTION test_fail_credit_target() CASCADE');
      }
      expect(await snapshot(ws)).toEqual(before);
      await expectLedgerConsistent(h, ws.workspaceId);
    });

    it('crédito não é estornável', async () => {
      const ws = await fundedWorkspace(h, [0n, 0n]);
      const done = await credit(ws);
      expect((await rejection(h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey(), originalOperationId: done.operationId }))).code).toBe('NOT_REVERSIBLE');
    });
  });

  describe('estado da conta', () => {
    it.each(['debit', 'credit'] as const)('transferência com a conta de %s bloqueada é recusada sem efeito', async (side) => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      await block(ws.accounts[side === 'debit' ? 0 : 1] ?? '');
      const before = await snapshot(ws);
      expect((await rejection(transfer(ws))).code).toBe('ACCOUNT_BLOCKED');
      expect(await snapshot(ws)).toEqual(before);
    });

    it('estorno e crédito para conta bloqueada são recusados', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const done = await transfer(ws);
      await block(ws.accounts[1] ?? '');
      const before = await snapshot(ws);
      expect((await rejection(h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey(), originalOperationId: done.operationId }))).code).toBe('ACCOUNT_BLOCKED');
      expect((await rejection(credit(ws))).code).toBe('ACCOUNT_BLOCKED');
      expect(await snapshot(ws)).toEqual(before);
    });

    it('desbloqueada volta a movimentar', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      await block(ws.accounts[0] ?? '');
      await rejection(transfer(ws));
      await h.db.client.account.update({ where: { id: ws.accounts[0] }, data: { status: 'ACTIVE' } });
      expect((await transfer(ws)).replayed).toBe(false);
    });

    it('a contrapartida nunca fica bloqueada', async () => {
      const ws = await fundedWorkspace(h, [0n]);
      expect(await sqlState(block(ws.contra))).toBe('23514');
    });
  });

  describe('estado do workspace', () => {
    it('arquivado recusa transferência, estorno e crédito sem efeito', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const done = await transfer(ws);
      await archive(ws.workspaceId);
      const before = await snapshot(ws);
      for (const attempt of [
        () => transfer(ws), () => credit(ws),
        () => h.service.reverse({ workspaceId: ws.workspaceId, operationKey: opKey(), originalOperationId: done.operationId }),
      ]) {
        expect((await rejection(attempt())).code).toBe('WORKSPACE_ARCHIVED');
      }
      expect(await snapshot(ws)).toEqual(before);
    });

    it('repetição é devolvida mesmo depois de bloqueio ou arquivamento', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const [tKey, cKey] = [opKey(), opKey()];
      const [t, c] = [await transfer(ws, tKey), await credit(ws, cKey)];
      await block(ws.accounts[1] ?? '');
      await archive(ws.workspaceId);
      expect(await transfer(ws, tKey)).toEqual({ ...t, replayed: true });
      expect(await credit(ws, cKey)).toEqual({ ...c, replayed: true });
    });
  });

  describe('concorrência com mudança de estado', () => {
    async function waitingLocks(n: number): Promise<void> {
      await vi.waitFor(async () => {
        const [row] = await h.db.client.$queryRaw<{ total: number }[]>`
          SELECT count(*)::int AS "total" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(row?.total).toBe(n);
      }, 10_000);
    }

    it('bloqueio em curso: a movimentação espera e é recusada', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      let attempt: Promise<unknown> | undefined;
      await h.db.client.$transaction(async (tx) => {
        await tx.account.update({ where: { id: ws.accounts[1] }, data: { status: 'BLOCKED' } });
        attempt = transfer(ws).catch((e: unknown) => e);
        await waitingLocks(1);
      }, { timeout: 20_000 });
      expect(await attempt).toMatchObject({ code: 'ACCOUNT_BLOCKED' });
      expect(await balanceOf(h, ws.accounts[1] ?? '')).toBe(0n);
    });

    it('movimentação em curso: o bloqueio espera e vale depois dela', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const LOCK = 240_024;
      await h.db.client.$executeRawUnsafe(`CREATE FUNCTION test_pause_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock_shared(${LOCK}); RETURN NEW; END $$`);
      await h.db.client.$executeRawUnsafe('CREATE TRIGGER test_pause_entry AFTER INSERT ON "ledger_entry" FOR EACH ROW EXECUTE FUNCTION test_pause_entry()');
      try {
        let moved: Promise<unknown> | undefined;
        let blocked: Promise<unknown> | undefined;
        await h.db.client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK}::bigint)`;
          moved = transfer(ws);
          await waitingLocks(1);
          // Promessa do Prisma só executa quando consumida.
          blocked = block(ws.accounts[1] ?? '').then((r) => r);
          await waitingLocks(2);
        }, { timeout: 20_000 });
        await moved;
        await blocked;
      } finally {
        await h.db.client.$executeRawUnsafe('DROP FUNCTION test_pause_entry() CASCADE');
      }
      expect(await balanceOf(h, ws.accounts[1] ?? '')).toBe(10n);
      expect((await rejection(transfer(ws))).code).toBe('ACCOUNT_BLOCKED');
    });

    it('arquivamento com a trava exclusiva: movimentação espera e é recusada; em curso, o arquivamento espera', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const key = `finbank:workspace:${ws.workspaceId}`;
      let attempt: Promise<unknown> | undefined;
      await h.db.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        await tx.workspace.update({ where: { id: ws.workspaceId }, data: { status: 'ARCHIVED' } });
        attempt = transfer(ws).catch((e: unknown) => e);
        await waitingLocks(1);
      }, { timeout: 20_000 });
      expect(await attempt).toMatchObject({ code: 'WORKSPACE_ARCHIVED' });

      const other = await fundedWorkspace(h, [100n, 0n]);
      const otherKey = `finbank:workspace:${other.workspaceId}`;
      const LOCK = 240_025;
      await h.db.client.$executeRawUnsafe(`CREATE FUNCTION test_pause_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock_shared(${LOCK}); RETURN NEW; END $$`);
      await h.db.client.$executeRawUnsafe('CREATE TRIGGER test_pause_entry AFTER INSERT ON "ledger_entry" FOR EACH ROW EXECUTE FUNCTION test_pause_entry()');
      try {
        let moved: Promise<unknown> | undefined;
        let archived: Promise<unknown> | undefined;
        await h.db.client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK}::bigint)`;
          moved = transfer(other);
          await waitingLocks(1);
          archived = h.db.client.$transaction(async (t2) => {
            await t2.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${otherKey}, 0))`;
            await t2.workspace.update({ where: { id: other.workspaceId }, data: { status: 'ARCHIVED' } });
          }, { timeout: 20_000 });
          await waitingLocks(2);
        }, { timeout: 20_000 });
        await moved;
        await archived;
      } finally {
        await h.db.client.$executeRawUnsafe('DROP FUNCTION test_pause_entry() CASCADE');
      }
      expect(await balanceOf(h, other.accounts[1] ?? '')).toBe(10n);
      expect((await rejection(transfer(other))).code).toBe('WORKSPACE_ARCHIVED');
    });
  });

  describe('modalidade', () => {
    it('gravada só em transferência, e parte da idempotência', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      const key = opKey();
      const done = await transfer(ws, key, 10n, 'PIX_KEY');
      expect(done.modality).toBe('PIX_KEY');
      expect((await h.db.client.paymentOperation.findUniqueOrThrow({ where: { id: done.operationId } })).modality).toBe('PIX_KEY');
      expect(await transfer(ws, key, 10n, 'PIX_KEY')).toEqual({ ...done, replayed: true });
      for (const other of ['PIX_QR_STATIC', undefined]) {
        expect((await rejection(transfer(ws, key, 10n, other))).code).toBe('IDEMPOTENCY_CONFLICT');
      }
      expect((await transfer(ws)).modality).toBeNull();
    });
  });

  describe('barreiras no banco', () => {
    async function ownerOperation(ws: FundedWorkspace, extra: { type?: string; modality?: string | null; debit?: string; credit?: string; ledger?: boolean }) {
      const debit = extra.debit ?? ws.contra;
      const credit = extra.credit ?? ws.accounts[0] ?? '';
      return sqlState(
        h.db.client.$transaction(async (tx) => {
          const [op] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "payment_operation" ("workspace_id", "operation_key", "fingerprint", "type", "modality", "debit_account_id", "credit_account_id", "amount_cents")
            VALUES (${ws.workspaceId}::uuid, ${opKey()}, ${'a'.repeat(64)}, ${extra.type ?? 'TRANSFER'}::"operation_type", ${extra.modality ?? null}::"payment_modality",
                    ${debit}::uuid, ${credit}::uuid, 5) RETURNING "id"::text AS "id"`;
          if (extra.ledger !== false) {
            await tx.$executeRaw`
              INSERT INTO "ledger_entry" ("workspace_id", "operation_id", "account_id", "amount_cents")
              VALUES (${ws.workspaceId}::uuid, ${op?.id}::uuid, ${debit}::uuid, -5), (${ws.workspaceId}::uuid, ${op?.id}::uuid, ${credit}::uuid, 5)`;
          }
          throw new Error('desfazer');
        }),
      );
    }

    it('lançamento em conta bloqueada ou workspace arquivado é recusado também para o dono', async () => {
      const ws = await fundedWorkspace(h, [0n]);
      expect(await ownerOperation(ws, {})).toBeUndefined();
      await block(ws.accounts[0] ?? '');
      expect(await ownerOperation(ws, {})).toBe('23514');
      const other = await fundedWorkspace(h, [0n]);
      await archive(other.workspaceId);
      expect(await ownerOperation(other, {})).toBe('23514');
    });

    it('modalidade fora de transferência e crédito na direção errada são recusados', async () => {
      const ws = await fundedWorkspace(h, [100n, 0n]);
      expect(await ownerOperation(ws, { type: 'EDUCATIONAL_CREDIT', ledger: false })).toBeUndefined();
      expect(await ownerOperation(ws, { type: 'EDUCATIONAL_CREDIT', modality: 'PIX_KEY', ledger: false })).toBe('23514');
      expect(await ownerOperation(ws, { type: 'EDUCATIONAL_CREDIT', debit: ws.accounts[0], credit: ws.accounts[1], ledger: false })).toBe('23514');
      expect(await ownerOperation(ws, { type: 'EDUCATIONAL_CREDIT', debit: ws.accounts[0], credit: ws.contra, ledger: false })).toBe('23514');
      expect(await ownerOperation(ws, { modality: 'PIX_COPY_PASTE', ledger: false })).toBeUndefined();
    });

    it('a execução não muda estado de conta nem de workspace', async () => {
      const ws = await fundedWorkspace(h, [0n]);
      expect(await sqlState(h.app.client.$executeRaw`UPDATE "account" SET "status" = 'BLOCKED' WHERE "id" = ${ws.accounts[0]}::uuid`)).toBe('42501');
      expect(await sqlState(h.app.client.$executeRaw`UPDATE "workspace" SET "status" = 'ARCHIVED' WHERE "id" = ${ws.workspaceId}::uuid`)).toBe('42501');
    });
  });
});
