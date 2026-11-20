import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

export const POSTGRES_IMAGE = 'postgres:18.6-alpine';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
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
  project.provide('databaseUrl', databaseUrl);
  return async () => {
    await container?.stop();
  };
}
