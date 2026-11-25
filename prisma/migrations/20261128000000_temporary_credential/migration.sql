-- DEV-020: credencial temporária e sessão restrita. Migração aditiva: senhas e sessões existentes continuam valendo.

-- CreateEnum
CREATE TYPE "session_scope" AS ENUM ('NORMAL', 'PASSWORD_CHANGE');

-- AlterTable: as sessões existentes são comuns; depois disso o escopo é sempre explícito.
ALTER TABLE "user_session" ADD COLUMN "scope" "session_scope" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "user_session" ALTER COLUMN "scope" DROP DEFAULT;

-- AlterTable: senha invalidada continua gravada, mas não autentica.
ALTER TABLE "password_credential" ADD COLUMN "invalidated_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "temporary_credential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_id" UUID NOT NULL,
    "hash" VARCHAR(160) NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "temporary_credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "temporary_credential_identity_id_idx" ON "temporary_credential"("identity_id");

-- AddForeignKey
ALTER TABLE "temporary_credential" ADD CONSTRAINT "temporary_credential_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restrições manuais. Somente Argon2id em formato PHC; prazo positivo e limitado; um único fim.
ALTER TABLE "temporary_credential" ADD CONSTRAINT "temporary_credential_hash_format"
  CHECK (("hash" COLLATE "C") ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$');
ALTER TABLE "temporary_credential" ADD CONSTRAINT "temporary_credential_expiry"
  CHECK ("expires_at" > "issued_at" AND "expires_at" <= "issued_at" + interval '8 days');
ALTER TABLE "temporary_credential" ADD CONSTRAINT "temporary_credential_single_end"
  CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL);

-- Usada ou revogada não muda mais; expirada não é usada; os dados de origem são imutáveis.
CREATE FUNCTION "reject_temporary_credential_revival"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."consumed_at" IS NOT NULL
     OR OLD."revoked_at" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."identity_id" IS DISTINCT FROM OLD."identity_id"
     OR NEW."hash" IS DISTINCT FROM OLD."hash"
     OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR (NEW."consumed_at" IS NOT NULL AND OLD."expires_at" <= clock_timestamp()) THEN
    RAISE EXCEPTION 'credencial temporária terminada não pode ser reativada' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "temporary_credential_terminal"
  BEFORE UPDATE ON "temporary_credential"
  FOR EACH ROW EXECUTE FUNCTION "reject_temporary_credential_revival"();

-- Credencial de facilitador só é emitida pelo dono do esquema (operador).
CREATE FUNCTION "restrict_facilitator_credential"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> (SELECT pg_get_userbyid("relowner") FROM pg_class WHERE "oid" = TG_RELID)
     AND NOT EXISTS (SELECT 1 FROM "user_identity" WHERE "id" = NEW."identity_id" AND "profile" = 'CUSTOMER') THEN
    RAISE EXCEPTION 'credencial de facilitador só é emitida pelo operador' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "temporary_credential_facilitator"
  BEFORE INSERT ON "temporary_credential"
  FOR EACH ROW EXECUTE FUNCTION "restrict_facilitator_credential"();

-- O escopo da sessão também é imutável.
CREATE OR REPLACE FUNCTION "reject_user_session_revival"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."revoked_at" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."identity_id" IS DISTINCT FROM OLD."identity_id"
     OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
     OR NEW."scope" IS DISTINCT FROM OLD."scope"
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

-- Privilégios: a execução emite, usa e revoga, sem escolher identificador, instante de emissão nem mudar prazo.
REVOKE ALL ON TABLE "temporary_credential" FROM PUBLIC;
REVOKE ALL ON TABLE "temporary_credential" FROM "finbank_runtime";
GRANT SELECT ON TABLE "temporary_credential" TO "finbank_runtime";
GRANT INSERT ("identity_id", "hash", "expires_at") ON TABLE "temporary_credential" TO "finbank_runtime";
GRANT UPDATE ("consumed_at", "revoked_at") ON TABLE "temporary_credential" TO "finbank_runtime";
GRANT UPDATE ("invalidated_at") ON TABLE "password_credential" TO "finbank_runtime";
