// Migração da DEV-011 aplicada sobre um banco que já tem dados do núcleo anterior.
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
const BEFORE = ['00000000000000_baseline', '20261119000000_payment_execution_core'];
const NEXT = '20261120000000_payment_reversal_reconciliation';

const WS = '11111111-1111-4111-8111-111111111111';
const CONTRA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EARLIER_OP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function prisma(databaseUrl: string, ...args: string[]): Promise<void> {
  await run(prismaBin, args, { env: { ...process.env, DATABASE_URL: databaseUrl } });
}

describe('migração aditiva sobre dados existentes', () => {
  const mainUrl = inject('databaseUrl');
  const upgradeUrl = (() => {
    const url = new URL(mainUrl);
    url.pathname = `/${UPGRADE_DB}`;
    return url.toString();
  })();
  let main: PrismaService;
  let upgraded: PrismaService | undefined;

  beforeAll(async () => {
    main = new PrismaService({ databaseUrl: mainUrl });
    await main.onModuleInit();
    await main.client.$executeRawUnsafe(`CREATE DATABASE "${UPGRADE_DB}"`);
  });

  afterAll(async () => {
    await upgraded?.onModuleDestroy();
    await main?.client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${UPGRADE_DB}" WITH (FORCE)`);
    await main?.onModuleDestroy();
  });

  it('preserva operações anteriores como TRANSFER e permite estorná-las', async () => {
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

    await prisma(upgradeUrl, 'db', 'execute', '--file', `prisma/migrations/${NEXT}/migration.sql`);

    const rows = await db.$queryRaw<{ type: string; linked: boolean }[]>`
      SELECT "type"::text AS "type", "reverses_operation_id" IS NOT NULL AS "linked" FROM "payment_operation"`;
    expect(rows).toEqual([{ type: 'TRANSFER', linked: false }]);

    const service = new PaymentExecutionService(new PrismaPaymentExecutionStore(db));
    const reversal = await service.reverse({ workspaceId: WS, operationKey: 'earlier-rev-0001', originalOperationId: EARLIER_OP });
    expect(reversal).toMatchObject({ type: 'REVERSAL', reversesOperationId: EARLIER_OP, amountCents: 500n, replayed: false });

    const report = await new ReconciliationService(new PrismaReconciliationReader(db)).reconcile(WS);
    expect(report).toMatchObject({ accountCount: 2, operationCount: 2, consistent: true });
    const balances = await db.account.findMany({ select: { balanceCents: true } });
    expect(balances.map((b) => b.balanceCents)).toEqual([0n, 0n]);

    // O banco atualizado corresponde ao schema atual.
    await expect(
      prisma(upgradeUrl, 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'),
    ).resolves.toBeUndefined();
  });
});
