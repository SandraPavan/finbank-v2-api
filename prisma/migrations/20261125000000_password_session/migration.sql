-- DEV-016: credencial permanente e sessões. Migração aditiva, sem alteração de dados.

-- CreateTable
CREATE TABLE "password_credential" (
    "identity_id" UUID NOT NULL,
    "hash" VARCHAR(160) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_credential_pkey" PRIMARY KEY ("identity_id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_session_token_hash_key" ON "user_session"("token_hash");

-- CreateIndex
CREATE INDEX "user_session_identity_id_idx" ON "user_session"("identity_id");

-- AddForeignKey
ALTER TABLE "password_credential" ADD CONSTRAINT "password_credential_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restrições manuais. Somente Argon2id em formato PHC; somente SHA-256 do segredo da sessão.
ALTER TABLE "password_credential" ADD CONSTRAINT "password_credential_hash_format"
  CHECK (("hash" COLLATE "C") ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$');

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_token_hash_format"
  CHECK (("token_hash" COLLATE "C") ~ '^[0-9a-f]{64}$');

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_expiry_order"
  CHECK ("created_at" <= "last_activity_at" AND "created_at" <= "idle_expires_at" AND "idle_expires_at" <= "absolute_expires_at");

-- Sessão encerrada não muda mais; expirada não é renovada; os dados de origem são imutáveis.
-- Encerrar uma sessão já expirada é permitido (não a reativa).
CREATE FUNCTION "reject_user_session_revival"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."revoked_at" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."identity_id" IS DISTINCT FROM OLD."identity_id"
     OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."absolute_expires_at" IS DISTINCT FROM OLD."absolute_expires_at"
     OR ((NEW."idle_expires_at" IS DISTINCT FROM OLD."idle_expires_at"
          OR NEW."last_activity_at" IS DISTINCT FROM OLD."last_activity_at")
         AND (OLD."idle_expires_at" <= clock_timestamp() OR OLD."absolute_expires_at" <= clock_timestamp())) THEN
    RAISE EXCEPTION 'sessão encerrada ou expirada não pode ser reativada' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_session_terminal"
  BEFORE UPDATE ON "user_session"
  FOR EACH ROW EXECUTE FUNCTION "reject_user_session_revival"();

-- Desativar a identidade encerra as sessões. A trava na credencial serializa com o login.
CREATE FUNCTION "revoke_sessions_of_disabled_identity"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "password_credential" WHERE "identity_id" = NEW."id" FOR UPDATE;
  UPDATE "user_session" SET "revoked_at" = clock_timestamp()
   WHERE "identity_id" = NEW."id" AND "revoked_at" IS NULL
     AND "idle_expires_at" > clock_timestamp() AND "absolute_expires_at" > clock_timestamp();
  RETURN NULL;
END;
$$;

CREATE TRIGGER "user_identity_disable_revokes_sessions"
  AFTER UPDATE ON "user_identity"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" = 'DISABLED')
  EXECUTE FUNCTION "revoke_sessions_of_disabled_identity"();

-- Privilégios: a execução não cria credencial; na sessão, só altera atividade, prazo e encerramento.
REVOKE ALL ON TABLE "password_credential", "user_session" FROM PUBLIC;
REVOKE ALL ON TABLE "password_credential", "user_session" FROM "finbank_runtime";
GRANT SELECT ON TABLE "password_credential" TO "finbank_runtime";
GRANT UPDATE ("hash", "updated_at") ON TABLE "password_credential" TO "finbank_runtime";
GRANT SELECT, INSERT ON TABLE "user_session" TO "finbank_runtime";
GRANT UPDATE ("last_activity_at", "idle_expires_at", "revoked_at") ON TABLE "user_session" TO "finbank_runtime";
