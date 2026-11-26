-- DEV-024: estado do workspace e da conta, crédito educacional e modalidade. Migração aditiva:
-- workspaces e contas existentes ficam ACTIVE; operações existentes mantêm o tipo, sem modalidade.

-- CreateEnum
CREATE TYPE "workspace_status" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "payment_modality" AS ENUM ('PIX_KEY', 'PIX_COPY_PASTE', 'PIX_QR_STATIC');

-- AlterEnum (o valor novo não é usado neste script fora de corpos de função)
ALTER TYPE "operation_type" ADD VALUE 'EDUCATIONAL_CREDIT';

-- AlterTable
ALTER TABLE "workspace" ADD COLUMN "status" "workspace_status" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "account" ADD COLUMN "status" "account_status" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "payment_operation" ADD COLUMN "modality" "payment_modality";

-- A contrapartida nunca fica bloqueada.
ALTER TABLE "account" ADD CONSTRAINT "account_contra_active" CHECK ("kind" = 'STANDARD' OR "status" = 'ACTIVE');

-- Só o estorno referencia outra operação (crédito e transferência, não).
ALTER TABLE "payment_operation" DROP CONSTRAINT "payment_operation_reversal_link";
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_reversal_link"
  CHECK (("type" = 'REVERSAL') = ("reverses_operation_id" IS NOT NULL));

-- Modalidade identifica a origem de uma transferência; outros tipos não a têm.
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_modality_transfer"
  CHECK ("modality" IS NULL OR "type" = 'TRANSFER');

-- Crédito educacional: da contrapartida do workspace para uma conta comum.
CREATE FUNCTION "check_credit_direction"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Conta ausente do workspace fica para a chave estrangeira (conta não encontrada).
  IF NEW."type"::text = 'EDUCATIONAL_CREDIT' AND (
       EXISTS (SELECT 1 FROM "account" WHERE "workspace_id" = NEW."workspace_id" AND "id" = NEW."debit_account_id" AND "kind" <> 'CONTRA')
       OR EXISTS (SELECT 1 FROM "account" WHERE "workspace_id" = NEW."workspace_id" AND "id" = NEW."credit_account_id" AND "kind" <> 'STANDARD')) THEN
    RAISE EXCEPTION 'crédito educacional fora da contrapartida' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_operation_credit_direction"
  BEFORE INSERT ON "payment_operation"
  FOR EACH ROW EXECUTE FUNCTION "check_credit_direction"();

-- Nenhum lançamento em conta bloqueada ou em workspace arquivado, também para o dono.
CREATE FUNCTION "check_entry_states"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "account" WHERE "id" = NEW."account_id" AND "status" <> 'ACTIVE')
     OR EXISTS (SELECT 1 FROM "workspace" WHERE "id" = NEW."workspace_id" AND "status" <> 'ACTIVE') THEN
    RAISE EXCEPTION 'conta bloqueada ou workspace arquivado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_entry_active_states"
  BEFORE INSERT ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION "check_entry_states"();
