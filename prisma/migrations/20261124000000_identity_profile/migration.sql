-- DEV-015: perfil e e-mail de login na identidade e alias do workspace.
-- Nenhum caso de uso cria identidades: se houver alguma, a migração para antes de alterar
-- qualquer objeto, porque perfil e e-mail não podem ser deduzidos.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user_identity") OR EXISTS (SELECT 1 FROM "workspace_membership") THEN
    RAISE EXCEPTION 'migração interrompida: há identidades ou vínculos cadastrados sem perfil e e-mail; nada foi alterado';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "workspace" ADD COLUMN "alias" VARCHAR(40);

-- AlterTable
ALTER TABLE "user_identity" ADD COLUMN "profile" "membership_role" NOT NULL,
ADD COLUMN "email" VARCHAR(254) NOT NULL,
ADD COLUMN "workspace_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "workspace_alias_key" ON "workspace"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_id_profile_key" ON "user_identity"("id", "profile");

-- AddForeignKey
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- O vínculo passa a apontar para a identidade com o mesmo perfil.
ALTER TABLE "workspace_membership" DROP CONSTRAINT "workspace_membership_identity_id_fkey";

-- AddForeignKey
ALTER TABLE "workspace_membership" ADD CONSTRAINT "workspace_membership_identity_id_role_fkey" FOREIGN KEY ("identity_id", "role") REFERENCES "user_identity"("id", "profile") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Restrições manuais. COLLATE "C": intervalos por código, sem depender do idioma do banco.
-- Alias: 3 a 40 caracteres a-z, 0-9 ou hífen, sem hífen nas pontas.
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_alias_format"
  CHECK (("alias" COLLATE "C") ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');

-- E-mail normalizado: ASCII visível, sem maiúsculas nem espaços e com um único @.
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_email_normalized"
  CHECK (("email" COLLATE "C") ~ '^[!-?[-~]+@[!-?[-~]+$');

-- Cliente pertence a exatamente um workspace; facilitador é global.
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_profile_workspace"
  CHECK (("profile" = 'CUSTOMER') = ("workspace_id" IS NOT NULL));

-- E-mail único por workspace para clientes e entre facilitadores.
CREATE UNIQUE INDEX "user_identity_customer_email" ON "user_identity"("workspace_id", "email") WHERE "profile" = 'CUSTOMER';
CREATE UNIQUE INDEX "user_identity_facilitator_email" ON "user_identity"("email") WHERE "profile" = 'FACILITATOR';

-- Vínculo é administrativo: somente facilitador.
ALTER TABLE "workspace_membership" ADD CONSTRAINT "workspace_membership_facilitator_only"
  CHECK ("role" = 'FACILITATOR');

-- Identificador, perfil e workspace da identidade não mudam depois de criados.
CREATE FUNCTION "reject_user_identity_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."profile" IS DISTINCT FROM OLD."profile"
     OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id" THEN
    RAISE EXCEPTION 'identificador, perfil e workspace da identidade são imutáveis' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_identity_immutable"
  BEFORE UPDATE ON "user_identity"
  FOR EACH ROW EXECUTE FUNCTION "reject_user_identity_change"();

-- O alias pode mudar de workspace; o identificador do workspace não muda.
CREATE FUNCTION "reject_workspace_id_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'identificador do workspace imutável' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workspace_id_immutable"
  BEFORE UPDATE ON "workspace"
  FOR EACH ROW EXECUTE FUNCTION "reject_workspace_id_change"();
