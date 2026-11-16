import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, InvalidConfigError, loadAppConfig } from '../../src/config/app-config.js';

const VALID_DB = 'postgresql://usuario_ficticio:senha-ficticia@localhost:5432/finbank';

describe('loadAppConfig — PORT', () => {
  it('usa a porta padrão quando PORT está ausente', () => {
    expect(loadAppConfig({ DATABASE_URL: VALID_DB }).port).toBe(DEFAULT_PORT);
  });

  it('aceita PORT inteiro dentro da faixa', () => {
    expect(loadAppConfig({ PORT: '1', DATABASE_URL: VALID_DB }).port).toBe(1);
    expect(loadAppConfig({ PORT: '8080', DATABASE_URL: VALID_DB }).port).toBe(8080);
    expect(loadAppConfig({ PORT: '65535', DATABASE_URL: VALID_DB }).port).toBe(65_535);
  });

  it.each(['', ' ', 'abc', '80a', '-1', '3.5', '1e3', '0', '65536', '99999999999999999999'])(
    'rejeita PORT inválido %j sem coerção silenciosa',
    (value) => {
      expect(() => loadAppConfig({ PORT: value, DATABASE_URL: VALID_DB })).toThrow(InvalidConfigError);
    },
  );
});

describe('loadAppConfig — DATABASE_URL', () => {
  it('aceita URLs postgres:// e postgresql://', () => {
    expect(loadAppConfig({ DATABASE_URL: VALID_DB }).databaseUrl).toBe(VALID_DB);
    const short = 'postgres://u:p@db.local:5433/x?sslmode=disable';
    expect(loadAppConfig({ DATABASE_URL: short }).databaseUrl).toBe(short);
  });

  it.each([undefined, '', '   '])('exige DATABASE_URL (%j)', (value) => {
    expect(() => loadAppConfig({ DATABASE_URL: value })).toThrow(/DATABASE_URL é obrigatória/);
  });

  it.each([
    'mysql://usuario:segredo-x@localhost/db',
    'file:./dev.db',
    'nao-e-url-segredo-x',
    'postgresql://usuario:segredo-x@/db',
  ])('rejeita URL inválida %j sem ecoar o valor', (value) => {
    try {
      loadAppConfig({ DATABASE_URL: value });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect((error as InvalidConfigError).variable).toBe('DATABASE_URL');
      expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).not.toContain('segredo');
    }
  });
});
