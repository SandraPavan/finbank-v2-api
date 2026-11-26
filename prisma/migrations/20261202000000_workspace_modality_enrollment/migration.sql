-- DEV-026: modalidade do workspace e código de inscrição em revisões só de inserção. Migração aditiva.

-- CreateEnum
CREATE TYPE "workspace_modality" AS ENUM ('SHARED', 'ISOLATED');

-- AlterTable: os workspaces existentes ficam ISOLATED, como os criados pelo bootstrap.
ALTER TABLE "workspace" ADD COLUMN "modality" "workspace_modality" NOT NULL DEFAULT 'ISOLATED';

-- CreateTable
CREATE TABLE "workspace_enrollment_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "code_hash" CHAR(64),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "workspace_enrollment_code_pkey" PRIMARY KEY ("workspace_id", "revision")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_enrollment_code_id_key" ON "workspace_enrollment_code"("id");

-- AddForeignKey
ALTER TABLE "workspace_enrollment_code" ADD CONSTRAINT "workspace_enrollment_code_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workspace_enrollment_code" ADD CONSTRAINT "workspace_enrollment_code_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restrições manuais. Sem hash, a revisão revoga o código anterior; o código em claro nunca é gravado.
ALTER TABLE "workspace_enrollment_code" ADD CONSTRAINT "workspace_enrollment_code_number"
  CHECK ("revision" > 0);
ALTER TABLE "workspace_enrollment_code" ADD CONSTRAINT "workspace_enrollment_code_hash_format"
  CHECK ("code_hash" IS NULL OR ("code_hash" COLLATE "C") ~ '^[0-9a-f]{64}$');

-- A modalidade é fixa na criação, também para o dono.
CREATE FUNCTION "reject_workspace_modality_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."modality" IS DISTINCT FROM OLD."modality" THEN
    RAISE EXCEPTION 'modalidade do workspace imutável' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workspace_modality_immutable"
  BEFORE UPDATE ON "workspace"
  FOR EACH ROW EXECUTE FUNCTION "reject_workspace_modality_change"();

-- Revisões do código são históricas: nunca mudam nem somem, também para o dono.
CREATE FUNCTION "reject_enrollment_code_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'revisão do código de inscrição imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "workspace_enrollment_code_immutable"
  BEFORE UPDATE OR DELETE ON "workspace_enrollment_code"
  FOR EACH ROW EXECUTE FUNCTION "reject_enrollment_code_change"();

CREATE TRIGGER "workspace_enrollment_code_no_truncate"
  BEFORE TRUNCATE ON "workspace_enrollment_code"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_enrollment_code_change"();

-- Privilégios: a execução lê e insere, sem escolher identificador nem instante. Workspace continua só leitura.
REVOKE ALL ON TABLE "workspace_enrollment_code" FROM PUBLIC;
REVOKE ALL ON TABLE "workspace_enrollment_code" FROM "finbank_runtime";
GRANT SELECT ON TABLE "workspace_enrollment_code" TO "finbank_runtime";
GRANT INSERT ("workspace_id", "revision", "code_hash", "created_by") ON TABLE "workspace_enrollment_code" TO "finbank_runtime";
