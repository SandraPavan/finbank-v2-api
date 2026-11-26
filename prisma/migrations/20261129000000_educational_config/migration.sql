-- DEV-023: configuração educacional por workspace, em revisões só de inserção. Migração aditiva.

-- CreateEnum
CREATE TYPE "educational_mode" AS ENUM ('STUDENT', 'CONTROLLED');

-- CreateEnum
CREATE TYPE "educational_preset" AS ENUM ('NONE', 'ALL', 'LAB');

-- CreateTable
CREATE TABLE "educational_config_revision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "catalog_version" VARCHAR(12) NOT NULL,
    "mode" "educational_mode" NOT NULL,
    "preset" "educational_preset",
    "lab_code_hash" CHAR(64),
    "enabled_defect_ids" TEXT[],
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "educational_config_revision_pkey" PRIMARY KEY ("workspace_id", "revision")
);

-- CreateIndex
CREATE UNIQUE INDEX "educational_config_revision_id_key" ON "educational_config_revision"("id");

-- AddForeignKey
ALTER TABLE "educational_config_revision" ADD CONSTRAINT "educational_config_revision_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "educational_config_revision" ADD CONSTRAINT "educational_config_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restrições manuais. A revisão 0 é o padrão sem configuração e nunca é gravada.
ALTER TABLE "educational_config_revision" ADD CONSTRAINT "educational_config_revision_number"
  CHECK ("revision" > 0);
ALTER TABLE "educational_config_revision" ADD CONSTRAINT "educational_config_revision_catalog_version"
  CHECK (("catalog_version" COLLATE "C") ~ '^[0-9]{4}\.(0[1-9]|1[0-2])\.[1-9][0-9]{0,3}$');
-- STUDENT tem preset (e o hash só em LAB); CONTROLLED tem a lista de defeitos, opacos e sem nulos.
ALTER TABLE "educational_config_revision" ADD CONSTRAINT "educational_config_revision_shape"
  CHECK (
    ("mode" = 'STUDENT' AND "preset" IS NOT NULL AND "enabled_defect_ids" IS NULL
      AND ("preset" = 'LAB') = ("lab_code_hash" IS NOT NULL))
    OR ("mode" = 'CONTROLLED' AND "preset" IS NULL AND "lab_code_hash" IS NULL AND "enabled_defect_ids" IS NOT NULL)
  );
ALTER TABLE "educational_config_revision" ADD CONSTRAINT "educational_config_revision_values"
  CHECK (
    ("lab_code_hash" IS NULL OR ("lab_code_hash" COLLATE "C") ~ '^[0-9a-f]{64}$')
    AND ("enabled_defect_ids" IS NULL OR (
      array_position("enabled_defect_ids", NULL) IS NULL
      AND coalesce(array_ndims("enabled_defect_ids"), 1) = 1
      AND (array_to_string("enabled_defect_ids", ',') COLLATE "C") ~ '^(d-[0-9a-f]{16}(,d-[0-9a-f]{16})*)?$'))
  );

-- Revisões são históricas: nunca mudam nem somem, também para o dono.
CREATE FUNCTION "reject_educational_config_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'revisão de configuração educacional imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "educational_config_revision_immutable"
  BEFORE UPDATE OR DELETE ON "educational_config_revision"
  FOR EACH ROW EXECUTE FUNCTION "reject_educational_config_change"();

CREATE TRIGGER "educational_config_revision_no_truncate"
  BEFORE TRUNCATE ON "educational_config_revision"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_educational_config_change"();

-- Privilégios: a execução lê e insere, sem escolher identificador nem instante.
REVOKE ALL ON TABLE "educational_config_revision" FROM PUBLIC;
REVOKE ALL ON TABLE "educational_config_revision" FROM "finbank_runtime";
GRANT SELECT ON TABLE "educational_config_revision" TO "finbank_runtime";
GRANT INSERT ("workspace_id", "revision", "catalog_version", "mode", "preset", "lab_code_hash", "enabled_defect_ids", "created_by") ON TABLE "educational_config_revision" TO "finbank_runtime";
