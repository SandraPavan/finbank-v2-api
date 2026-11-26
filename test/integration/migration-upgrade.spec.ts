// Migrações posteriores ao núcleo (estorno, papel de execução e identidade) aplicadas sobre um banco com dados anteriores.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaPaymentExecutionStore } from '../../src/payment-execution/adapters/prisma-payment-execution.store.js';
import { PaymentExecutionService } from '../../src/payment-execution/application/payment-execution.service.js';
import { PrismaService } from '../../src/persistence/prisma.service.js';
import { PrismaReconciliationReader } from '../../src/reconciliation/adapters/prisma-reconciliation.reader.js';
import { ReconciliationService } from '../../src/reconciliation/application/reconciliation.service.js';

const run = promisify(execFile);
const prismaBin = resolve('node_modules/.bin/prisma');
const UPGRADE_DB = 'finbank_v2_upgrade_check';
const BLOCKED_DB = 'finbank_v2_upgrade_blocked';
const BEFORE = ['00000000000000_baseline', '20261119000000_payment_execution_core'];
const AFTER = [
  '20261120000000_payment_reversal_reconciliation',
  '20261121000000_runtime_role_privileges',
  '20261123000000_identity_membership',
  '20261124000000_identity_profile',
  '20261125000000_password_session',
  '20261126000000_authentication_control',
  '20261127000000_administration',
  '20261128000000_temporary_credential',
  '20261129000000_educational_config',
  '20261130000000_payment_states_credit',
  '20261201000000_simulation_clock',
  '20261202000000_workspace_modality_enrollment',
];

const WS = '11111111-1111-4111-8111-111111111111';
const CONTRA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EARLIER_OP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function prisma(databaseUrl: string, ...args: string[]): Promise<void> {
  await run(prismaBin, args, { env: { ...process.env, DATABASE_URL: databaseUrl } });
}

