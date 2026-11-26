-- DEV-025: relógio simulado por workspace, em revisões só de inserção. Migração aditiva.

-- CreateTable
CREATE TABLE "simulation_clock_revision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "business_date" DATE NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "simulation_clock_revision_pkey" PRIMARY KEY ("workspace_id", "revision")
);

-- CreateIndex
CREATE UNIQUE INDEX "simulation_clock_revision_id_key" ON "simulation_clock_revision"("id");

-- AddForeignKey
ALTER TABLE "simulation_clock_revision" ADD CONSTRAINT "simulation_clock_revision_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "simulation_clock_revision" ADD CONSTRAINT "simulation_clock_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restrições manuais. A revisão 0 é a data de criação do workspace e nunca é gravada.
ALTER TABLE "simulation_clock_revision" ADD CONSTRAINT "simulation_clock_revision_number"
  CHECK ("revision" > 0);
ALTER TABLE "simulation_clock_revision" ADD CONSTRAINT "simulation_clock_revision_date_range"
  CHECK ("business_date" BETWEEN DATE '2000-01-01' AND DATE '2099-12-31');

-- Revisões são históricas: nunca mudam nem somem, também para o dono.
CREATE FUNCTION "reject_simulation_clock_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'revisão do relógio simulado imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "simulation_clock_revision_immutable"
  BEFORE UPDATE OR DELETE ON "simulation_clock_revision"
  FOR EACH ROW EXECUTE FUNCTION "reject_simulation_clock_change"();

CREATE TRIGGER "simulation_clock_revision_no_truncate"
  BEFORE TRUNCATE ON "simulation_clock_revision"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_simulation_clock_change"();

-- Privilégios: a execução lê e insere, sem escolher identificador nem instante.
REVOKE ALL ON TABLE "simulation_clock_revision" FROM PUBLIC;
REVOKE ALL ON TABLE "simulation_clock_revision" FROM "finbank_runtime";
GRANT SELECT ON TABLE "simulation_clock_revision" TO "finbank_runtime";
GRANT INSERT ("workspace_id", "revision", "business_date", "created_by") ON TABLE "simulation_clock_revision" TO "finbank_runtime";
