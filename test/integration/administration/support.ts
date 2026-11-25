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
