import { describe, expect, it } from 'vitest';
import { DatabaseUnavailableError, toDatabaseUnavailableError } from '../../src/persistence/database-errors.js';

describe('toDatabaseUnavailableError', () => {
  it('mantém apenas código técnico em allowlist', () => {
    const original = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 user=admin password=x'), {
      code: 'ECONNREFUSED',
    });
    const error = toDatabaseUnavailableError(original);
    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    expect(error.code).toBe('ECONNREFUSED');
    expect(error.message).toBe('Banco de dados indisponível (ECONNREFUSED).');
    expect(error.cause).toBeUndefined();
  });

  it('busca código na cadeia de causas', () => {
    const error = toDatabaseUnavailableError(new Error('wrapper', { cause: { code: '28P01' } }));
    expect(error.code).toBe('28P01');
  });

  it('descarta códigos fora do formato seguro', () => {
    const error = toDatabaseUnavailableError({ code: 'postgresql://u:senha@h/db' });
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('Banco de dados indisponível.');
  });

  it('tolera valores não-objeto', () => {
    expect(toDatabaseUnavailableError('texto qualquer').code).toBeUndefined();
    expect(toDatabaseUnavailableError(undefined).code).toBeUndefined();
  });
});

describe('toDatabaseUnavailableError — erros do Prisma com driver adapter', () => {
  it('prefere o kind do driver adapter ao código genérico P2010, descartando host/porta', () => {
    const prismaError = {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', host: '10.1.2.3', port: 5432 } } },
    };
    const error = toDatabaseUnavailableError(prismaError);
    expect(error.code).toBe('DatabaseNotReachable');
    expect(error.message).not.toContain('10.1.2.3');
    expect(error.message).not.toContain('5432');
  });

  it('prefere originalCode do PostgreSQL quando presente', () => {
    const prismaError = {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { kind: 'AuthenticationFailed', originalCode: '28P01', user: 'admin' } } },
    };
    expect(toDatabaseUnavailableError(prismaError).code).toBe('28P01');
  });
});
