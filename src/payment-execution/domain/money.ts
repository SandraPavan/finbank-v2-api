import { invalidInput, PaymentExecutionError } from './errors.js';

/**
 * Limite técnico: maior valor de um BIGINT do PostgreSQL. Não é limite de negócio
 * (limites de valor dependem de contratos ainda não definidos).
 */
export const MAX_CENTS = 9_223_372_036_854_775_807n;

/**
 * Valor de uma movimentação, em centavos inteiros e positivos. Aceita somente `bigint`:
 * `number` é rejeitado para não haver perda silenciosa de precisão nem arredondamento.
 */
export function parseAmountCents(raw: unknown): bigint {
  if (typeof raw !== 'bigint') {
    throw invalidInput('amountCents', 'deve ser um inteiro em centavos do tipo bigint');
  }
  if (raw <= 0n) {
    throw invalidInput('amountCents', 'deve ser maior que zero');
  }
  if (raw > MAX_CENTS) {
    throw new PaymentExecutionError('AMOUNT_OUT_OF_RANGE');
  }
  return raw;
}
