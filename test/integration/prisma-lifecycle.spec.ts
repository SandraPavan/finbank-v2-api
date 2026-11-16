import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DatabaseUnavailableError } from '../../src/persistence/database-errors.js';
import { PersistenceModule } from '../../src/persistence/persistence.module.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';
import { closedLocalPort, withApplicationName } from './helpers.js';

const databaseUrl = inject('databaseUrl');

describe('PrismaService — PostgreSQL real', () => {
  let observer: PrismaService;

  async function sessionsNamed(name: string): Promise<number> {
    const rows = await observer.client.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM pg_stat_activity WHERE application_name = ${name}`;
    return rows[0]?.total ?? -1;
  }

  beforeAll(async () => {
    observer = new PrismaService({ databaseUrl: withApplicationName(databaseUrl, 'observer') });
    await observer.onModuleInit();
  });

  afterAll(async () => {
    await observer?.onModuleDestroy();
  });

  it('conecta via configuração externa a PostgreSQL 18', async () => {
    const rows = await observer.client.$queryRaw<{ version: string }[]>`SELECT version()`;
    expect(rows[0]?.version).toMatch(/^PostgreSQL 18\.6\b/);
  });

  it('abre a conexão na inicialização do módulo e encerra no close', async () => {
    const name = 'finbank-lifecycle';
    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule.forRoot({ databaseUrl: withApplicationName(databaseUrl, name) })],
    }).compile();

    expect(await sessionsNamed(name)).toBe(0);
    await moduleRef.init();
    expect(await sessionsNamed(name)).toBeGreaterThanOrEqual(1);

    await moduleRef.close();
    await expect.poll(() => sessionsNamed(name), { timeout: 5_000 }).toBe(0);
  });

  it('falha de forma sanitizada quando o banco está indisponível', async () => {
    const port = await closedLocalPort();
    const secret = 's3nh4-ficticia';
    const service = new PrismaService({
      databaseUrl: `postgresql://usuario_ficticio:${secret}@127.0.0.1:${port}/inexistente`,
      connectionTimeoutMs: 2_000,
    });

    const error = await service.onModuleInit().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    const text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    for (const leak of [secret, 'usuario_ficticio', '127.0.0.1', String(port), 'postgresql://']) {
      expect(text).not.toContain(leak);
    }
    expect((error as Error).cause).toBeUndefined();
    expect((error as DatabaseUnavailableError).code).toBe('DatabaseNotReachable');
  });

  it('falha de forma sanitizada com credencial incorreta, sem expor usuário', async () => {
    const url = new URL(databaseUrl);
    url.password = 'senha-errada-ficticia';
    const service = new PrismaService({ databaseUrl: url.toString(), connectionTimeoutMs: 2_000 });

    const error = await service.onModuleInit().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    expect((error as Error).message).not.toContain('senha-errada-ficticia');
    expect((error as Error).message).not.toContain(url.username);
    expect((error as DatabaseUnavailableError).code).toBe('28P01');
  });

  it('respeita o timeout de conexão quando o host não responde', async () => {
    const service = new PrismaService({
      databaseUrl: 'postgresql://u:senha-x@10.255.255.1:5432/db',
      connectionTimeoutMs: 1_000,
    });
    const started = Date.now();
    await expect(service.onModuleInit()).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
