// Código de inscrição: controla a participação no onboarding. Não é alias, senha nem credencial de acesso.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WorkspaceModality } from '../../identity/domain/workspace-modality.js';

/** Crockford: 32 símbolos sem I, L, O e U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SYMBOLS = 12;
const NORMALIZED = /^[0-9A-HJKMNP-TV-Z]{12}$/;

declare const brand: unique symbol;
/** SHA-256 hexadecimal do código normalizado; a única forma gravada. */
export type EnrollmentCodeHash = string & { readonly [brand]: 'EnrollmentCodeHash' };

/** 60 bits aleatórios em três grupos de quatro: `XXXX-XXXX-XXXX`. */
export function generateEnrollmentCode(): string {
  const symbols = [...randomBytes(SYMBOLS)].map((byte) => ALPHABET.charAt(byte & 31)).join('');
  return (symbols.match(/.{4}/g) ?? []).join('-');
}

/** Aceita minúsculas e ausência de hífens; null se não tem o formato de um código. */
export function normalizeEnrollmentCode(raw: string): string | null {
  const compact = raw.replace(/-/g, '').toUpperCase();
  return NORMALIZED.test(compact) ? compact : null;
}

export function hashEnrollmentCode(normalized: string): EnrollmentCodeHash {
  return createHash('sha256').update(normalized, 'utf8').digest('hex') as EnrollmentCodeHash;
}

/** Resultado da verificação para o onboarding. */
export type EnrollmentCheck = 'ACCEPTED' | 'REQUIRED' | 'INVALID';

/**
 * - Código informado: confere com o vigente (`ACCEPTED`) ou não (`INVALID`, inclusive sem vigente, revogado ou malformado).
 * - Sem código informado: `SHARED` ou workspace com código vigente exigem um (`REQUIRED`); `ISOLATED` sem vigente aceita.
 */
export function checkEnrollment(modality: WorkspaceModality, current: EnrollmentCodeHash | null, provided: string | null): EnrollmentCheck {
  if (provided === null || provided === '') {
    return modality === 'SHARED' || current !== null ? 'REQUIRED' : 'ACCEPTED';
  }
  const normalized = normalizeEnrollmentCode(provided);
  if (normalized === null || current === null) {
    return 'INVALID';
  }
  const given = Buffer.from(hashEnrollmentCode(normalized), 'hex');
  return timingSafeEqual(given, Buffer.from(current, 'hex')) ? 'ACCEPTED' : 'INVALID';
}
