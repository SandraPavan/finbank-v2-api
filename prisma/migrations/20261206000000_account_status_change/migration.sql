-- DEV-030: bloqueio e desbloqueio de conta pelo facilitador, com histórico só de inserção. Migração aditiva.

-- CreateTable
CREATE TABLE "account_status_change" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "from_status" "account_status" NOT NULL,
    "to_status" "account_status" NOT NULL,
    "justification" VARCHAR(400) NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "account_status_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_status_change_account_id_changed_at_idx" ON "account_status_change"("account_id", "changed_at");

-- AddForeignKey
ALTER TABLE "account_status_change" ADD CONSTRAINT "account_status_change_workspace_id_account_id_fkey" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "account"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_status_change" ADD CONSTRAINT "account_status_change_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Uma mudança de fato, com justificativa de 10 a 200 caracteres sem espaços nas pontas.
ALTER TABLE "account_status_change" ADD CONSTRAINT "account_status_change_shape"
  CHECK ("from_status" <> "to_status"
     AND char_length("justification") BETWEEN 10 AND 200
     AND "justification" = btrim("justification"));

-- Histórico: nunca muda nem some, também para o dono.
CREATE FUNCTION "reject_account_status_change_edit"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'histórico de estado da conta imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "account_status_change_immutable"
  BEFORE UPDATE OR DELETE ON "account_status_change"
  FOR EACH ROW EXECUTE FUNCTION "reject_account_status_change_edit"();

CREATE TRIGGER "account_status_change_no_truncate"
  BEFORE TRUNCATE ON "account_status_change"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_account_status_change_edit"();

-- Privilégios: a execução muda só o estado da conta (pelo adaptador do PaymentExecution) e registra o histórico.
GRANT UPDATE ("status") ON TABLE "account" TO "finbank_runtime";
REVOKE ALL ON TABLE "account_status_change" FROM PUBLIC;
REVOKE ALL ON TABLE "account_status_change" FROM "finbank_runtime";
GRANT SELECT ON TABLE "account_status_change" TO "finbank_runtime";
GRANT INSERT ("workspace_id", "account_id", "from_status", "to_status", "justification", "changed_by") ON TABLE "account_status_change" TO "finbank_runtime";
