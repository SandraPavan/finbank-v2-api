-- DEV-027: solicitações de abertura (onboarding), gravadas PENDING. Migração aditiva.

-- CreateEnum
CREATE TYPE "onboarding_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "onboarding_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "status" "onboarding_status" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "cpf" CHAR(11) NOT NULL,
    "birth_date" DATE NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "phone" VARCHAR(11) NOT NULL,
    "password_hash" VARCHAR(160) NOT NULL,
    "business_date" DATE NOT NULL,
    "clock_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "onboarding_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "onboarding_request_workspace_id_created_at_idx" ON "onboarding_request"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Formatos normalizados pela aplicação, garantidos também no banco.
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_cpf_format"
  CHECK (("cpf" COLLATE "C") ~ '^[0-9]{11}$');
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_phone_format"
  CHECK (("phone" COLLATE "C") ~ '^[1-9]{2}([0-9]{8}|9[0-9]{8})$');
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_email_normalized"
  CHECK (("email" COLLATE "C") ~ '^[!-?[-~]+@[!-?[-~]+$');
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_name_length"
  CHECK (char_length("name") BETWEEN 2 AND 120 AND "name" = btrim("name"));
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_password_hash_format"
  CHECK (("password_hash" COLLATE "C") ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$');
ALTER TABLE "onboarding_request" ADD CONSTRAINT "onboarding_request_dates"
  CHECK ("birth_date" >= DATE '1900-01-01' AND "birth_date" <= "business_date" AND "clock_revision" >= 0);

-- CPF e e-mail únicos no workspace entre solicitações não rejeitadas: a rejeição libera os dados.
CREATE UNIQUE INDEX "onboarding_request_workspace_cpf" ON "onboarding_request"("workspace_id", "cpf") WHERE "status" <> 'REJECTED';
CREATE UNIQUE INDEX "onboarding_request_workspace_email" ON "onboarding_request"("workspace_id", "email") WHERE "status" <> 'REJECTED';

-- Privilégios: a execução lê e insere, sem escolher identificador nem instante.
REVOKE ALL ON TABLE "onboarding_request" FROM PUBLIC;
REVOKE ALL ON TABLE "onboarding_request" FROM "finbank_runtime";
GRANT SELECT ON TABLE "onboarding_request" TO "finbank_runtime";
GRANT INSERT ("workspace_id", "status", "name", "cpf", "birth_date", "email", "phone", "password_hash", "business_date", "clock_revision")
  ON TABLE "onboarding_request" TO "finbank_runtime";
