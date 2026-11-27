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

  it('o schema declara somente os modelos do núcleo financeiro, de identidade e de autenticação', () => {
    const schema = readFileSync(resolve('prisma/schema.prisma'), 'utf8');
    const declared = [...schema.matchAll(/^\s*(model|enum|view)\s+(\w+)/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(declared.sort()).toEqual(
      [
        'enum AccountKind',
        'enum AccountStatus',
        'enum AuditActorType',
        'enum AuditResult',
        'enum EducationalMode',
        'enum EducationalPreset',
        'enum IdentityStatus',
        'enum MembershipRole',
        'enum MembershipStatus',
        'enum OnboardingStatus',
        'enum OperationType',
        'enum PaymentModality',
        'enum SessionScope',
        'enum WorkspaceModality',
        'enum WorkspaceStatus',
        'model Account',
        'model AuditRecord',
        'model AuthenticationControl',
        'model EducationalConfigRevision',
        'model LedgerEntry',
        'model OnboardingRequest',
        'model PasswordCredential',
        'model PaymentOperation',
        'model SimulationClockRevision',
        'model TemporaryCredential',
        'model UserIdentity',
        'model UserSession',
        'model Workspace',
        'model WorkspaceEnrollmentCode',
        'model WorkspaceMembership',
      ].sort(),
    );
  });

  it('migrate deploy (global setup) aplicou as migrações versionadas em ordem', async () => {
    const rows = await db.client.$queryRaw<{ migration_name: string; finished: boolean }[]>`
      SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name`;
    expect(rows).toEqual([
      { migration_name: '00000000000000_baseline', finished: true },
      { migration_name: '20261119000000_payment_execution_core', finished: true },
      { migration_name: '20261120000000_payment_reversal_reconciliation', finished: true },
      { migration_name: '20261121000000_runtime_role_privileges', finished: true },
      { migration_name: '20261123000000_identity_membership', finished: true },
      { migration_name: '20261124000000_identity_profile', finished: true },
      { migration_name: '20261125000000_password_session', finished: true },
      { migration_name: '20261126000000_authentication_control', finished: true },
      { migration_name: '20261127000000_administration', finished: true },
      { migration_name: '20261128000000_temporary_credential', finished: true },
      { migration_name: '20261129000000_educational_config', finished: true },
      { migration_name: '20261130000000_payment_states_credit', finished: true },
      { migration_name: '20261201000000_simulation_clock', finished: true },
      { migration_name: '20261202000000_workspace_modality_enrollment', finished: true },
      { migration_name: '20261203000000_onboarding_request', finished: true },
    ]);
  });

  it('migrate deploy é idempotente', async () => {
    const again = await prisma('migrate', 'deploy');
    expect(again.code, again.output).toBe(0);
    const rows = await db.client.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM _prisma_migrations`;
    expect(rows[0]?.total).toBe(15);
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

  it('as tabelas criadas são o controle do Prisma e as do núcleo financeiro, de identidade e de autenticação', async () => {
    const tables = await db.client.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      '_prisma_migrations',
      'account',
      'audit_record',
      'authentication_control',
      'educational_config_revision',
      'ledger_entry',
      'onboarding_request',
      'password_credential',
      'payment_operation',
      'simulation_clock_revision',
      'temporary_credential',
      'user_identity',
      'user_session',
      'workspace',
      'workspace_enrollment_code',
      'workspace_membership',
    ]);
  });

  // `migrate diff` não compara CHECKs, índices parciais nem triggers: verificados no catálogo.
  it('as restrições manuais da migração existem no banco', async () => {
    const checks = await db.client.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace ORDER BY conname`;
    expect(checks.map((c) => c.conname)).toEqual([
      'account_contra_active',
      'account_standard_non_negative',
      'audit_record_actor',
      'audit_record_codes',
      'audit_record_correlation_format',
      'authentication_control_failures_positive',
      'authentication_control_subject_format',
      'educational_config_revision_catalog_version',
      'educational_config_revision_number',
      'educational_config_revision_shape',
      'educational_config_revision_values',
      'ledger_entry_amount_nonzero',
      'onboarding_request_cpf_format',
      'onboarding_request_dates',
      'onboarding_request_email_normalized',
      'onboarding_request_name_length',
      'onboarding_request_password_hash_format',
      'onboarding_request_phone_format',
      'password_credential_hash_format',
      'payment_operation_amount_positive',
      'payment_operation_distinct_accounts',
      'payment_operation_fingerprint_format',
      'payment_operation_key_format',
      'payment_operation_modality_transfer',
      'payment_operation_reversal_link',
      'simulation_clock_revision_date_range',
      'simulation_clock_revision_number',
      'temporary_credential_expiry',
      'temporary_credential_hash_format',
      'temporary_credential_single_end',
      'user_identity_email_normalized',
      'user_identity_profile_workspace',
      'user_session_expiry_order',
      'user_session_token_hash_format',
      'workspace_alias_format',
      'workspace_enrollment_code_hash_format',
      'workspace_enrollment_code_number',
      'workspace_membership_facilitator_only',
    ]);

    const triggers = await db.client.$queryRaw<{ tgname: string; deferred: boolean }[]>`
      SELECT tgname, tginitdeferred AS deferred FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`;
    expect(triggers).toEqual([
      { tgname: 'account_identity_immutable', deferred: false },
      { tgname: 'audit_record_immutable', deferred: false },
      { tgname: 'audit_record_no_truncate', deferred: false },
      { tgname: 'educational_config_revision_immutable', deferred: false },
      { tgname: 'educational_config_revision_no_truncate', deferred: false },
      { tgname: 'ledger_entry_active_states', deferred: false },
      { tgname: 'ledger_entry_balanced', deferred: true },
      { tgname: 'ledger_entry_immutable', deferred: false },
      { tgname: 'ledger_entry_no_truncate', deferred: false },
      { tgname: 'payment_operation_balanced', deferred: true },
      { tgname: 'payment_operation_credit_direction', deferred: false },
      { tgname: 'payment_operation_immutable', deferred: false },
      { tgname: 'payment_operation_no_truncate', deferred: false },
      { tgname: 'payment_operation_reversal_matches', deferred: false },
      { tgname: 'simulation_clock_revision_immutable', deferred: false },
      { tgname: 'simulation_clock_revision_no_truncate', deferred: false },
      { tgname: 'temporary_credential_facilitator', deferred: false },
      { tgname: 'temporary_credential_terminal', deferred: false },
      { tgname: 'user_identity_disable_revokes_sessions', deferred: false },
      { tgname: 'user_identity_facilitator_status', deferred: false },
      { tgname: 'user_identity_immutable', deferred: false },
      { tgname: 'user_session_terminal', deferred: false },
      { tgname: 'workspace_enrollment_code_immutable', deferred: false },
      { tgname: 'workspace_enrollment_code_no_truncate', deferred: false },
      { tgname: 'workspace_id_immutable', deferred: false },
      { tgname: 'workspace_modality_immutable', deferred: false },
    ]);

    const partial = await db.client.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'account_one_contra_per_workspace'`;
    expect(partial[0]?.indexdef).toMatch(/UNIQUE INDEX .*\(workspace_id\) WHERE \(kind = 'CONTRA'/);

    const emails = await db.client.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE indexname IN ('user_identity_customer_email', 'user_identity_facilitator_email') ORDER BY indexname`;
    expect(emails[0]?.indexdef).toMatch(/UNIQUE INDEX .*\(workspace_id, email\) WHERE \(profile = 'CUSTOMER'/);
    expect(emails[1]?.indexdef).toMatch(/UNIQUE INDEX .*\(email\) WHERE \(profile = 'FACILITATOR'/);

    const onboarding = await db.client.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE indexname IN ('onboarding_request_workspace_cpf', 'onboarding_request_workspace_email') ORDER BY indexname`;
    expect(onboarding[0]?.indexdef).toMatch(/UNIQUE INDEX .*\(workspace_id, cpf\) WHERE \(status <> 'REJECTED'/);
    expect(onboarding[1]?.indexdef).toMatch(/UNIQUE INDEX .*\(workspace_id, email\) WHERE \(status <> 'REJECTED'/);

    const reversalLink = await db.client.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'payment_operation_workspace_id_reverses_operation_id_key'`;
    expect(reversalLink[0]?.indexdef).toMatch(/UNIQUE INDEX .*\(workspace_id, reverses_operation_id\)/);
  });
});
