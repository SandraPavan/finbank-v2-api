import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

export const POSTGRES_IMAGE = 'postgres:18.6-alpine';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('finbank_v2_test')
    .withUsername('finbank_test')
    .withPassword('senha-descartavel-teste')
    .start();
  project.provide('databaseUrl', container.getConnectionUri());
  return async () => {
    await container?.stop();
  };
}