describe('migração aditiva sobre dados existentes', () => {
  const mainUrl = inject('databaseUrl');
  const inUpgradeDb = (base: string): string => {
    const url = new URL(base);
    url.pathname = `/${UPGRADE_DB}`;
    return url.toString();
  };
  const upgradeUrl = inUpgradeDb(mainUrl);
  const appUpgradeUrl = inUpgradeDb(inject('appDatabaseUrl'));
  let main: PrismaService;
  let upgraded: PrismaService | undefined;
  let runtime: PrismaService | undefined;
  let blocked: PrismaService | undefined;

  beforeAll(async () => {
    main = new PrismaService({ databaseUrl: mainUrl });
    await main.onModuleInit();
    await main.client.$executeRawUnsafe(`CREATE DATABASE "${UPGRADE_DB}"`);
  });

  afterAll(async () => {
    await runtime?.onModuleDestroy();
    await upgraded?.onModuleDestroy();
    await blocked?.onModuleDestroy();
    await main?.client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${UPGRADE_DB}" WITH (FORCE)`);
    await main?.client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${BLOCKED_DB}" WITH (FORCE)`);
    await main?.onModuleDestroy();
  });

  it('preserva operações anteriores como TRANSFER e permite estorná-las pelo usuário de execução', async () => {
    for (const migration of BEFORE) {
      await prisma(upgradeUrl, 'db', 'execute', '--file', `prisma/migrations/${migration}/migration.sql`);
    }
    upgraded = new PrismaService({ databaseUrl: upgradeUrl });
    await upgraded.onModuleInit();
    const db = upgraded.client;

    // Dados no formato do núcleo anterior (sem tipo nem vínculo), gravados por SQL.
    await db.$executeRaw`INSERT INTO "workspace" ("id") VALUES (${WS}::uuid)`;
    await db.$executeRaw`
      INSERT INTO "account" ("id", "workspace_id", "kind")
      VALUES (${CONTRA}::uuid, ${WS}::uuid, 'CONTRA'), (${ACCOUNT}::uuid, ${WS}::uuid, 'STANDARD')`;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "payment_operation"
          ("id", "workspace_id", "operation_key", "fingerprint", "debit_account_id", "credit_account_id", "amount_cents")
        VALUES (${EARLIER_OP}::uuid, ${WS}::uuid, 'earlier-op-0001', ${'a'.repeat(64)}, ${CONTRA}::uuid, ${ACCOUNT}::uuid, 500)`;
      await tx.$executeRaw`
        INSERT INTO "ledger_entry" ("workspace_id", "operation_id", "account_id", "amount_cents")
        VALUES (${WS}::uuid, ${EARLIER_OP}::uuid, ${CONTRA}::uuid, -500), (${WS}::uuid, ${EARLIER_OP}::uuid, ${ACCOUNT}::uuid, 500)`;
      await tx.$executeRaw`UPDATE "account" SET "balance_cents" = -500 WHERE "id" = ${CONTRA}::uuid`;
      await tx.$executeRaw`UPDATE "account" SET "balance_cents" = 500 WHERE "id" = ${ACCOUNT}::uuid`;
    });

    const last = '20261128000000_temporary_credential';
    for (const migration of AFTER) {
      if (migration === last) {
        await db.$executeRaw`INSERT INTO "user_identity" ("id", "status", "profile", "email") VALUES (${ACCOUNT}::uuid, 'ACTIVE', 'FACILITATOR', 'f@example.test')`;
        await db.$executeRaw`INSERT INTO "password_credential" ("identity_id", "hash") VALUES (${ACCOUNT}::uuid, ${`$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`})`;
        await db.$executeRaw`
          INSERT INTO "user_session" ("identity_id", "token_hash", "created_at", "last_activity_at", "idle_expires_at", "absolute_expires_at")
          VALUES (${ACCOUNT}::uuid, ${'a'.repeat(64)}, now(), now(), now() + interval '30 minutes', now() + interval '8 hours')`;
      }
      await prisma(upgradeUrl, 'db', 'execute', '--file', `prisma/migrations/${migration}/migration.sql`);
    }

    const rows = await db.$queryRaw<{ type: string; linked: boolean }[]>`
      SELECT "type"::text AS "type", "reverses_operation_id" IS NOT NULL AS "linked" FROM "payment_operation"`;
    expect(rows).toEqual([{ type: 'TRANSFER', linked: false }]);
    expect(await db.paymentOperation.findMany({ select: { modality: true } })).toEqual([{ modality: null }]);
    expect(await db.account.findMany({ select: { status: true } })).toEqual([{ status: 'ACTIVE' }, { status: 'ACTIVE' }]);
    expect(await db.workspace.findMany({ select: { status: true, modality: true } })).toEqual([{ status: 'ACTIVE', modality: 'ISOLATED' }]);

    // Dados anteriores intactos e senha e sessão anteriores válidas e nenhum vínculo criado pela migração.
    const before = await db.account.findMany({ select: { id: true, balanceCents: true }, orderBy: { balanceCents: 'asc' } });
    expect(before).toEqual([
      { id: CONTRA, balanceCents: -500n },
      { id: ACCOUNT, balanceCents: 500n },
    ]);
    const entries = await db.ledgerEntry.findMany({ select: { amountCents: true }, orderBy: { amountCents: 'asc' } });
    expect(entries.map((e) => e.amountCents)).toEqual([-500n, 500n]);
    expect(await db.userIdentity.count()).toBe(1);
    expect(await db.workspaceMembership.count()).toBe(0);
    expect(await db.passwordCredential.findMany()).toMatchObject([{ identityId: ACCOUNT, invalidatedAt: null }]);
    expect(await db.userSession.findMany()).toMatchObject([{ scope: 'NORMAL', revokedAt: null }]);
    expect(await db.auditRecord.count()).toBe(0);
    expect(await db.temporaryCredential.count()).toBe(0);
    expect(await db.educationalConfigRevision.count()).toBe(0);
    expect(await db.simulationClockRevision.count()).toBe(0);
    expect(await db.workspaceEnrollmentCode.count()).toBe(0);

    // Estorno e reconciliação pelo usuário de execução, com as concessões da migração nova.
    runtime = new PrismaService({ databaseUrl: appUpgradeUrl });
    await runtime.onModuleInit();
    const service = new PaymentExecutionService(new PrismaPaymentExecutionStore(runtime.client));
    const reversal = await service.reverse({ workspaceId: WS, operationKey: 'earlier-rev-0001', originalOperationId: EARLIER_OP });
    expect(reversal).toMatchObject({ type: 'REVERSAL', reversesOperationId: EARLIER_OP, amountCents: 500n, replayed: false });

    const report = await new ReconciliationService(new PrismaReconciliationReader(runtime.client)).reconcile(WS);
    expect(report).toMatchObject({ accountCount: 2, operationCount: 2, consistent: true });
    const balances = await db.account.findMany({ select: { balanceCents: true } });
    expect(balances.map((b) => b.balanceCents)).toEqual([0n, 0n]);

    // O banco atualizado corresponde ao schema atual.
    await expect(
      prisma(upgradeUrl, 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'),
    ).resolves.toBeUndefined();
  });

  it('identidade já cadastrada interrompe a migração de perfil sem alterar nada', async () => {
    await main.client.$executeRawUnsafe(`CREATE DATABASE "${BLOCKED_DB}"`);
    const url = new URL(mainUrl);
    url.pathname = `/${BLOCKED_DB}`;
    for (const migration of [...BEFORE, ...AFTER.slice(0, AFTER.indexOf('20261124000000_identity_profile'))]) {
      await prisma(url.toString(), 'db', 'execute', '--file', `prisma/migrations/${migration}/migration.sql`);
    }
    blocked = new PrismaService({ databaseUrl: url.toString() });
    await blocked.onModuleInit();
    const db = blocked.client;
    await db.$executeRaw`INSERT INTO "user_identity" ("id", "status") VALUES (${WS}::uuid, 'ACTIVE')`;

    const structure = () => db.$queryRaw<{ item: string }[]>`
      SELECT table_name || '.' || column_name AS "item" FROM information_schema.columns WHERE table_schema = 'public'
      UNION ALL SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      UNION ALL SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      ORDER BY 1`;
    const before = await structure();
    await expect(
      prisma(url.toString(), 'db', 'execute', '--file', 'prisma/migrations/20261124000000_identity_profile/migration.sql'),
    ).rejects.toThrow(/migração interrompida/);
    expect(await structure()).toEqual(before);
    const rows = await db.$queryRaw<{ id: string; status: string }[]>`SELECT "id"::text AS "id", "status"::text AS "status" FROM "user_identity"`;
    expect(rows).toEqual([{ id: WS, status: 'ACTIVE' }]);
  });
});
