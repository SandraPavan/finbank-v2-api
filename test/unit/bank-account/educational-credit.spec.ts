import { describe, expect, it, vi } from 'vitest';
import {
  type CreditResult,
  EducationalCreditService,
  type EducationalCreditStore,
} from '../../../src/bank-account/application/educational-credit.service.js';
import { formatAmount, InvalidCreditRequestError, parseAmount, parseCreditRequest, parseIdempotencyKey } from '../../../src/bank-account/domain/educational-credit.js';
import { loadAppConfig } from '../../../src/config/app-config.js';
import type { WorkspaceAccess } from '../../../src/identity/domain/workspace-access.js';

const WS = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const access: WorkspaceAccess = { identityId: '22222222-2222-4222-8222-222222222222', workspaceId: WS, role: 'FACILITATOR' };
const LIMITS = { maxPerOperationCents: 100_000n, maxPerAccountCents: 1_000_000n };

describe('valor do crédito', () => {
  it.each([['0.01', 1n], ['150.00', 15_000n], ['1000.00', 100_000n], ['999999999.99', 99_999_999_999n]])('%s vira %s centavos', (raw, cents) => {
    expect(parseAmount(raw)).toBe(cents);
    expect(formatAmount(cents)).toBe(raw);
  });

  it.each(['0.00', '-1.00', '1', '1.5', '1.505', '1e3', '1,00', ' 1.00', '1000000000.00', '', null, 150])('%j é recusado sem arredondar', (raw) => {
    expect(parseAmount(raw)).toBeNull();
  });

  it('pedido com exatamente amount e justification; reúne campos recusados; chave no formato', () => {
    expect(parseCreditRequest({ amount: '10.00', justification: '  Saldo inicial do exercício  ' })).toEqual({ amountCents: 1_000n, justification: 'Saldo inicial do exercício' });
    expect(() => parseCreditRequest({ amount: '1', justification: 'curta' })).toThrow(InvalidCreditRequestError);
    try {
      parseCreditRequest({ amount: '1', justification: 'curta' });
    } catch (e) {
      expect((e as InvalidCreditRequestError).fields).toEqual(['amount', 'justification']);
      expect((e as Error).message).not.toMatch(/curta/);
    }
    expect(() => parseCreditRequest({ amount: '10.00', justification: 'Saldo inicial do exercício', accountId: 'x' })).toThrow(InvalidCreditRequestError);
    expect(parseIdempotencyKey('credito-0001')).toBe('credito-0001');
    for (const key of [undefined, '', 'curta', 'com espaço aqui', 'x'.repeat(129)]) {
      expect(() => parseIdempotencyKey(key)).toThrow(InvalidCreditRequestError);
    }
  });
});

describe('serviço do crédito', () => {
  function setup(result: CreditResult) {
    const store = { credit: vi.fn<EducationalCreditStore['credit']>().mockResolvedValue(result) };
    return { store, service: new EducationalCreditService(store, LIMITS) };
  }
  const body = { amount: '150.00', justification: 'Saldo inicial do exercício' };

  it('repassa limites e chave; formata o valor da resposta', async () => {
    const { store, service } = setup({ kind: 'CREDITED', replayed: false, credit: { creditId: 'c', operationId: 'o', accountId: 'a', amountCents: 15_000n } });
    expect(await service.credit(access, CUSTOMER, 'credito-0001', body, 'corr-0001')).toEqual({
      creditId: 'c', operationId: 'o', workspaceId: WS, customerId: CUSTOMER, accountId: 'a', amount: '150.00', replayed: false,
    });
    expect(store.credit).toHaveBeenCalledWith(access, { customerId: CUSTOMER, idempotencyKey: 'credito-0001', amountCents: 15_000n, justification: 'Saldo inicial do exercício', limits: LIMITS }, 'corr-0001');
  });

  it.each<[CreditResult, string]>([
    [{ kind: 'NOT_FOUND' }, 'NOT_FOUND'], [{ kind: 'DENIED' }, 'ACCESS_LOST'], [{ kind: 'ARCHIVED' }, 'WORKSPACE_ARCHIVED'],
    [{ kind: 'BLOCKED' }, 'ACCOUNT_BLOCKED'], [{ kind: 'LIMIT' }, 'LIMIT_EXCEEDED'], [{ kind: 'CONFLICT' }, 'IDEMPOTENCY_CONFLICT'],
  ])('resultado %j vira erro tipado', async (result, code) => {
    await expect(setup(result).service.credit(access, CUSTOMER, 'credito-0001', body, 'corr-0001')).rejects.toMatchObject({ code });
  });

  it('chave, corpo ou cliente inválidos não chegam à gravação', async () => {
    const { store, service } = setup({ kind: 'NOT_FOUND' });
    await expect(service.credit(access, CUSTOMER, undefined, body, 'c')).rejects.toBeInstanceOf(InvalidCreditRequestError);
    await expect(service.credit(access, CUSTOMER, 'credito-0001', { amount: '0.00', justification: body.justification }, 'c')).rejects.toBeInstanceOf(InvalidCreditRequestError);
    await expect(service.credit(access, 'x', 'credito-0001', body, 'c')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.credit).not.toHaveBeenCalled();
  });
});

describe('configuração dos limites (L6)', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

  it('padrão R$ 1.000,00 por crédito e R$ 10.000,00 por conta; aceita valores configurados', () => {
    expect(loadAppConfig(base).educationalCredit).toEqual({ maxPerOperationCents: 100_000n, maxPerAccountCents: 1_000_000n });
    expect(loadAppConfig({ ...base, EDUCATIONAL_CREDIT_MAX_PER_OPERATION: '50.00', EDUCATIONAL_CREDIT_MAX_PER_ACCOUNT: '50.00' }).educationalCredit)
      .toEqual({ maxPerOperationCents: 5_000n, maxPerAccountCents: 5_000n });
  });

  it.each([
    [{ EDUCATIONAL_CREDIT_MAX_PER_OPERATION: '1000' }, 'EDUCATIONAL_CREDIT_MAX_PER_OPERATION'],
    [{ EDUCATIONAL_CREDIT_MAX_PER_OPERATION: '0.00' }, 'EDUCATIONAL_CREDIT_MAX_PER_OPERATION'],
    [{ EDUCATIONAL_CREDIT_MAX_PER_ACCOUNT: 'dez mil' }, 'EDUCATIONAL_CREDIT_MAX_PER_ACCOUNT'],
    [{ EDUCATIONAL_CREDIT_MAX_PER_OPERATION: '200.00', EDUCATIONAL_CREDIT_MAX_PER_ACCOUNT: '100.00' }, 'EDUCATIONAL_CREDIT_MAX_PER_ACCOUNT'],
  ])('%j impede a subida', (env, variable) => {
    expect(() => loadAppConfig({ ...base, ...env })).toThrow(expect.objectContaining({ variable }) as Error);
  });
});
