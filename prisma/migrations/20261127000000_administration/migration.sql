-- DEV-019: auditoria administrativa e estado de identidades. Migração aditiva, sem alteração de dados.

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('OPERATOR', 'IDENTITY');

-- CreateEnum
CREATE TYPE "audit_result" AS ENUM ('CHANGED', 'UNCHANGED');

-- CreateTable
CREATE TABLE "audit_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_identity_id" UUID,
    "actor_profile" "membership_role",
    "workspace_id" UUID,
    "operation" VARCHAR(40) NOT NULL,
    "resource_type" VARCHAR(40) NOT NULL,
    "resource_id" UUID NOT NULL,
    "result" "audit_result" NOT NULL,
    "correlation_id" VARCHAR(64) NOT NULL,

    CONSTRAINT "audit_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_record_workspace_id_occurred_at_idx" ON "audit_record"("workspace_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_actor_identity_id_actor_profile_fkey" FOREIGN KEY ("actor_identity_id", "actor_profile") REFERENCES "user_identity"("id", "profile") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restrições manuais. Códigos fixos, sem texto livre; o operador não tem identidade.
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_actor"
  CHECK (("actor_type" = 'IDENTITY') = ("actor_identity_id" IS NOT NULL)
     AND ("actor_type" = 'IDENTITY') = ("actor_profile" IS NOT NULL));
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_codes"
  CHECK (("operation" COLLATE "C") ~ '^[A-Z_]{3,40}$' AND ("resource_type" COLLATE "C") ~ '^[A-Z_]{3,40}$');
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_correlation_format"
  CHECK (("correlation_id" COLLATE "C") ~ '^[A-Za-z0-9._-]{8,64}$');

-- Somente inserção, também para o dono.
CREATE FUNCTION "reject_audit_record_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registro de auditoria imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_record_immutable"
  BEFORE UPDATE OR DELETE ON "audit_record"
  FOR EACH ROW EXECUTE FUNCTION "reject_audit_record_change"();

CREATE TRIGGER "audit_record_no_truncate"
  BEFORE TRUNCATE ON "audit_record"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_audit_record_change"();

-- O estado de um facilitador só muda pelo dono do esquema (operador).
CREATE FUNCTION "restrict_facilitator_status_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> (SELECT pg_get_userbyid("relowner") FROM pg_class WHERE "oid" = TG_RELID) THEN
    RAISE EXCEPTION 'estado de facilitador só muda pelo operador' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_identity_facilitator_status"
  BEFORE UPDATE ON "user_identity"
  FOR EACH ROW WHEN (OLD."profile" = 'FACILITATOR' AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "restrict_facilitator_status_change"();

-- Privilégios: a execução muda só o estado e registra auditoria, sem lê-la nem escolher identificador ou instante.
REVOKE ALL ON TABLE "audit_record" FROM PUBLIC;
REVOKE ALL ON TABLE "audit_record" FROM "finbank_runtime";
GRANT INSERT ("actor_type", "actor_identity_id", "actor_profile", "workspace_id", "operation", "resource_type", "resource_id", "result", "correlation_id") ON TABLE "audit_record" TO "finbank_runtime";
GRANT UPDATE ("status") ON TABLE "user_identity" TO "finbank_runtime";
