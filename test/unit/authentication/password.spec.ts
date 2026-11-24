import { argon2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from '../../../src/authentication/adapters/argon2-password-hasher.js';
import { RandomSessionSecrets } from '../../../src/authentication/adapters/random-session-secrets.js';
import { AuthenticationError } from '../../../src/authentication/domain/errors.js';
import { isAcceptablePassword, parseNewPassword } from '../../../src/authentication/domain/password-policy.js';

describe('política de senha', () => {
  it.each(['a'.repeat(12), 'a'.repeat(128), ' '.repeat(12), '  dez letras ', '😀'.repeat(12), '😀'.repeat(128), 'a\u0000'.repeat(6)])(
    'aceita sem alterar: %j',
    (password) => {
      expect(parseNewPassword(password)).toBe(password);
    },
  );

  it.each([undefined, null, 123456789012, {}, '', 'a'.repeat(11), 'a'.repeat(129), '😀'.repeat(11), '😀'.repeat(129), `${'a'.repeat(12)}\uD800`, `\uDC00${'a'.repeat(12)}`])(
    'recusa %j sem repetir o valor',
    (password) => {
      expect(isAcceptablePassword(password)).toBe(false);
      expect(() => parseNewPassword(password)).toThrow(new AuthenticationError('PASSWORD_POLICY'));
    },
  );
});

describe('Argon2id', () => {
  const hasher = new Argon2PasswordHasher();

  it('a implementação nativa confere com o vetor da RFC 9106', () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), associatedData: Buffer.alloc(12, 4),
      parallelism: 4, tagLength: 32, memory: 32, passes: 3,
    });
    expect(tag.toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('registra os parâmetros, usa sal próprio e confere só a senha exata', async () => {
    const password = ' Senha longa de teste ';
    const [a, b] = await Promise.all([hasher.hash(password), hasher.hash(password)]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('Senha');
    expect(await hasher.verify(password, a)).toBe(true);
    expect(await hasher.verify(password, b)).toBe(true);
    for (const wrong of [password.trim(), password.toLowerCase(), `${password} `, '']) {
      expect(await hasher.verify(wrong, a)).toBe(false);
    }
  });

  it('não trunca nem normaliza Unicode', async () => {
    const long = await hasher.hash(`${'a'.repeat(127)}b`);
    expect(await hasher.verify(`${'a'.repeat(127)}c`, long)).toBe(false);
    const composed = await hasher.hash('café café café');
    expect(await hasher.verify('café café café', composed)).toBe(false);
  });

  it('hash adulterado não confere e formato ou parâmetros diferentes são falha', async () => {
    const hash = await hasher.hash('senha de teste longa');
    const tampered = `${hash.slice(0, -2)}${hash.at(-2) === 'A' ? 'B' : 'A'}${hash.at(-1)}`;
    expect(await hasher.verify('senha de teste longa', tampered)).toBe(false);
    for (const bad of ['', 'senha de teste longa', hash.replace('t=2', 't=1'), hash.replace('argon2id', 'argon2i'), `${hash}x`]) {
      await expect(hasher.verify('senha de teste longa', bad)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    }
  });
});

describe('segredo da sessão', () => {
  const secrets = new RandomSessionSecrets();

  it('tem 256 bits, é único e só o SHA-256 é derivado', () => {
    const generated = new Set(Array.from({ length: 200 }, () => secrets.generate()));
    expect(generated.size).toBe(200);
    for (const secret of generated) {
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
      expect(secrets.digest(secret)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each([undefined, null, 1, {}, '', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(43)}\n`, 'a'.repeat(64)])(
    'recusa %j',
    (raw) => {
      expect(secrets.digest(raw)).toBeNull();
    },
  );
});
