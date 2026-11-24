import { AuthenticationError } from './errors.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Com a flag u, só encontra surrogates isolados (texto malformado). */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Senha dentro da política: 12 a 128 caracteres (pontos de código), sem composição obrigatória.
 * O valor não é aparado, normalizado nem truncado. Texto malformado é recusado porque mudaria
 * ao ser convertido em UTF-8.
 */
export function isAcceptablePassword(raw: unknown): raw is string {
  // Cada ponto de código ocupa no máximo duas unidades: evita percorrer textos enormes.
  if (typeof raw !== 'string' || raw.length > PASSWORD_MAX_LENGTH * 2 || LONE_SURROGATE.test(raw)) {
    return false;
  }
  const length = [...raw].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

export function parseNewPassword(raw: unknown): string {
  if (!isAcceptablePassword(raw)) {
    throw new AuthenticationError('PASSWORD_POLICY');
  }
  return raw;
}
