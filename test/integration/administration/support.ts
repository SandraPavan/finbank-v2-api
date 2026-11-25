import type { AuthHarness } from '../authentication/support.js';

/** Trigger do dono que faz a auditoria de uma operação falhar, só durante o trabalho. */
export async function withAuditFailure(h: AuthHarness, operation: string, work: () => Promise<void>): Promise<void> {
  await h.db.client.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION "test_audit_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."operation" = '${operation}' THEN RAISE EXCEPTION 'falha injetada'; END IF; RETURN NEW; END $$`);
  await h.db.client.$executeRawUnsafe(
    'CREATE TRIGGER "test_audit_failure" BEFORE INSERT ON "audit_record" FOR EACH ROW EXECUTE FUNCTION "test_audit_failure"()',
  );
  try {
    await work();
  } finally {
    await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_audit_failure"() CASCADE');
  }
}

/** Trigger adiado que faz falhar, só no commit, qualquer transação que mexa na tabela. */
export async function withCommitFailure(h: AuthHarness, table: 'user_session' | 'temporary_credential' | 'user_identity', work: () => Promise<void>): Promise<void> {
  await h.db.client.$executeRawUnsafe(
    `CREATE FUNCTION "test_commit_failure"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha no commit'; END $$`,
  );
  await h.db.client.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER "test_commit_failure" AFTER INSERT OR UPDATE ON "${table}"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "test_commit_failure"()`);
  try {
    await work();
  } finally {
    await h.db.client.$executeRawUnsafe('DROP FUNCTION "test_commit_failure"() CASCADE');
  }
}
