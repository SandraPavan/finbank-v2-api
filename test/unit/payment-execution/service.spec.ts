// Lógica de decisão do PaymentExecution com uma store em memória.
// Não prova atomicidade nem concorrência: isso é verificado em PostgreSQL real (test/integration).
import { describe, expect, it } from 'vitest';
import type {
  AccountView,
  LockedAccount,
  PaymentExecutionStore,
  PaymentExecutionTransaction,
  RegisterOperationInput,
  RegisterOperationResult,
  StoredOperation,
} from '../../../src/payment-execution/application/payment-execution.store.js';
import { PaymentExecutionService } from '../../../src/payment-execution/application/payment-execution.service.js';
import { PaymentExecutionError } from '../../../src/payment-execution/domain/errors.js';
import type { AccountKind, LedgerEntryDraft } from '../../../src/payment-execution/domain/transfer.js';

const WS = '0b6f7c1e-4a2d-4c3b-9e8f-112233445566';
const A = '1a1a1a1a-1111-4111-8111-111111111111';
const B = '2b2b2b2b-2222-4222-8222-222222222222';

class FakeStore implements PaymentExecutionStore {
  accounts = new Map<string, LockedAccount>();
  operations = new Map<string, StoredOperation & { input: RegisterOperationInput }>();
  entries: LedgerEntryDraft[] = [];
  calls: string[] = [];

  transaction<T>(work: (tx: PaymentExecutionTransaction) => Promise<T>): Promise<T> {
    const tx: PaymentExecutionTransaction = {
      registerOperation: (input): Promise<RegisterOperationResult> => {
        this.calls.push('register');
        const key = `${input.workspaceId}|${input.operationKey}`;
        const existing = this.operations.get(key);
        if (existing) {
          return Promise.resolve({ created: false, existing });
        }
        const op = { operationId: `op-${this.operations.size + 1}`, ...input, input };
        this.operations.set(key, op);
        return Promise.resolve({ created: true, operationId: op.operationId });
      },
      lockAccounts: (_ws, ids) => {
        this.calls.push('lock');
        return Promise.resolve(ids.flatMap((id) => (this.accounts.has(id) ? [this.accounts.get(id)!] : [])));
      },
      insertEntries: (_ws, _op, entries) => {
        this.calls.push('entries');
        this.entries.push(...entries);
        return Promise.resolve();
      },
      setBalance: (_ws, id, balanceCents) => {
        this.calls.push(`balance:${id}`);
        this.accounts.set(id, { ...this.accounts.get(id)!, balanceCents });
        return Promise.resolve();
      },
    };
    return work(tx);
  }

  createAccount(workspaceId: string, kind: AccountKind): Promise<AccountView> {
    return Promise.resolve({ id: 'new', workspaceId, kind, balanceCents: 0n });
  }
}

function setup(debitBalance = 1_000n, debitKind: AccountKind = 'STANDARD'): { store: FakeStore; service: PaymentExecutionService } {
  const store = new FakeStore();
  store.accounts.set(A, { id: A, kind: debitKind, balanceCents: debitBalance });
  store.accounts.set(B, { id: B, kind: 'STANDARD', balanceCents: 0n });
  return { store, service: new PaymentExecutionService(store) };
}

const cmd = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: WS,
  operationKey: 'op-key-0001',
  debitAccountId: A,
  creditAccountId: B,
  amountCents: 300n,
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<PaymentExecutionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentExecutionError);
    return error as PaymentExecutionError;
  }
  throw new Error('esperava rejeição');
}

describe('PaymentExecutionService.execute', () => {
  it('registra, trava, lança e atualiza os dois saldos nessa ordem', async () => {
    const { store, service } = setup();
    const result = await service.execute(cmd());
    expect(result).toMatchObject({ operationId: 'op-1', amountCents: 300n, replayed: false });
    expect(store.calls).toEqual(['register', 'lock', 'entries', `balance:${A}`, `balance:${B}`]);
    expect(store.accounts.get(A)?.balanceCents).toBe(700n);
    expect(store.accounts.get(B)?.balanceCents).toBe(300n);
    expect(store.entries.reduce((s, e) => s + e.amountCents, 0n)).toBe(0n);
  });

  it('valida a entrada antes de abrir transação', async () => {
    const { store, service } = setup();
    expect((await rejection(service.execute(cmd({ amountCents: 0n })))).code).toBe('INVALID_INPUT');
    expect(store.calls).toEqual([]);
  });

  it('repetição com o mesmo conteúdo devolve o resultado original sem novos efeitos', async () => {
    const { store, service } = setup();
    const first = await service.execute(cmd());
    store.calls = [];
    const again = await service.execute(cmd());
    expect(again).toEqual({ ...first, replayed: true });
    expect(store.calls).toEqual(['register']);
    expect(store.accounts.get(A)?.balanceCents).toBe(700n);
    expect(store.entries).toHaveLength(2);
  });

  it.each([
    ['outro valor', { amountCents: 301n }],
    ['outro destino', { creditAccountId: '3c3c3c3c-3333-4333-8333-333333333333' }],
  ])('mesma chave com %s é IDEMPOTENCY_CONFLICT', async (_label, change) => {
    const { store, service } = setup();
    await service.execute(cmd());
    expect((await rejection(service.execute(cmd(change)))).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(store.entries).toHaveLength(2);
  });

  it('conta ausente é ACCOUNT_NOT_FOUND, sem lançamentos', async () => {
    const { store, service } = setup();
    store.accounts.delete(B);
    expect((await rejection(service.execute(cmd()))).code).toBe('ACCOUNT_NOT_FOUND');
    expect(store.entries).toEqual([]);
  });

  it('saldo insuficiente em conta comum é INSUFFICIENT_FUNDS, sem lançamentos', async () => {
    const { store, service } = setup(299n);
    expect((await rejection(service.execute(cmd()))).code).toBe('INSUFFICIENT_FUNDS');
    expect(store.entries).toEqual([]);
    expect(store.accounts.get(A)?.balanceCents).toBe(299n);
  });

  it('contrapartida pode financiar a partir de saldo zero', async () => {
    const { store, service } = setup(0n, 'CONTRA');
    await service.execute(cmd());
    expect(store.accounts.get(A)?.balanceCents).toBe(-300n);
  });
});

describe('PaymentExecutionService.openAccount', () => {
  it('valida workspace e tipo antes de delegar', async () => {
    const { service } = setup();
    expect(await service.openAccount(WS, 'CONTRA')).toMatchObject({ kind: 'CONTRA', balanceCents: 0n });
    expect((await rejection(service.openAccount('x', 'STANDARD'))).field).toBe('workspaceId');
    expect((await rejection(service.openAccount(WS, 'ADMIN'))).field).toBe('kind');
  });
});
