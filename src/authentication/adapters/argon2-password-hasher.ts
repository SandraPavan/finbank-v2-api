import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher } from '../application/ports.js';
import { AuthenticationError } from '../domain/errors.js';

// Cerca de 11 ms e 19 MiB por verificação na imagem usada (medido na preparação).
const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const PREFIX = `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$`;
const ENCODED = /^([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: PARALLELISM,
        tagLength: TAG_BYTES,
        memory: MEMORY_KIB,
        passes: PASSES,
      },
      (error, tag) => {
        if (error === null) {
          resolve(tag);
        } else {
          reject(new AuthenticationError('AUTHENTICATION_FAILED', 'HashFailure'));
        }
      },
    );
  });
}

function encode(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/** Argon2id nativo do Node, em formato PHC. Verifica somente os parâmetros vigentes. */
export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    return `${PREFIX}${encode(salt)}$${encode(await derive(password, salt))}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    const match = hash.startsWith(PREFIX) ? ENCODED.exec(hash.slice(PREFIX.length)) : null;
    const [, salt, tag] = match ?? [];
    if (salt === undefined || tag === undefined) {
      throw new AuthenticationError('AUTHENTICATION_FAILED', 'UnsupportedHash');
    }
    return timingSafeEqual(await derive(password, Buffer.from(salt, 'base64')), Buffer.from(tag, 'base64'));
  }
}
