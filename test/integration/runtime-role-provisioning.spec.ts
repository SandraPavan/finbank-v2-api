// Provisionamento do usuário de execução em PostgreSQL real: idempotência, troca de senha e recusas.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { provision, ProvisionError } from '../../scripts/provision-runtime-role.mjs';
import { DatabaseUnavailableError } from '../../src/persistence/database-errors.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';

const run = promisify(execFile);
const ROTATION_USER = 'finbank_app_rotation';
const ADMIN_LIKE = 'finbank_admin_like';
const CLI_USER = 'finbank_app_cli';

const password = (): string => randomBytes(18).toString('hex');

describe('provisionamento do usuário de execução', () => {
  const adminUrl = inject('databaseUrl');
  let admin: PrismaService;

  function urlFor(user: string, secret: string): string {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = secret;
    return url.toString();
  }

  /** Conecta e devolve o usuário corrente, ou o código técnico da falha de conexão. */
  async function connectAs(user: string, secret: string): Promise<string> {
    const db = new PrismaService({ databaseUrl: urlFor(user, secret) });
    try {
      await db.onModuleInit();
      const [row] = await db.client.$queryRaw<{ user: string }[]>`SELECT current_user::text AS "user"`;
      await db.onModuleDestroy();
      return row?.user ?? '';
    } catch (error) {
      return `falha:${error instanceof DatabaseUnavailableError ? (error.code ?? '') : 'outro'}`;
    }
  }

  async function attributes(role: string): Promise<{ superuser: boolean; member: boolean } | undefined> {
    // Vínculo explícito em pg_auth_members: pg_has_role é sempre verdadeiro para superusuários.
    const rows = await admin.client.$queryRaw<{ superuser: boolean; member: boolean }[]>`
      SELECT r.rolsuper AS "superuser",
             EXISTS (
               SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                WHERE m.member = r.oid AND g.rolname = 'finbank_runtime'
             ) AS "member"
        FROM pg_roles r WHERE r.rolname = ${role}`;
    return rows[0];
  }

  beforeAll(async () => {
    admin = new PrismaService({ databaseUrl: adminUrl });
    await admin.onModuleInit();
  });

  afterAll(async () => {
    for (const role of [ROTATION_USER, ADMIN_LIKE, CLI_USER]) {
      await admin?.client.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin?.onModuleDestroy();
  });

  it('é idempotente e a troca de senha passa a valer', async () => {
    const first = password();
    const env = { DATABASE_URL: adminUrl, RUNTIME_DB_USER: ROTATION_USER, RUNTIME_DB_PASSWORD: first };
    expect(provision(env)).toBe(ROTATION_USER);
    expect(provision(env)).toBe(ROTATION_USER);
    expect(await connectAs(ROTATION_USER, first)).toBe(ROTATION_USER);
    expect(await attributes(ROTATION_USER)).toEqual({ superuser: false, member: true });

    const second = password();
    provision({ ...env, RUNTIME_DB_PASSWORD: second });
    expect(await connectAs(ROTATION_USER, second)).toBe(ROTATION_USER);
    expect(await connectAs(ROTATION_USER, first)).toBe('falha:28P01');
  });

  it('recusa usar o dono do esquema como usuário de execução e não o altera', async () => {
    const owner = new URL(adminUrl).username;
    const error = (() => {
      try {
        provision({ DATABASE_URL: adminUrl, RUNTIME_DB_USER: owner, RUNTIME_DB_PASSWORD: password() });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ProvisionError);
    expect((error as Error).message).toContain('diferente do dono do esquema');
    expect((await attributes(owner))?.superuser).toBe(true);
  });

  it('recusa rebaixar um papel existente com atributos administrativos', async () => {
    await admin.client.$executeRawUnsafe(`CREATE ROLE "${ADMIN_LIKE}" SUPERUSER LOGIN`);
    expect(() =>
      provision({ DATABASE_URL: adminUrl, RUNTIME_DB_USER: ADMIN_LIKE, RUNTIME_DB_PASSWORD: password() }),
    ).toThrow(/atributos administrativos/);
    expect(await attributes(ADMIN_LIKE)).toEqual({ superuser: true, member: false });
  });

  it.each([
    [
      'com privilégios diretos',
      'finbank_preexisting_grants',
      'GRANT UPDATE ON TABLE "account" TO "finbank_preexisting_grants"; GRANT DELETE ON TABLE "ledger_entry" TO "finbank_preexisting_grants"',
      'REVOKE ALL ON TABLE "account", "ledger_entry" FROM "finbank_preexisting_grants"',
      /privilégios diretos/,
    ],
    [
      'dono de objeto',
      'finbank_preexisting_owner',
      'CREATE TABLE "tabela_do_papel" ("id" int); ALTER TABLE "tabela_do_papel" OWNER TO "finbank_preexisting_owner"',
      'DROP TABLE IF EXISTS "tabela_do_papel"',
      /dono de objetos/,
    ],
    [
      'membro de outro papel',
      'finbank_preexisting_member',
      'GRANT "pg_write_all_data" TO "finbank_preexisting_member"',
      'REVOKE "pg_write_all_data" FROM "finbank_preexisting_member"',
      /pertence a outros papéis/,
    ],
  ])('recusa reaproveitar papel existente %s, sem alterá-lo', async (_label, role, setup, cleanup, message) => {
    await admin.client.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN`);
    try {
      for (const statement of setup.split('; ')) {
        await admin.client.$executeRawUnsafe(statement);
      }
      expect(() => provision({ DATABASE_URL: adminUrl, RUNTIME_DB_USER: role, RUNTIME_DB_PASSWORD: password() })).toThrow(
        message,
      );
      expect(await attributes(role)).toEqual({ superuser: false, member: false });
    } finally {
      await admin.client.$executeRawUnsafe(cleanup);
      await admin.client.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  });

  it('pela linha de comando (como no Compose): provisiona e falha sem repetir a senha', async () => {
    const script = resolve('scripts/provision-runtime-role.mjs');
    const secret = password();
    const ok = await run(process.execPath, [script], {
      env: { ...process.env, DATABASE_URL: adminUrl, RUNTIME_DB_USER: CLI_USER, RUNTIME_DB_PASSWORD: secret },
    });
    expect(ok.stdout).toContain(`usuário de execução provisionado: ${CLI_USER}`);
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(secret);
    expect(await connectAs(CLI_USER, secret)).toBe(CLI_USER);

    const invalid = 'senha invalida com espacos';
    const failure = await run(process.execPath, [script], {
      env: { ...process.env, DATABASE_URL: adminUrl, RUNTIME_DB_USER: CLI_USER, RUNTIME_DB_PASSWORD: invalid },
    }).then(
      () => ({ code: 0, output: '' }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }),
    );
    expect(failure.code).toBe(1);
    expect(failure.output).toContain('RUNTIME_DB_PASSWORD');
    expect(failure.output).not.toContain(invalid);
  });
});
