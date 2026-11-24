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

describe('loadAppConfig — sessão', () => {
  const load = (env: Record<string, string>) => loadAppConfig({ DATABASE_URL: VALID_DB, ...env }).session;

  it('usa 30 minutos de inatividade e 8 horas no total por padrão', () => {
    expect(load({})).toEqual({ idleMinutes: 30, absoluteMinutes: 480 });
  });

  it('aceita limites e inatividade igual à duração absoluta', () => {
    expect(load({ SESSION_IDLE_MINUTES: '1', SESSION_ABSOLUTE_MINUTES: '1440' })).toEqual({ idleMinutes: 1, absoluteMinutes: 1440 });
    expect(load({ SESSION_IDLE_MINUTES: '60', SESSION_ABSOLUTE_MINUTES: '60' })).toEqual({ idleMinutes: 60, absoluteMinutes: 60 });
  });

  it.each(['', ' ', '0', '-1', '1.5', '1441', '99999', '30m', '1e2', ' 30'])('rejeita %j', (value) => {
    expect(() => load({ SESSION_IDLE_MINUTES: value })).toThrow(/SESSION_IDLE_MINUTES/);
    expect(() => load({ SESSION_ABSOLUTE_MINUTES: value })).toThrow(/SESSION_ABSOLUTE_MINUTES/);
  });

  it('rejeita inatividade maior que a duração absoluta', () => {
    expect(() => load({ SESSION_IDLE_MINUTES: '61', SESSION_ABSOLUTE_MINUTES: '60' })).toThrow(/menor ou igual/);
  });
});
