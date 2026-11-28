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
import { MAX_CENTS } from '../../../src/payment-execution/domain/money.js';
import type { AccountKind, LedgerEntryDraft } from '../../../src/payment-execution/domain/transfer.js';

const WS = '0b6f7c1e-4a2d-4c3b-9e8f-112233445566';
const A = '1a1a1a1a-1111-4111-8111-111111111111';
const B = '2b2b2b2b-2222-4222-8222-222222222222';
const opId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class FakeStore implements PaymentExecutionStore {
  accounts = new Map<string, LockedAccount>();
  operations = new Map<string, StoredOperation & { input: RegisterOperationInput }>();
  entries: LedgerEntryDraft[] = [];
  calls: string[] = [];
  workspaceStatus: 'ACTIVE' | 'ARCHIVED' | null = 'ACTIVE';
  contra: string | null = null;

  transaction<T>(work: (tx: PaymentExecutionTransaction) => Promise<T>): Promise<T> {
    const tx: PaymentExecutionTransaction = {
      lockWorkspace: () => {
        this.calls.push('workspace');
        return Promise.resolve(this.workspaceStatus);
      },
      findContraAccount: () => Promise.resolve(this.contra),
      findOperation: (ws, id) => {
        this.calls.push('find');
        const found = [...this.operations.values()].find((op) => op.operationId === id && op.input.workspaceId === ws);
        return Promise.resolve(found ?? null);
      },
      registerOperation: (input): Promise<RegisterOperationResult> => {
        this.calls.push('register');
        const key = `${input.workspaceId}|${input.operationKey}`;
        const existing = this.operations.get(key);
        if (existing) {
          return Promise.resolve({ outcome: 'KEY_EXISTS', existing });
        }
        if (
          input.reversesOperationId !== null &&
          [...this.operations.values()].some((op) => op.reversesOperationId === input.reversesOperationId)
        ) {
          return Promise.resolve({ outcome: 'ALREADY_REVERSED' });
        }
        const op = { operationId: opId(this.operations.size + 1), ...input, input };
        this.operations.set(key, op);
        return Promise.resolve({ outcome: 'CREATED', operationId: op.operationId });
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
      sumEducationalCredits: (ws, accountId, excluding) => {
        this.calls.push('sum');
        const total = [...this.operations.values()]
          .filter((op) => op.input.workspaceId === ws && op.type === 'EDUCATIONAL_CREDIT' && op.creditAccountId === accountId && op.operationId !== excluding)
          .reduce((sum, op) => sum + op.amountCents, 0n);
        return Promise.resolve(total);
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
  store.accounts.set(A, { id: A, kind: debitKind, status: 'ACTIVE', balanceCents: debitBalance });
  store.accounts.set(B, { id: B, kind: 'STANDARD', status: 'ACTIVE', balanceCents: 0n });
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
    expect(result).toMatchObject({
      operationId: opId(1),
      type: 'TRANSFER',
      reversesOperationId: null,
      amountCents: 300n,
      replayed: false,
    });
    expect(store.calls).toEqual(['workspace', 'register', 'lock', 'entries', `balance:${A}`, `balance:${B}`]);
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
    expect(store.calls).toEqual(['workspace', 'register']);
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

describe('PaymentExecutionService.reverse', () => {
  const rev = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    workspaceId: WS,
    operationKey: 'rev-key-0001',
    originalOperationId: opId(1),
    ...overrides,
  });

  async function transferred(debitBalance = 1_000n): Promise<{ store: FakeStore; service: PaymentExecutionService }> {
    const ctx = setup(debitBalance);
    await ctx.service.execute(cmd());
    ctx.store.calls = [];
    return ctx;
  }

  it('valida o comando antes de abrir transação', async () => {
    const { store, service } = await transferred();
    for (const bad of [rev({ originalOperationId: 'op-1' }), rev({ operationKey: 'curta' }), rev({ extra: 1 })]) {
      expect((await rejection(service.reverse(bad))).code).toBe('INVALID_INPUT');
    }
    expect(store.calls).toEqual([]);
  });

  it('lê a original, registra o vínculo, trava e aplica a movimentação invertida', async () => {
    const { store, service } = await transferred();
    const result = await service.reverse(rev());
    expect(result).toEqual({
      operationId: opId(2),
      workspaceId: WS,
      type: 'REVERSAL',
      reversesOperationId: opId(1),
      modality: null,
      debitAccountId: B,
      creditAccountId: A,
      amountCents: 300n,
      replayed: false,
    });
    expect(store.calls).toEqual(['find', 'workspace', 'register', 'lock', 'entries', `balance:${B}`, `balance:${A}`]);
    expect(store.accounts.get(A)?.balanceCents).toBe(1_000n);
    expect(store.accounts.get(B)?.balanceCents).toBe(0n);
    expect(store.entries.slice(2)).toEqual([
      { accountId: B, amountCents: -300n },
      { accountId: A, amountCents: 300n },
    ]);
  });

  it('repetição devolve o estorno original sem novos efeitos', async () => {
    const { store, service } = await transferred();
    const first = await service.reverse(rev());
    store.calls = [];
    expect(await service.reverse(rev())).toEqual({ ...first, replayed: true });
    expect(store.calls).toEqual(['find', 'workspace', 'register']);
    expect(store.entries).toHaveLength(4);
  });

  it('operação inexistente é OPERATION_NOT_FOUND, sem registro', async () => {
    const { store, service } = await transferred();
    expect((await rejection(service.reverse(rev({ originalOperationId: opId(9) })))).code).toBe('OPERATION_NOT_FOUND');
    expect(store.calls).toEqual(['find']);
  });

  it('operação de outro workspace é OPERATION_NOT_FOUND', async () => {
    const { service } = await transferred();
    const other = '9d9d9d9d-9999-4999-8999-999999999999';
    expect((await rejection(service.reverse(rev({ workspaceId: other })))).code).toBe('OPERATION_NOT_FOUND');
  });

  it('estorno de estorno é NOT_REVERSIBLE, sem registro', async () => {
    const { store, service } = await transferred();
    await service.reverse(rev());
    store.calls = [];
    const error = await rejection(service.reverse(rev({ operationKey: 'rev-key-0002', originalOperationId: opId(2) })));
    expect(error.code).toBe('NOT_REVERSIBLE');
    expect(store.calls).toEqual(['find']);
  });

  it('segundo estorno com outra chave é ALREADY_REVERSED, sem lançamentos', async () => {
    const { store, service } = await transferred();
    await service.reverse(rev());
    expect((await rejection(service.reverse(rev({ operationKey: 'rev-key-0002' })))).code).toBe('ALREADY_REVERSED');
    expect(store.entries).toHaveLength(4);
  });

  it('chave já usada por uma transferência é IDEMPOTENCY_CONFLICT', async () => {
    const { store, service } = await transferred();
    expect((await rejection(service.reverse(rev({ operationKey: 'op-key-0001' })))).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(store.entries).toHaveLength(2);
  });

  it('mesma chave para outra operação de origem é IDEMPOTENCY_CONFLICT', async () => {
    const { store, service } = await transferred();
    await service.execute(cmd({ operationKey: 'op-key-0002', amountCents: 100n }));
    await service.reverse(rev());
    expect((await rejection(service.reverse(rev({ originalOperationId: opId(2) })))).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(store.entries).toHaveLength(6);
  });

  it('conta comum a debitar sem saldo é INSUFFICIENT_FUNDS, sem lançamentos', async () => {
    const { store, service } = await transferred();
    store.accounts.set(B, { id: B, kind: 'STANDARD', status: 'ACTIVE', balanceCents: 299n });
    expect((await rejection(service.reverse(rev()))).code).toBe('INSUFFICIENT_FUNDS');
    expect(store.entries).toHaveLength(2);
    expect(store.accounts.get(A)?.balanceCents).toBe(700n);
  });

  it('crédito acima do limite técnico é AMOUNT_OUT_OF_RANGE', async () => {
    const { store, service } = await transferred();
    store.accounts.set(A, { id: A, kind: 'STANDARD', status: 'ACTIVE', balanceCents: MAX_CENTS });
    expect((await rejection(service.reverse(rev()))).code).toBe('AMOUNT_OUT_OF_RANGE');
    expect(store.entries).toHaveLength(2);
  });
});

describe('estados e crédito educacional (lógica de decisão)', () => {
  const credit = (over: object = {}) => ({ workspaceId: WS, operationKey: 'credito-0001', accountId: B, amountCents: 50n, ...over });

  it('workspace arquivado recusa, sem travar contas nem lançar', async () => {
    const { store, service } = setup();
    store.workspaceStatus = 'ARCHIVED';
    await expect(service.execute(cmd())).rejects.toMatchObject({ code: 'WORKSPACE_ARCHIVED' });
    expect(store.calls).toEqual(['workspace', 'register']);
    expect(store.entries).toEqual([]);
  });

  it('workspace inexistente é conta não encontrada', async () => {
    const { store, service } = setup();
    store.workspaceStatus = null;
    await expect(service.execute(cmd())).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it.each([A, B])('conta bloqueada em qualquer lado recusa sem lançar (%s)', async (id) => {
    const { store, service } = setup();
    store.accounts.set(id, { ...store.accounts.get(id)!, status: 'BLOCKED' });
    await expect(service.execute(cmd())).rejects.toMatchObject({ code: 'ACCOUNT_BLOCKED' });
    expect(store.entries).toEqual([]);
  });

  it('repetição é devolvida mesmo com workspace arquivado e conta bloqueada depois', async () => {
    const { store, service } = setup();
    const first = await service.execute(cmd());
    store.workspaceStatus = 'ARCHIVED';
    store.accounts.set(A, { ...store.accounts.get(A)!, status: 'BLOCKED' });
    expect(await service.execute(cmd())).toEqual({ ...first, replayed: true });
  });

  it('crédito: da contrapartida para a conta comum, tipo próprio', async () => {
    const { store, service } = setup(0n, 'CONTRA');
    store.contra = A;
    const result = await service.credit(credit());
    expect(result).toMatchObject({ type: 'EDUCATIONAL_CREDIT', debitAccountId: A, creditAccountId: B, amountCents: 50n, modality: null, replayed: false });
    expect(store.accounts.get(B)?.balanceCents).toBe(50n);
  });

  it('crédito sem contrapartida, para a própria contrapartida ou para conta não comum é recusado', async () => {
    const none = setup();
    await expect(none.service.credit(credit())).rejects.toMatchObject({ code: 'CONTRA_ACCOUNT_MISSING' });
    const self = setup(0n, 'CONTRA');
    self.store.contra = A;
    await expect(self.service.credit(credit({ accountId: A }))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ELIGIBLE' });
    const odd = setup();
    odd.store.contra = A;
    await expect(odd.service.credit(credit())).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ELIGIBLE' });
    expect(odd.store.entries).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['nulo', null], ['campo extra', { extra: 1 }], ['conta inválida', { accountId: 'X' }], ['valor zero', { amountCents: 0n }], ['valor number', { amountCents: 5 }],
  ])('crédito com comando inválido (%s)', async (label, over) => {
    const { store, service } = setup(0n, 'CONTRA');
    store.contra = A;
    await expect(service.credit(label === 'nulo' ? null : credit(over as object))).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|AMOUNT_OUT_OF_RANGE/) as string });
    expect(store.calls).toEqual([]);
  });

  it('crédito não é estornável', async () => {
    const { store, service } = setup(0n, 'CONTRA');
    store.contra = A;
    const done = await service.credit(credit());
    await expect(service.reverse({ workspaceId: WS, operationKey: 'estorno-0001', originalOperationId: done.operationId })).rejects.toMatchObject({ code: 'NOT_REVERSIBLE' });
  });
});

describe('teto acumulado do crédito educacional', () => {
  const credit = (key: string, amountCents: bigint, ceilingCents?: bigint) => ({
    workspaceId: WS, operationKey: key, accountId: B, amountCents, ...(ceilingCents === undefined ? {} : { ceilingCents }),
  });

  function funded() {
    const { store, service } = setup(0n, 'CONTRA');
    store.contra = A;
    return { store, service };
  }

  it('aceita exatamente até o teto e recusa o que passaria dele, sem lançar', async () => {
    const { store, service } = funded();
    await service.credit(credit('credito-0001', 600n, 1_000n));
    await service.credit(credit('credito-0002', 400n, 1_000n));
    const entries = store.entries.length;
    await expect(service.credit(credit('credito-0003', 1n, 1_000n))).rejects.toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });
    expect(store.entries).toHaveLength(entries);
    expect(store.accounts.get(B)?.balanceCents).toBe(1_000n);
  });

  it('confere o teto depois de travar as contas e soma sem a própria operação', async () => {
    const { store, service } = funded();
    await service.credit(credit('credito-0001', 100n, 1_000n));
    expect(store.calls.indexOf('sum')).toBeGreaterThan(store.calls.indexOf('lock'));
  });

  it('a repetição é devolvida mesmo acima de um teto menor; o teto não entra na impressão digital', async () => {
    const { service } = funded();
    const first = await service.credit(credit('credito-0001', 900n, 1_000n));
    expect(await service.credit(credit('credito-0001', 900n, 500n))).toEqual({ ...first, replayed: true });
    expect(await service.credit(credit('credito-0001', 900n))).toEqual({ ...first, replayed: true });
  });

  it.each([0n, -1n, 10])('teto %s inválido é recusado', async (ceiling) => {
    const { service } = funded();
    await expect(service.credit({ ...credit('credito-0001', 1n), ceilingCents: ceiling })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
