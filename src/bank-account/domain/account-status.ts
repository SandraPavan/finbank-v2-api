// Estado bancário da conta do cliente, independente do estado da identidade.

export type BankAccountStatus = 'ACTIVE' | 'BLOCKED';

export const JUSTIFICATION_MIN_LENGTH = 10;
export const JUSTIFICATION_MAX_LENGTH = 200;

const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Justificativa recusada pelo formato. A mensagem nunca repete o texto recebido. */
export class InvalidJustificationError extends Error {
  constructor() {
    super(`Justificativa inválida: de ${JUSTIFICATION_MIN_LENGTH} a ${JUSTIFICATION_MAX_LENGTH} caracteres, sem caracteres de controle.`);
    this.name = 'InvalidJustificationError';
  }
}

/** Corpo com exatamente `justification`. */
export function parseJustification(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    throw new InvalidJustificationError();
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1) {
    throw new InvalidJustificationError();
  }
  return normalizeJustification(record['justification']);
}

/** Texto sem espaços nas pontas, 10 a 200 pontos de código, sem caracteres de controle. */
export function normalizeJustification(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > JUSTIFICATION_MAX_LENGTH * 4) {
    throw new InvalidJustificationError();
  }
  if (CONTROL.test(raw) || LONE_SURROGATE.test(raw)) {
    throw new InvalidJustificationError();
  }
  const text = raw.trim();
  const length = [...text].length;
  if (length < JUSTIFICATION_MIN_LENGTH || length > JUSTIFICATION_MAX_LENGTH) {
    throw new InvalidJustificationError();
  }
  return text;
}
