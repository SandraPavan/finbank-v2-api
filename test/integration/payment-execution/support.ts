// Suporte dos testes de integração do PaymentExecution (somente teste).
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { PrismaPaymentExecutionStore } from '../../../src/payment-execution/adapters/prisma-payment-execution.store.js';
import { PaymentExecutionService } from '../../../src/payment-execution/application/payment-execution.service.js';
import { PaymentExecutionError } from '../../../src/payment-execution/domain/errors.js';
import { databaseErrorCode } from '../../../src/persistence/database-errors.js';
import { PrismaService } from '../../../src/persistence/prisma.service.js';

export interface Harness {
  readonly db: PrismaService;
  readonly service: PaymentExecutionService;
  close(): Promise<void>;
}

export async function harness(databaseUrl: string): Promise<Harness> {
  const db = new PrismaService({ databaseUrl });
  await db.onModuleInit();
  const service = new PaymentExecutionService(new PrismaPaymentExecutionStore(db.client));
  return { db, service, close: () => db.onModuleDestroy() };
}

/** Workspace novo por teste: os registros são imutáveis e não são apagados entre testes. */
export async function newWorkspace(h: Harness): Promise<string> {
  const workspace = await h.db.client.workspace.create({ data: {}, select: { id: true } });
  return workspace.id;
}

export interface FundedWorkspace {
  readonly workspaceId: string;
  readonly contra: string;
  readonly accounts: readonly string[];
}

/** Workspace com contrapartida e contas comuns financiadas pelo próprio PaymentExecution. */
export async function fundedWorkspace(h: Harness, balances: readonly bigint[]): Promise<FundedWorkspace> {
  const workspaceId = await newWorkspace(h);
  const contra = (await h.service.openAccount(workspaceId, 'CONTRA')).id;
  const accounts: string[] = [];
  for (const balance of balances) {
    const id = (await h.service.openAccount(workspaceId, 'STANDARD')).id;
    if (balance > 0n) {
      await h.service.execute({
        workspaceId,
        operationKey: opKey('funding'),
        debitAccountId: contra,
        creditAccountId: id,
        amountCents: balance,
      });
    }
    accounts.push(id);
  }
  return { workspaceId, contra, accounts };
}

export function opKey(prefix = 'op'): string {
  return `${prefix}-${randomUUID()}`;
}

export async function balanceOf(h: Harness, accountId: string): Promise<bigint> {
  const account = await h.db.client.account.findUniqueOrThrow({ where: { id: accountId }, select: { balanceCents: true } });
  return account.balanceCents;
}

export async function counts(h: Harness, workspaceId: string): Promise<{ operations: number; entries: number }> {
  const [operations, entries] = await Promise.all([
    h.db.client.paymentOperation.count({ where: { workspaceId } }),
    h.db.client.ledgerEntry.count({ where: { workspaceId } }),
  ]);
  return { operations, entries };
}

/**
 * Equilíbrio do workspace: cada saldo materializado é a soma dos seus lançamentos,
 * cada operação soma zero e a soma de todos os saldos é zero.
 */
export async function expectLedgerConsistent(h: Harness, workspaceId: string): Promise<void> {
  const mismatched = await h.db.client.$queryRaw<{ id: string }[]>`
    SELECT a.id::text AS id
      FROM account a
      LEFT JOIN ledger_entry e ON e.account_id = a.id
     WHERE a.workspace_id = ${workspaceId}::uuid
     GROUP BY a.id, a.balance_cents
    HAVING a.balance_cents <> coalesce(sum(e.amount_cents), 0)`;
  expect(mismatched, 'saldo materializado diferente da soma do ledger').toEqual([]);

  const unbalanced = await h.db.client.$queryRaw<{ id: string }[]>`
    SELECT operation_id::text AS id FROM ledger_entry
     WHERE workspace_id = ${workspaceId}::uuid
     GROUP BY operation_id HAVING sum(amount_cents) <> 0 OR count(*) <> 2`;
  expect(unbalanced, 'operação desequilibrada').toEqual([]);

  const total = await h.db.client.$queryRaw<{ total: string }[]>`
    SELECT coalesce(sum(balance_cents), 0)::text AS total FROM account WHERE workspace_id = ${workspaceId}::uuid`;
  expect(total[0]?.total).toBe('0');
}

export async function rejection(promise: Promise<unknown>): Promise<PaymentExecutionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentExecutionError);
    return error as PaymentExecutionError;
  }
  throw new Error('esperava rejeição');
}

/** Executa todas as promessas e separa sucessos de erros, sem interromper na primeira falha. */
export async function settle<T>(promises: readonly Promise<T>[]): Promise<{ ok: T[]; errors: unknown[] }> {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    errors: results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : [])),
  };
}

/** SQLSTATE da rejeição do banco; falha se a instrução for aceita. */
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return databaseErrorCode(error);
  }
  throw new Error('esperava rejeição do banco');
}
