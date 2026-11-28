-- DEV-029: política de aprovação do onboarding em revisões, credencial de consulta e decisão do facilitador. Migração aditiva.

-- CreateEnum
CREATE TYPE "onboarding_approval_mode" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateTable
CREATE TABLE "onboarding_policy_revision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "mode" "onboarding_approval_mode" NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "onboarding_policy_revision_pkey" PRIMARY KEY ("workspace_id", "revision")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_policy_revision_id_key" ON "onboarding_policy_revision"("id");

-- AddForeignKey
ALTER TABLE "onboarding_policy_revision" ADD CONSTRAINT "onboarding_policy_revision_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "onboarding_policy_revision" ADD CONSTRAINT "onboarding_policy_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A revisão 0 é AUTOMATIC e nunca é gravada.
ALTER TABLE "onboarding_policy_revision" ADD CONSTRAINT "onboarding_policy_revision_number" CHECK ("revision" > 0);

CREATE FUNCTION "reject_onboarding_policy_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'revisão da política de aprovação imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "onboarding_policy_revision_immutable"
  BEFORE UPDATE OR DELETE ON "onboarding_policy_revision"
  FOR EACH ROW EXECUTE FUNCTION "reject_onboarding_policy_change"();

CREATE TRIGGER "onboarding_policy_revision_no_truncate"
  BEFORE TRUNCATE ON "onboarding_policy_revision"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_onboarding_policy_change"();

-- A solicitação guarda a revisão da política usada e, quando fica PENDING, a credencial de consulta (só o hash).
ALTER TABLE "onboarding_request"
  ADD COLUMN "policy_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "status_credential_hash" CHAR(64),
  ADD COLUMN "status_credential_expires_at" TIMESTAMPTZ(3);
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_status_credential"
  CHECK ("policy_revision" >= 0
     AND ("status_credential_hash" IS NULL) = ("status_credential_expires_at" IS NULL)
     AND ("status_credential_hash" IS NULL OR ("status_credential_hash" COLLATE "C") ~ '^[0-9a-f]{64}$'));

-- Decisão única: só PENDING → APPROVED ou REJECTED, e nada além do estado, do cliente e do instante muda. Vale também para o dono.
CREATE FUNCTION "restrict_onboarding_decision"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
     OR (NEW."id", NEW."workspace_id", NEW."name", NEW."cpf", NEW."birth_date", NEW."email", NEW."phone", NEW."password_hash",
         NEW."business_date", NEW."clock_revision", NEW."created_at", NEW."policy_revision", NEW."status_credential_hash",
         NEW."status_credential_expires_at")
        IS DISTINCT FROM
        (OLD."id", OLD."workspace_id", OLD."name", OLD."cpf", OLD."birth_date", OLD."email", OLD."phone", OLD."password_hash",
         OLD."business_date", OLD."clock_revision", OLD."created_at", OLD."policy_revision", OLD."status_credential_hash",
         OLD."status_credential_expires_at") THEN
    RAISE EXCEPTION 'solicitação só é decidida uma vez, sem alterar os dados' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "onboarding_request_decision_once"
  BEFORE UPDATE ON "onboarding_request"
  FOR EACH ROW EXECUTE FUNCTION "restrict_onboarding_decision"();

CREATE FUNCTION "reject_onboarding_request_removal"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solicitação de abertura não é apagada' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "onboarding_request_no_delete"
  BEFORE DELETE ON "onboarding_request"
  FOR EACH ROW EXECUTE FUNCTION "reject_onboarding_request_removal"();

CREATE TRIGGER "onboarding_request_no_truncate"
  BEFORE TRUNCATE ON "onboarding_request"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_onboarding_request_removal"();

-- Privilégios: política lida e inserida; solicitação decidida só pelo estado, cliente e instante.
REVOKE ALL ON TABLE "onboarding_policy_revision" FROM PUBLIC;
REVOKE ALL ON TABLE "onboarding_policy_revision" FROM "finbank_runtime";
GRANT SELECT ON TABLE "onboarding_policy_revision" TO "finbank_runtime";
GRANT INSERT ("workspace_id", "revision", "mode", "created_by") ON TABLE "onboarding_policy_revision" TO "finbank_runtime";
GRANT INSERT ("policy_revision", "status_credential_hash", "status_credential_expires_at") ON TABLE "onboarding_request" TO "finbank_runtime";
GRANT UPDATE ("status", "identity_id", "decided_at") ON TABLE "onboarding_request" TO "finbank_runtime";
