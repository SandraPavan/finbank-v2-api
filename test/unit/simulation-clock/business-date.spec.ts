import { describe, expect, it } from 'vitest';
import { InvalidBusinessDateError, MAX_BUSINESS_DATE, MIN_BUSINESS_DATE, parseBusinessDate } from '../../../src/simulation-clock/domain/business-date.js';

describe('data de negócio simulada', () => {
  it.each(['2000-01-01', '2099-12-31', '2024-02-29', '2000-02-29', '2027-01-31', '2027-04-30', '2026-11-25'])('aceita %s sem alterar', (raw) => {
    expect(parseBusinessDate(raw)).toBe(raw);
  });

  it.each([
    ['dia inexistente', '2027-02-30'],
    ['29 de fevereiro em ano comum', '2027-02-29'],
    ['29 de fevereiro em centenário não bissexto', '2100-02-29'],
    ['31 em mês de 30 dias', '2027-04-31'],
    ['mês 13', '2027-13-01'],
    ['mês 0', '2027-00-10'],
    ['dia 0', '2027-01-00'],
    ['antes da faixa', '1999-12-31'],
    ['depois da faixa', '2100-01-01'],
    ['com hora', '2027-01-01T00:00:00Z'],
    ['sem zeros', '2027-1-1'],
    ['barras', '01/01/2027'],
    ['espaços', ' 2027-01-01'],
    ['quebra de linha', '2027-01-01\n'],
    ['dígitos não ASCII', '２０２７-01-01'],
    ['vazio', ''],
  ])('recusa %s', (_label, raw) => {
    expect(() => parseBusinessDate(raw)).toThrow(InvalidBusinessDateError);
  });

  it('a mensagem cita a faixa e nunca o valor recebido', () => {
    const error = (() => {
      try {
        parseBusinessDate('1999-12-31');
      } catch (e) {
        return e as Error;
      }
      return new Error('não lançou');
    })();
    expect(error.message).toContain(MIN_BUSINESS_DATE);
    expect(error.message).toContain(MAX_BUSINESS_DATE);
    expect(error.message).not.toContain('1999-12-31');
  });
});
