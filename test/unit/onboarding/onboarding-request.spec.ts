import { describe, expect, it } from 'vitest';
import {
  ageOn,
  normalizeCpf,
  normalizeName,
  normalizePhone,
  OnboardingValidationError,
  parseBirthDate,
  parseOnboardingRequest,
} from '../../../src/onboarding/domain/onboarding-request.js';

// CPFs sintéticos com dígitos verificadores válidos, gerados para teste.
const VALID_CPF = '52998224725';
const VALID_CPF_MASKED = '529.982.247-25';

const VALID_BODY = {
  alias: 'turma-a',
  name: 'Ana Fictícia',
  cpf: VALID_CPF_MASKED,
  birthDate: '1990-05-17',
  email: 'Ana@Example.test',
  phone: '(11) 98765-4321',
  password: 'senha de teste bem longa',
};

describe('CPF', () => {
  it.each([VALID_CPF, VALID_CPF_MASKED, '11144477735', '111.444.777-35'])('aceita %s e normaliza para 11 dígitos', (raw) => {
    expect(normalizeCpf(raw)).toMatch(/^\d{11}$/);
  });

  it.each([
    ['dígito verificador errado', '52998224724'],
    ['segundo verificador errado', '52998224735'],
    ['sequência repetida', '11111111111'],
    ['zeros', '000.000.000-00'],
    ['curto', '5299822472'],
    ['longo', '529982247250'],
    ['máscara parcial', '529.982.24725'],
    ['letras', '5299822472a'],
    ['espaços', ' 52998224725'],
    ['dígitos não ASCII', '５２９９８２２４７２５'],
  ])('recusa %s', (_label, raw) => {
    expect(normalizeCpf(raw)).toBeNull();
  });
});

describe('telefone', () => {
  it.each([
    ['(11) 98765-4321', '11987654321'],
    ['11987654321', '11987654321'],
    ['+55 11 98765-4321', '11987654321'],
    ['(21) 3456-7890', '2134567890'],
  ])('aceita %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(['(01) 98765-4321', '(10) 98765-4321', '11887654321', '119876543', '+1 11 98765-4321', '1198765432100', 'telefone', '+55 (11) 9876-543'])(
    'recusa %s',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );
});

describe('nome', () => {
  it('apara e reduz espaços', () => {
    expect(normalizeName('  Ana   Maria  Fictícia ')).toBe('Ana Maria Fictícia');
  });

  it.each(['A', ' ', 'x'.repeat(121), 'Ana\u0000Maria', 'Ana\nMaria', '\ud800ana'])('recusa %j', (raw) => {
    expect(normalizeName(raw)).toBeNull();
  });
});

describe('data de nascimento e idade', () => {
  it.each(['1900-01-01', '2000-02-29', '1990-12-31'])('aceita %s', (raw) => {
    expect(parseBirthDate(raw)).toBe(raw);
  });

  it.each(['1899-12-31', '2001-02-29', '1990-04-31', '1990-13-01', '1990-1-1', '17/05/1990', ''])('recusa %s', (raw) => {
    expect(parseBirthDate(raw)).toBeNull();
  });

  it.each([
    ['exatamente 18 no aniversário', '2009-11-27', '2027-11-27', 18],
    ['um dia antes do aniversário', '2009-11-28', '2027-11-27', 17],
    ['29/02 em ano não bissexto: ainda não completou em 28/02', '2008-02-29', '2026-02-28', 17],
    ['29/02 em ano não bissexto: completa em 01/03', '2008-02-29', '2026-03-01', 18],
    ['29/02 com aniversário em ano não bissexto, véspera', '2012-02-29', '2030-02-28', 17],
    ['29/02 em ano bissexto: no próprio dia', '2012-02-29', '2032-02-29', 20],
    ['virada do ano', '2008-12-31', '2027-01-01', 18],
  ])('%s', (_label, birth, on, age) => {
    expect(ageOn(birth, on)).toBe(age);
  });
});

describe('pedido de abertura', () => {
  it('normaliza todos os campos; código ausente ou vazio vira null', () => {
    expect(parseOnboardingRequest(VALID_BODY)).toEqual({
      alias: 'turma-a', enrollmentCode: null, name: 'Ana Fictícia', cpf: VALID_CPF, birthDate: '1990-05-17',
      email: 'ana@example.test', phone: '11987654321', password: 'senha de teste bem longa',
    });
    expect(parseOnboardingRequest({ ...VALID_BODY, enrollmentCode: '' }).enrollmentCode).toBeNull();
    expect(parseOnboardingRequest({ ...VALID_BODY, enrollmentCode: null }).enrollmentCode).toBeNull();
    expect(parseOnboardingRequest({ ...VALID_BODY, enrollmentCode: 'ab12-cd34-ef56' }).enrollmentCode).toBe('ab12-cd34-ef56');
  });

  it('reúne todos os campos recusados, na ordem do contrato, sem valores na mensagem', () => {
    const error = (() => {
      try {
        parseOnboardingRequest({ ...VALID_BODY, cpf: '52998224724', phone: 'x', password: 'curta', email: 'sem-arroba' });
      } catch (e) {
        return e as OnboardingValidationError;
      }
      throw new Error('não recusou');
    })();
    expect(error.fields).toEqual(['cpf', 'email', 'phone', 'password']);
    expect(error.message).not.toMatch(/52998224724|curta|sem-arroba/);
  });

  it.each<[string, unknown, string[]]>([
    ['nulo', null, ['alias', 'enrollmentCode', 'name', 'cpf', 'birthDate', 'email', 'phone', 'password']],
    ['lista', [], ['alias', 'enrollmentCode', 'name', 'cpf', 'birthDate', 'email', 'phone', 'password']],
    ['campo ausente', { ...VALID_BODY, name: undefined }, ['name']],
    ['campo numérico', { ...VALID_BODY, cpf: 52998224725 }, ['cpf']],
    ['código numérico', { ...VALID_BODY, enrollmentCode: 123 }, ['enrollmentCode']],
    ['alias inválido', { ...VALID_BODY, alias: 'Turma A' }, ['alias']],
    ['campo extra', { ...VALID_BODY, status: 'APPROVED' }, []],
    ['workspace forjado', { ...VALID_BODY, workspaceId: '11111111-1111-4111-8111-111111111111' }, []],
  ])('%s', (_label, body, fields) => {
    expect(() => parseOnboardingRequest(body)).toThrow(OnboardingValidationError);
    try {
      parseOnboardingRequest(body);
    } catch (e) {
      expect((e as OnboardingValidationError).fields).toEqual(fields);
    }
  });
});
