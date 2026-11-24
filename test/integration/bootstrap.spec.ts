import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { TEST_RUNTIME_USER } from './global-setup.js';
import { HealthController } from '../../src/health/health.controller.js';
import { HealthService } from '../../src/health/health.service.js';
import { WorkspaceAccessService } from '../../src/identity/application/workspace-access.service.js';
import { PaymentExecutionService } from '../../src/payment-execution/application/payment-execution.service.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';
import { ReconciliationService } from '../../src/reconciliation/application/reconciliation.service.js';

describe('composição e bootstrap da aplicação', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ port: 0, databaseUrl: inject('appDatabaseUrl') })],
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

  it('conecta com o usuário de execução, não com o dono do esquema', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.client.$queryRaw<{ user: string }[]>`SELECT current_user::text AS "user"`;
    expect(rows).toEqual([{ user: TEST_RUNTIME_USER }]);
  });

  it('compõe o PaymentExecution e a reconciliação sem expor rotas financeiras', async () => {
    expect(app.get(PaymentExecutionService)).toBeInstanceOf(PaymentExecutionService);
    expect(app.get(ReconciliationService)).toBeInstanceOf(ReconciliationService);
    for (const path of ['/payments', '/payment-execution', '/accounts', '/ledger', '/reversals', '/reconciliation']) {
      const response = await fetch(`${baseUrl}${path}`, { method: 'POST' });
      expect(response.status, path).toBe(404);
    }
  });

  it('compõe a consulta de acesso sem expor rotas de identidade', async () => {
    const access = app.get(WorkspaceAccessService);
    const unknown = '00000000-0000-4000-8000-000000000000';
    await expect(access.resolve(unknown, unknown)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    for (const path of ['/identity', '/identities', '/workspaces', '/memberships', '/auth', '/login']) {
      for (const method of ['GET', 'POST']) {
        expect((await fetch(`${baseUrl}${path}`, { method })).status, `${method} ${path}`).toBe(404);
      }
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
