-- DEV-028: aprovação automática do onboarding com cliente, credencial, conta e vínculo. Migração aditiva.

-- Ator técnico sem login nem sessão (ADR 010). O valor novo não é usado neste script.
ALTER TYPE "audit_actor_type" ADD VALUE 'SYSTEM';

-- A solicitação aprovada aponta o cliente criado; a decisão tem instante real.
ALTER TABLE "onboarding_request" ADD COLUMN "identity_id" UUID, ADD COLUMN "decided_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "onboarding_request_identity_id_key" ON "onboarding_request"("identity_id");
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_decision"
  CHECK ((("status" = 'APPROVED') = ("identity_id" IS NOT NULL)) AND (("status" = 'PENDING') = ("decided_at" IS NULL)));

-- Par (identidade, workspace) referenciável: o vínculo exige cliente e conta do mesmo workspace.
CREATE UNIQUE INDEX "user_identity_id_workspace_id_key" ON "user_identity"("id", "workspace_id");

-- CreateTable
CREATE TABLE "customer_account" (
    "identity_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "customer_account_pkey" PRIMARY KEY ("identity_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_account_account_id_key" ON "customer_account"("account_id");

-- AddForeignKey
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_identity_id_workspace_id_fkey" FOREIGN KEY ("identity_id", "workspace_id") REFERENCES "user_identity"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_workspace_id_account_id_fkey" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "account"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Só conta comum de cliente; o vínculo nunca muda nem some, também para o dono.
CREATE FUNCTION "check_customer_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "account" WHERE "id" = NEW."account_id" AND "kind" = 'STANDARD')
     OR NOT EXISTS (SELECT 1 FROM "user_identity" WHERE "id" = NEW."identity_id" AND "profile" = 'CUSTOMER') THEN
    RAISE EXCEPTION 'vínculo só entre cliente e conta comum' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "customer_account_kinds"
  BEFORE INSERT ON "customer_account"
  FOR EACH ROW EXECUTE FUNCTION "check_customer_account"();

CREATE FUNCTION "reject_customer_account_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vínculo de conta imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "customer_account_immutable"
  BEFORE UPDATE OR DELETE ON "customer_account"
  FOR EACH ROW EXECUTE FUNCTION "reject_customer_account_change"();

CREATE TRIGGER "customer_account_no_truncate"
  BEFORE TRUNCATE ON "customer_account"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_customer_account_change"();

-- Fora do dono do esquema (operador), só se cria cliente ativo com workspace.
CREATE FUNCTION "restrict_identity_creation"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> (SELECT pg_get_userbyid("relowner") FROM pg_class WHERE "oid" = TG_RELID)
     AND (NEW."profile" <> 'CUSTOMER' OR NEW."status" <> 'ACTIVE' OR NEW."workspace_id" IS NULL) THEN
    RAISE EXCEPTION 'só o operador cria identidade que não seja cliente ativo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_identity_creation"
  BEFORE INSERT ON "user_identity"
  FOR EACH ROW EXECUTE FUNCTION "restrict_identity_creation"();

-- Fora do dono do esquema, só se cria senha de cliente existente.
CREATE FUNCTION "restrict_credential_creation"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> (SELECT pg_get_userbyid("relowner") FROM pg_class WHERE "oid" = TG_RELID)
     AND NOT EXISTS (SELECT 1 FROM "user_identity" WHERE "id" = NEW."identity_id" AND "profile" = 'CUSTOMER') THEN
    RAISE EXCEPTION 'só o operador cria senha que não seja de cliente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "password_credential_creation"
  BEFORE INSERT ON "password_credential"
  FOR EACH ROW EXECUTE FUNCTION "restrict_credential_creation"();

-- Privilégios: a execução cria cliente, senha e vínculo na aprovação; nada de identificador ou instante escolhidos.
GRANT INSERT ("status", "profile", "email", "workspace_id") ON TABLE "user_identity" TO "finbank_runtime";
GRANT INSERT ("identity_id", "hash") ON TABLE "password_credential" TO "finbank_runtime";
GRANT INSERT ("identity_id", "decided_at") ON TABLE "onboarding_request" TO "finbank_runtime";
REVOKE ALL ON TABLE "customer_account" FROM PUBLIC;
REVOKE ALL ON TABLE "customer_account" FROM "finbank_runtime";
GRANT SELECT ON TABLE "customer_account" TO "finbank_runtime";
GRANT INSERT ("identity_id", "workspace_id", "account_id") ON TABLE "customer_account" TO "finbank_runtime";
