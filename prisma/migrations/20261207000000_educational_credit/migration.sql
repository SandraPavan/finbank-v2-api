-- DEV-031: registro do crédito educacional por HTTP (justificativa, autor e chave). Migração aditiva.

-- CreateTable
CREATE TABLE "educational_credit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "justification" VARCHAR(400) NOT NULL,
    "created_by" UUID NOT NULL,
    "operation_key" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "educational_credit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "educational_credit_operation_id_key" ON "educational_credit"("operation_id");

-- CreateIndex
CREATE INDEX "educational_credit_account_id_created_at_idx" ON "educational_credit"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "educational_credit" ADD CONSTRAINT "educational_credit_workspace_id_operation_id_fkey" FOREIGN KEY ("workspace_id", "operation_id") REFERENCES "payment_operation"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "educational_credit" ADD CONSTRAINT "educational_credit_workspace_id_account_id_fkey" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "account"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "educational_credit" ADD CONSTRAINT "educational_credit_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Valor positivo, chave derivada (SHA-256) e justificativa de 10 a 200 caracteres sem espaços nas pontas.
ALTER TABLE "educational_credit" ADD CONSTRAINT "educational_credit_shape"
  CHECK ("amount_cents" > 0
     AND ("operation_key" COLLATE "C") ~ '^[0-9a-f]{64}$'
     AND char_length("justification") BETWEEN 10 AND 200
     AND "justification" = btrim("justification"));

-- O registro acompanha uma operação de crédito educacional para a mesma conta e o mesmo valor.
CREATE FUNCTION "check_educational_credit_operation"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "payment_operation"
     WHERE "id" = NEW."operation_id" AND "workspace_id" = NEW."workspace_id" AND "type" = 'EDUCATIONAL_CREDIT'
       AND "credit_account_id" = NEW."account_id" AND "amount_cents" = NEW."amount_cents" AND "operation_key" = NEW."operation_key"
  ) THEN
    RAISE EXCEPTION 'registro de crédito sem a operação correspondente' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "educational_credit_matches_operation"
  BEFORE INSERT ON "educational_credit"
  FOR EACH ROW EXECUTE FUNCTION "check_educational_credit_operation"();

-- Registro imutável, também para o dono.
CREATE FUNCTION "reject_educational_credit_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registro de crédito educacional imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "educational_credit_immutable"
  BEFORE UPDATE OR DELETE ON "educational_credit"
  FOR EACH ROW EXECUTE FUNCTION "reject_educational_credit_change"();

CREATE TRIGGER "educational_credit_no_truncate"
  BEFORE TRUNCATE ON "educational_credit"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_educational_credit_change"();

-- Privilégios: a execução lê e insere, sem escolher identificador nem instante.
REVOKE ALL ON TABLE "educational_credit" FROM PUBLIC;
REVOKE ALL ON TABLE "educational_credit" FROM "finbank_runtime";
GRANT SELECT ON TABLE "educational_credit" TO "finbank_runtime";
GRANT INSERT ("workspace_id", "operation_id", "account_id", "amount_cents", "justification", "created_by", "operation_key")
  ON TABLE "educational_credit" TO "finbank_runtime";
