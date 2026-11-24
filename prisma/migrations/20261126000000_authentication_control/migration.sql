-- DEV-017: controle de tentativas de autenticação. Migração aditiva, sem alteração de dados.

-- CreateTable
CREATE TABLE "authentication_control" (
    "subject_hash" CHAR(64) NOT NULL,
    "failures" INTEGER NOT NULL,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "restricted_until" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "authentication_control_pkey" PRIMARY KEY ("subject_hash")
);

-- CreateIndex
CREATE INDEX "authentication_control_expires_at_idx" ON "authentication_control"("expires_at");

-- Restrições manuais. O assunto é um SHA-256: nenhum e-mail em claro.
ALTER TABLE "authentication_control" ADD CONSTRAINT "authentication_control_subject_format"
  CHECK (("subject_hash" COLLATE "C") ~ '^[0-9a-f]{64}$');
ALTER TABLE "authentication_control" ADD CONSTRAINT "authentication_control_failures_positive"
  CHECK ("failures" > 0);

-- Privilégios: única tabela em que a execução pode apagar linhas (contadores vencidos ou zerados).
REVOKE ALL ON TABLE "authentication_control" FROM PUBLIC;
REVOKE ALL ON TABLE "authentication_control" FROM "finbank_runtime";
GRANT SELECT, INSERT, DELETE ON TABLE "authentication_control" TO "finbank_runtime";
GRANT UPDATE ("failures", "window_started_at", "restricted_until", "expires_at") ON TABLE "authentication_control" TO "finbank_runtime";
