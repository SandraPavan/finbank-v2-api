import { ProblemError } from './problem.js';

export const PAGE_DEFAULT_LIMIT = 20;
export const PAGE_MAX_LIMIT = 100;
export const PAGE_MAX_OFFSET = 999_999;

const INTEGER = /^(0|[1-9][0-9]{0,5})$/;

/** `limit` e `offset` estritos: sem coerção, repetição ou parâmetro desconhecido. */
export function parsePage(query: Readonly<Record<string, unknown>>): { limit: number; offset: number } {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = query[name];
    if (raw === undefined) {
      return fallback;
    }
    const value = typeof raw === 'string' && INTEGER.test(raw) ? Number(raw) : NaN;
    if (!(value >= min && value <= max)) {
      throw new ProblemError('VALIDATION_ERROR', { fields: [name] });
    }
    return value;
  };
  if (Object.keys(query).some((name) => name !== 'limit' && name !== 'offset')) {
    throw new ProblemError('VALIDATION_ERROR');
  }
  return { limit: integer('limit', PAGE_DEFAULT_LIMIT, 1, PAGE_MAX_LIMIT), offset: integer('offset', 0, 0, PAGE_MAX_OFFSET) };
}
