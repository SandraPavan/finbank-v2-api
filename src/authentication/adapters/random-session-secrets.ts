import { createHash, randomBytes } from 'node:crypto';
import type { SessionSecrets } from '../application/ports.js';

/** 256 bits aleatórios em base64url (43 caracteres). */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class RandomSessionSecrets implements SessionSecrets {
  generate(): string {
    return randomBytes(32).toString('base64url');
  }

  digest(raw: unknown): string | null {
    // O segredo já tem 256 bits de entropia: SHA-256 simples basta.
    return typeof raw === 'string' && SECRET_PATTERN.test(raw) ? createHash('sha256').update(raw).digest('hex') : null;
  }
}
