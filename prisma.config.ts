import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Lido sem exigir valor: `prisma generate` não precisa de conexão.
    // Comandos que conectam (migrate) falham se DATABASE_URL estiver ausente.
    url: process.env['DATABASE_URL'] ?? '',
  },
});
