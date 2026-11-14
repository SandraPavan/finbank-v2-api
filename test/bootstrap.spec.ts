import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { HealthController } from '../src/health/health.controller.js';

describe('composição e bootstrap da aplicação', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolve o controller com suas dependências injetadas por tipo', () => {
    const controller = app.get(HealthController);
    expect(controller).toBeInstanceOf(HealthController);
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
  });

  it('responde GET /health via HTTP real', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('retorna 404 para rota inexistente', async () => {
    const response = await fetch(`${baseUrl}/inexistente`);
    expect(response.status).toBe(404);
  });
});
