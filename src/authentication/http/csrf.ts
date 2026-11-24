import { createHmac, timingSafeEqual } from 'node:crypto';

/** Rótulo fixo: o token nunca coincide com o hash da sessão guardado no banco. */
const LABEL = 'finbank-csrf-v1';

/** Token derivado do segredo do contexto, que só o próprio contexto possui (cookie HttpOnly). */
export function csrfToken(contextSecret: string): string {
  return createHmac('sha256', contextSecret).update(LABEL).digest('base64url');
}

export function csrfMatches(contextSecret: string, received: string | undefined): boolean {
  const expected = Buffer.from(csrfToken(contextSecret));
  const actual = Buffer.from(received ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
