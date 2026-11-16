import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaService } from '../../src/persistence/prisma.service.js';

const run = promisify(execFile);
const databaseUrl = inject('databaseUrl');
const prismaBin = resolve('node_modules/.bin/prisma');

async function prisma(...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(prismaBin, args, {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('migrações Prisma em banco descartável', () => {
  let db: PrismaService;

  beforeAll(async () => {
    db = new PrismaService({ databaseUrl });
    await db.onModuleInit();
  });

  afterAll(async () => {
    await db?.onModuleDestroy();
  });

  it('o schema não declara modelos (nenhuma tabela de domínio ou financeira)', () => {
    const schema = readFileSync(resolve('prisma/schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/^\s*(model|enum|view)\s+\w+/m);
  });

  it('migrate deploy aplica a baseline e registra em _prisma_migrations', async () => {
    const deploy = await prisma('migrate', 'deploy');
    expect(deploy.code, deploy.output).toBe(0);

    const rows = await db.client.$queryRaw<{ migration_name: string; finished: boolean }[]>`
      SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations`;
    expect(rows).toEqual([{ migration_name: '00000000000000_baseline', finished: true }]);
  });

  it('migrate deploy é idempotente', async () => {
    const again = await prisma('migrate', 'deploy');
    expect(again.code, again.output).toBe(0);
    const rows = await db.client.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM _prisma_migrations`;
    expect(rows[0]?.total).toBe(1);
  });

  it('migrate status informa banco atualizado', async () => {
    const status = await prisma('migrate', 'status');
    expect(status.code, status.output).toBe(0);
    expect(status.output).toMatch(/up to date/i);
  });

  it('não há divergência entre banco e schema', async () => {
    const diff = await prisma(
      'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code',
    );
    expect(diff.code, diff.output).toBe(0);
  });

  it('a única tabela criada é o controle técnico do Prisma', async () => {
    const tables = await db.client.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(['_prisma_migrations']);
  });
});
