import { describe, expect, it } from 'vitest';
import { parsePage } from '../../../src/http/page.js';

describe('parsePage', () => {
  it('aplica os padrões e aceita os extremos', () => {
    expect(parsePage({})).toEqual({ limit: 20, offset: 0 });
    expect(parsePage({ limit: '1', offset: '999999' })).toEqual({ limit: 1, offset: 999_999 });
    expect(parsePage({ limit: '100', offset: '0' })).toEqual({ limit: 100, offset: 0 });
  });

  it.each(['0', '101', '', ' 1', '1 ', '01', '+1', '-1', '1.0', '1e1', '0x1', 'NaN', ['1', '2'], { a: '1' }, null, 5])(
    'recusa limit %j',
    (limit) => {
      expect(() => parsePage({ limit })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', options: { fields: ['limit'] } }));
    },
  );

  it.each(['-1', '1000000', '', '00', ['0', '0']])('recusa offset %j', (offset) => {
    expect(() => parsePage({ offset })).toThrow(expect.objectContaining({ options: { fields: ['offset'] } }));
  });

  it('recusa parâmetro desconhecido sem repeti-lo', () => {
    expect(() => parsePage({ limit: '1', identityId: 'x' })).toThrow(expect.objectContaining({ options: {} }));
  });
});
