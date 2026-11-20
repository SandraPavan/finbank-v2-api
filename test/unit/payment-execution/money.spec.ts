import { describe, expect, it } from 'vitest';
import { PaymentExecutionError } from '../../../src/payment-execution/domain/errors.js';
import { MAX_CENTS, parseAmountCents } from '../../../src/payment-execution/domain/money.js';

function rejection(fn: () => unknown): PaymentExecutionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentExecutionError);
    return error as PaymentExecutionError;
  }
  throw new Error('esperava rejeição');
}

describe('parseAmountCents', () => {
  it.each([1n, 100n, 123_456_789n, MAX_CENTS])('aceita %s centavos', (value) => {
    expect(parseAmountCents(value)).toBe(value);
  });

  it('o limite técnico é o maior BIGINT do PostgreSQL', () => {
    expect(MAX_CENTS).toBe(2n ** 63n - 1n);
  });

  it.each([
    ['number inteiro', 100],
    ['number fracionário', 10.5],
    ['número acima do inteiro seguro', 2 ** 60],
    ['string', '100'],
    ['null', null],
    ['undefined', undefined],
    ['objeto', { value: 1n }],
  ])('rejeita %s sem coerção', (_label, value) => {
    const error = rejection(() => parseAmountCents(value));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.field).toBe('amountCents');
  });

  it.each([0n, -1n, -MAX_CENTS])('rejeita valor não positivo %s', (value) => {
    const error = rejection(() => parseAmountCents(value));
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('rejeita valor acima do limite técnico com AMOUNT_OUT_OF_RANGE', () => {
    expect(rejection(() => parseAmountCents(MAX_CENTS + 1n)).code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('a mensagem não ecoa o valor recebido', () => {
    const error = rejection(() => parseAmountCents(987654321));
    expect(error.message).not.toContain('987654321');
  });
});
