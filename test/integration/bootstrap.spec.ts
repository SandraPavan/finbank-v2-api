import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { HealthController } from '../../src/health/health.controller.js';
import { HealthService } from '../../src/health/health.service.js';
import { PaymentExecutionService } from '../../src/payment-execution/application/payment-execution.service.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';

describe('composição e bootstrap da aplicação', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ port: 0, databaseUrl: inject('databaseUrl') })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolve o controller com suas dependências injetadas por tipo', () => {
    expect(app.get(HealthController)).toBeInstanceOf(HealthController);
    expect(app.get(HealthService).getLiveness()).toEqual({ status: 'ok' });
  });

  it('compõe a persistência com conexão ativa', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.client.$queryRaw<{ ok: number }[]>`SELECT 1::int AS ok`;
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it('compõe o PaymentExecution sem expor rotas financeiras', async () => {
    expect(app.get(PaymentExecutionService)).toBeInstanceOf(PaymentExecutionService);
    for (const path of ['/payments', '/payment-execution', '/accounts', '/ledger']) {
      const response = await fetch(`${baseUrl}${path}`, { method: 'POST' });
      expect(response.status, path).toBe(404);
    }
  });

  it('responde GET /health/live via HTTP real', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('não mantém a rota antiga GET /health (substituída por /health/live e /health/ready)', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(404);
  });

  it('retorna 404 para rota inexistente', async () => {
    const response = await fetch(`${baseUrl}/inexistente`);
    expect(response.status).toBe(404);
  });
});
