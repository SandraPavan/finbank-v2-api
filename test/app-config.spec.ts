import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, InvalidConfigError, loadAppConfig } from '../src/config/app-config.js';

describe('loadAppConfig', () => {
  it('usa a porta padrão quando PORT está ausente', () => {
    expect(loadAppConfig({})).toEqual({ port: DEFAULT_PORT });
  });

  it('aceita PORT inteiro dentro da faixa', () => {
    expect(loadAppConfig({ PORT: '1' }).port).toBe(1);
    expect(loadAppConfig({ PORT: '8080' }).port).toBe(8080);
    expect(loadAppConfig({ PORT: '65535' }).port).toBe(65_535);
  });

  it.each(['', ' ', 'abc', '80a', '-1', '3.5', '1e3', '0', '65536', '99999999999999999999'])(
    'rejeita PORT inválido %j sem coerção silenciosa',
    (value) => {
      expect(() => loadAppConfig({ PORT: value })).toThrow(InvalidConfigError);
    },
  );

  it('identifica a variável inválida no erro tipado', () => {
    try {
      loadAppConfig({ PORT: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect((error as InvalidConfigError).variable).toBe('PORT');
    }
  });
});
