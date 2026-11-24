-- DEV-014: identidades e vínculos com workspaces. Migração aditiva, sem alteração de dados.
-- Papel e estados não têm valor padrão: nenhum acesso é concedido por omissão.

-- CreateEnum
CREATE TYPE "identity_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "membership_role" AS ENUM ('CUSTOMER', 'FACILITATOR');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "user_identity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "identity_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_membership" (
    "workspace_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "role" "membership_role" NOT NULL,
    "status" "membership_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_membership_pkey" PRIMARY KEY ("workspace_id","identity_id")
);

-- CreateIndex
CREATE INDEX "workspace_membership_identity_id_idx" ON "workspace_membership"("identity_id");

-- AddForeignKey
ALTER TABLE "workspace_membership" ADD CONSTRAINT "workspace_membership_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workspace_membership" ADD CONSTRAINT "workspace_membership_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "user_identity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Privilégios: a execução só lê; a escrita terá concessão própria quando houver caso de uso.
REVOKE ALL ON TABLE "user_identity", "workspace_membership" FROM PUBLIC;
REVOKE ALL ON TABLE "user_identity", "workspace_membership" FROM "finbank_runtime";
GRANT SELECT ON TABLE "user_identity", "workspace_membership" TO "finbank_runtime";
