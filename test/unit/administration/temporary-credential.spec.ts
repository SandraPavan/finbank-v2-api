import { describe, expect, it } from 'vitest';
import { RandomTemporaryCredential } from '../../../src/administration/adapters/random-temporary-credential.js';
import { isAcceptablePassword } from '../../../src/authentication/domain/password-policy.js';
import { InvalidConfigError, loadAppConfig } from '../../../src/config/app-config.js';

describe('credencial temporária', () => {
  it('tem 100 bits em formato fixo, sem símbolos ambíguos, sem repetição e cabe no campo de senha', () => {
    const generator = new RandomTemporaryCredential();
    const made = Array.from({ length: 2000 }, () => generator.generate());
    const symbols = new Set(made.join('').replaceAll('-', ''));
    for (const value of made) {
      expect(value).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(isAcceptablePassword(value)).toBe(true);
    }
    expect(new Set(made).size).toBe(made.length);
    expect(symbols.size).toBe(32);
  });

  it('validade configurável e estrita', () => {
    const load = (hours?: string) =>
      loadAppConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', TEMPORARY_CREDENTIAL_HOURS: hours }).temporaryCredentialHours;
    expect([load(), load('1'), load('168')]).toEqual([24, 1, 168]);
    for (const value of ['0', '169', '', '-1', '1.5', '24h']) {
      expect(() => load(value)).toThrow(InvalidConfigError);
    }
  });
});
