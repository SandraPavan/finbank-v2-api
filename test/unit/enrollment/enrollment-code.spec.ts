import { describe, expect, it } from 'vitest';
import {
  checkEnrollment,
  type EnrollmentCodeHash,
  generateEnrollmentCode,
  hashEnrollmentCode,
  normalizeEnrollmentCode,
} from '../../../src/enrollment/domain/enrollment-code.js';

const FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const hashOf = (code: string): EnrollmentCodeHash => hashEnrollmentCode(normalizeEnrollmentCode(code) ?? '');

describe('código de inscrição', () => {
  it('gera XXXX-XXXX-XXXX sem símbolos ambíguos e sem repetir', () => {
    const codes = Array.from({ length: 2_000 }, generateEnrollmentCode);
    codes.forEach((code) => expect(code).toMatch(FORMAT));
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.join('')).not.toMatch(/[ILOU]/);
  });

  it('normaliza minúsculas e ausência de hífens; recusa o que não é código', () => {
    expect(normalizeEnrollmentCode('ab12-cd34-ef56')).toBe('AB12CD34EF56');
    expect(normalizeEnrollmentCode('AB12CD34EF56')).toBe('AB12CD34EF56');
    for (const raw of ['', 'AB12-CD34', 'AB12-CD34-EF56-GH78', 'AB12-CD34-EF5I', 'AB12 CD34 EF56', 'ÁB12-CD34-EF56', 'AB12-CD34-EF56\n']) {
      expect(normalizeEnrollmentCode(raw), raw).toBeNull();
    }
  });

  it('o hash é SHA-256 hexadecimal do código normalizado, igual para as formas aceitas', () => {
    expect(hashOf('ab12-cd34-ef56')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf('ab12-cd34-ef56')).toBe(hashOf('AB12CD34EF56'));
    expect(hashOf('AB12-CD34-EF56')).not.toBe(hashOf('AB12-CD34-EF57'));
  });
});

describe('verificação para o onboarding', () => {
  const code = 'AB12-CD34-EF56';
  const current = hashOf(code);

  it.each<[string, 'SHARED' | 'ISOLATED', EnrollmentCodeHash | null, string | null, string]>([
    ['SHARED sem vigente e sem código', 'SHARED', null, null, 'REQUIRED'],
    ['SHARED sem vigente e código vazio', 'SHARED', null, '', 'REQUIRED'],
    ['SHARED sem vigente e qualquer código', 'SHARED', null, code, 'INVALID'],
    ['SHARED com vigente e sem código', 'SHARED', current, null, 'REQUIRED'],
    ['SHARED com vigente e código certo', 'SHARED', current, code, 'ACCEPTED'],
    ['SHARED com vigente, minúsculas e sem hífens', 'SHARED', current, 'ab12cd34ef56', 'ACCEPTED'],
    ['SHARED com vigente e código errado', 'SHARED', current, 'AB12-CD34-EF57', 'INVALID'],
    ['SHARED com vigente e código malformado', 'SHARED', current, 'AB12', 'INVALID'],
    ['ISOLATED sem vigente e sem código', 'ISOLATED', null, null, 'ACCEPTED'],
    ['ISOLATED sem vigente e código vazio', 'ISOLATED', null, '', 'ACCEPTED'],
    ['ISOLATED sem vigente e qualquer código', 'ISOLATED', null, code, 'INVALID'],
    ['ISOLATED com vigente e sem código', 'ISOLATED', current, null, 'REQUIRED'],
    ['ISOLATED com vigente e código certo', 'ISOLATED', current, code, 'ACCEPTED'],
    ['ISOLATED com vigente e código errado', 'ISOLATED', current, 'AB12-CD34-EF57', 'INVALID'],
  ])('%s', (_label, modality, hash, provided, expected) => {
    expect(checkEnrollment(modality, hash, provided)).toBe(expected);
  });
});
