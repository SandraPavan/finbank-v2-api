import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { provision } from '../../scripts/provision-runtime-role.mjs';

export const POSTGRES_IMAGE = 'postgres:18.6-alpine';
/** Usuário de login de execução dos testes (membro de finbank_runtime, sem posse de objetos). */
export const TEST_RUNTIME_USER = 'finbank_app_test';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Dono do esquema: migrações, preparação e inspeção de dados nos testes. */
    databaseUrl: string;
    /** Usuário de execução: o mesmo papel com que a API conecta. */
    appDatabaseUrl: string;
  }
}

const run = promisify(execFile);
let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('finbank_v2_test')
    .withUsername('finbank_test')
    .withPassword('senha-descartavel-teste')
    .start();
  const databaseUrl = container.getConnectionUri();
  // Banco descartável recebe as migrações versionadas antes de qualquer teste.
  await run(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  // Usuário de execução provisionado pelo mesmo script usado no Compose.
  const runtimePassword = randomBytes(18).toString('hex');
  provision({ DATABASE_URL: databaseUrl, RUNTIME_DB_USER: TEST_RUNTIME_USER, RUNTIME_DB_PASSWORD: runtimePassword });
  const appUrl = new URL(databaseUrl);
  appUrl.username = TEST_RUNTIME_USER;
  appUrl.password = runtimePassword;
  project.provide('databaseUrl', databaseUrl);
  project.provide('appDatabaseUrl', appUrl.toString());
  return async () => {
    await container?.stop();
  };
}
