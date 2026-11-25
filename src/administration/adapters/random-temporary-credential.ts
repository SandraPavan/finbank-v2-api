import { randomBytes } from 'node:crypto';
import type { TemporaryCredentialGenerator } from '../application/temporary-credential.js';

/** Crockford: 32 símbolos sem I, L, O e U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SYMBOLS = 20;

/** 100 bits aleatórios em cinco grupos de quatro. */
export class RandomTemporaryCredential implements TemporaryCredentialGenerator {
  generate(): string {
    const symbols = [...randomBytes(SYMBOLS)].map((byte) => ALPHABET.charAt(byte & 31)).join('');
    return (symbols.match(/.{4}/g) ?? []).join('-');
  }
}
