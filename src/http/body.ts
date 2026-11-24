import { ProblemError } from './problem.js';

/** Corpo com exatamente os campos declarados, todos texto. Sem coerção. */
export function parseTextFields<K extends string>(body: unknown, fields: readonly K[]): Record<K, string> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProblemError('VALIDATION_ERROR', { fields });
  }
  const record = body as Record<string, unknown>;
  const wrong = fields.filter((field) => !Object.hasOwn(record, field) || typeof record[field] !== 'string');
  if (wrong.length > 0) {
    throw new ProblemError('VALIDATION_ERROR', { fields: wrong });
  }
  if (Object.keys(record).length !== fields.length) {
    throw new ProblemError('VALIDATION_ERROR');
  }
  return Object.fromEntries(fields.map((field) => [field, record[field]])) as Record<K, string>;
}

/** Operação sem parâmetros: corpo ausente ou objeto vazio. */
export function parseNoBody(body: unknown): void {
  if (body !== undefined) {
    parseTextFields(body, []);
  }
}
