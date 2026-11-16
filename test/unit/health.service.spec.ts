import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthService, READINESS_TIMEOUT_MS, type DatabaseProbe } from '../../src/health/health.service.js';
import { DatabaseUnavailableError } from '../../src/persistence/database-errors.js';

function probe(...outcomes: Array<'up' | Error>): DatabaseProbe & { ping: ReturnType<typeof vi.fn> } {
  const ping = vi.fn(async () => {
    const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
    if (next instanceof Error) {
      throw next;
    }
  });
  return { ping };
}

describe('HealthService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('liveness não consulta o banco', () => {
    const database = probe(new DatabaseUnavailableError('DatabaseNotReachable'));
    expect(new HealthService(database).getLiveness()).toEqual({ status: 'ok' });
    expect(database.ping).not.toHaveBeenCalled();
  });

  it('readiness reporta up com o limite técnico de tempo', async () => {
    const database = probe('up');
    await expect(new HealthService(database).getReadiness()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
    expect(database.ping).toHaveBeenCalledWith(READINESS_TIMEOUT_MS);
  });

  it.each([
    new DatabaseUnavailableError('DatabaseNotReachable'),
    new DatabaseUnavailableError('PingTimeout'),
    new Error('postgresql://usuario:segredo-x@db-interno:5432/finbank falhou'),
  ])('readiness reporta down sem detalhes no payload (%s)', async (failure) => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const result = await new HealthService(probe(failure)).getReadiness();
    expect(result).toEqual({ status: 'unavailable', checks: { database: 'down' } });
  });

  it('registra somente transições de estado, com mensagem sanitizada', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const raw = new Error('connect ECONNREFUSED db-interno:5432 usuario segredo-x');
    const service = new HealthService(
      probe('up', new DatabaseUnavailableError('DatabaseNotReachable'), new DatabaseUnavailableError('DatabaseNotReachable'), raw, 'up', 'up'),
    );

    for (let i = 0; i < 6; i += 1) {
      await service.getReadiness();
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Readiness: Banco de dados indisponível (DatabaseNotReachable).');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Readiness: banco de dados disponível novamente.');
    const logged = [...warn.mock.calls, ...log.mock.calls].flat().join(' ');
    expect(logged).not.toMatch(/segredo|usuario|db-interno|5432|ECONNREFUSED/);
  });

  it('erro não sanitizado vira mensagem genérica no log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await new HealthService(probe(new Error('senha=segredo-x host=db-interno'))).getReadiness();
    expect(warn).toHaveBeenCalledWith('Readiness: Banco de dados indisponível.');
  });
});
