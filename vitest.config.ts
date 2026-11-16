import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    teardownTimeout: 30_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts'],
          environment: 'node',
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
