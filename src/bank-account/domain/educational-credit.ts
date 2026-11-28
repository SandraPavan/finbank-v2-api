// Pedido de crédito educacional: valor em texto decimal (como em toda a API) e justificativa.
import { InvalidJustificationError, normalizeJustification } from './account-status.js';

/** Campos recusados pelo formato (400), sem valores. */
export class InvalidCreditRequestError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Pedido de crédito inválido: ${fields.join(', ')}.`);
    this.name = 'InvalidCreditRequestError';
  }
}

const AMOUNT = /^([0-9]{1,9})\.([0-9]{2})$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** Reais com exatamente duas casas para centavos inteiros, sem arredondar; null se fora do formato ou não positivo. */
export function parseAmount(raw: unknown): bigint | null {
  const match = typeof raw === 'string' ? AMOUNT.exec(raw) : null;
  if (match === null) {
    return null;
  }
  const cents = BigInt(match[1] ?? '0') * 100n + BigInt(match[2] ?? '0');
  return cents > 0n ? cents : null;
}

/** Centavos para o texto decimal da API (ex.: 15000n → "150.00"). */
export function formatAmount(cents: bigint): string {
  const whole = cents / 100n;
  const rest = cents % 100n;
  return `${whole.toString(10)}.${rest.toString(10).padStart(2, '0')}`;
}

export function parseIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY.test(raw)) {
    throw new InvalidCreditRequestError(['Idempotency-Key']);
  }
  return raw;
}

/** Corpo com exatamente `amount` e `justification`; reúne os campos recusados. */
export function parseCreditRequest(body: unknown): { amountCents: bigint; justification: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    throw new InvalidCreditRequestError(['amount', 'justification']);
  }
  const record = body as Record<string, unknown>;
  const wrong: string[] = [];
  const amountCents = parseAmount(record['amount']);
  if (amountCents === null) {
    wrong.push('amount');
  }
  let justification = '';
  try {
    justification = normalizeJustification(record['justification']);
  } catch (error) {
    if (!(error instanceof InvalidJustificationError)) {
      throw error;
    }
    wrong.push('justification');
  }
  if (wrong.length > 0) {
    throw new InvalidCreditRequestError(wrong);
  }
  if (Object.keys(record).sort().join(',') !== 'amount,justification') {
    throw new InvalidCreditRequestError([]);
  }
  return { amountCents: amountCents ?? 0n, justification };
}
