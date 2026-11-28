// Credencial de consulta da solicitação: só mostra o estado, por tempo limitado. Não é senha nem sessão.
import { createHash, randomBytes } from 'node:crypto';

/** Crockford: 32 símbolos sem I, L, O e U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SYMBOLS = 20;
const NORMALIZED = /^[0-9A-HJKMNP-TV-Z]{20}$/;

/** Validade em tempo real (L7). */
export const STATUS_CREDENTIAL_HOURS = 24;

/** 100 bits aleatórios em cinco grupos de quatro. */
export function generateStatusCredential(): string {
  const symbols = [...randomBytes(SYMBOLS)].map((byte) => ALPHABET.charAt(byte & 31)).join('');
  return (symbols.match(/.{4}/g) ?? []).join('-');
}

/** SHA-256 da forma normalizada (maiúsculas, sem hífens), ou null se não tem o formato de uma credencial. */
export function hashStatusCredential(raw: string): string | null {
  const normalized = raw.replace(/-/g, '').toUpperCase();
  return NORMALIZED.test(normalized) ? createHash('sha256').update(normalized, 'utf8').digest('hex') : null;
}
