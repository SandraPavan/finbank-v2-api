import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { request, spec } from 'pactum';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { READINESS_TIMEOUT_MS } from '../../src/health/health.service.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';
import { POSTGRES_IMAGE } from './global-setup.js';

const run = promisify(execFile);

const DB_NAME = 'finbank_v2_health';
const DB_USER = 'finbank_health';
const DB_PASSWORD = 'senha-health-descartavel';

const READY = { status: 'ok', checks: { database: 'up' } };
const NOT_READY = { status: 'unavailable', checks: { database: 'down' } };

// Container próprio: este spec torna o banco indisponível e não pode afetar os demais.
describe('health — contrato HTTP com PostgreSQL real (PactumJS)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let admin: PrismaService;
  let forbidden: string[];
  let containerStopped = false;

  async function allowConnections(allow: boolean): Promise<void> {
    await admin.client.$executeRawUnsafe(`ALTER DATABASE ${DB_NAME} ALLOW_CONNECTIONS ${allow}`);
    if (!allow) {
      await admin.client.$queryRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid()`,
      );
    }
  }

  function expectNoSensitiveData(body: unknown): void {
    const text = JSON.stringify(body);
    for (const value of forbidden) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toMatch(/postgres(ql)?:\/\/|error|code|message|PingTimeout|DatabaseNotReachable/i);
  }

  async function readiness(status: 200 | 503): Promise<unknown> {
    // O PactumJS tipa a resposta como `any`; estreitamos para o único campo usado.
    const response = (await spec()
      .get('/health/ready')
      .expectStatus(status)
      .expectHeaderContains('cache-control', 'no-store')
      .expectJson(status === 200 ? READY : NOT_READY)
      .toss()) as { body: unknown };
    return response.body;
  }

  async function liveness(): Promise<void> {
    await spec()
      .get('/health/live')
      .expectStatus(200)
      .expectHeaderContains('cache-control', 'no-store')
      .expectJson({ status: 'ok' })
      .toss();
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(DB_NAME)
      .withUsername(DB_USER)
      .withPassword(DB_PASSWORD)
      .start();
    forbidden = [DB_USER, DB_PASSWORD, DB_NAME, container.getHost(), String(container.getPort())];

    const adminUrl = new URL(container.getConnectionUri());
    adminUrl.pathname = '/postgres';
    admin = new PrismaService({ databaseUrl: adminUrl.toString() });
    await admin.onModuleInit();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ port: 0, databaseUrl: container.getConnectionUri(), session: { idleMinutes: 30, absoluteMinutes: 480 } })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    request.setBaseUrl(await app.getUrl());
  });

  afterAll(async () => {
    await app?.close();
    await admin?.onModuleDestroy();
    if (!containerStopped) {
      await container?.stop();
    }
  });

  it('banco disponível: live 200 e ready 200 com o contrato exato', async () => {
    await liveness();
    expectNoSensitiveData(await readiness(200));
  });

  it('banco recusando conexões: ready 503 sem dados sensíveis; live continua 200', async () => {
    await allowConnections(false);
    try {
      expectNoSensitiveData(await readiness(503));
      expectNoSensitiveData(await readiness(503));
      await liveness();
    } finally {
      await allowConnections(true);
    }
  });

  it('banco volta a aceitar conexões: ready se recupera para 200 sem reiniciar a aplicação', async () => {
    await expect
      .poll(async () => (await fetch(`${await app.getUrl()}/health/ready`)).status, { timeout: 10_000 })
      .toBe(200);
    await readiness(200);
  });

  it('banco sem resposta (container pausado): ready 503 dentro do limite técnico; live 200', async () => {
    await run('docker', ['pause', container.getId()]);
    try {
      const started = performance.now();
      expectNoSensitiveData(await readiness(503));
      expect(performance.now() - started).toBeLessThan(READINESS_TIMEOUT_MS + 1_500);
      await liveness();
    } finally {
      await run('docker', ['unpause', container.getId()]);
    }
    await expect
      .poll(async () => (await fetch(`${await app.getUrl()}/health/ready`)).status, { timeout: 15_000 })
      .toBe(200);
  });

  it('banco parado (porta fechada): ready 503; live 200', async () => {
    await container.stop();
    containerStopped = true;
    expectNoSensitiveData(await readiness(503));
    await liveness();
  });
});
