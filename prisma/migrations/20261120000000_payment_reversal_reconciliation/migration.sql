-- DEV-011: estorno compensatório vinculado e proteção da identidade das contas. Migração aditiva.
-- Parte gerada pelo Prisma (tipo da operação e vínculo do estorno, composto por workspace).

-- CreateEnum
CREATE TYPE "operation_type" AS ENUM ('TRANSFER', 'REVERSAL');

-- AlterTable
ALTER TABLE "payment_operation" ADD COLUMN     "reverses_operation_id" UUID,
ADD COLUMN     "type" "operation_type" NOT NULL DEFAULT 'TRANSFER';

-- CreateIndex
CREATE UNIQUE INDEX "payment_operation_workspace_id_reverses_operation_id_key" ON "payment_operation"("workspace_id", "reverses_operation_id");

-- AddForeignKey
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_workspace_id_reverses_operation_id_fkey" FOREIGN KEY ("workspace_id", "reverses_operation_id") REFERENCES "payment_operation"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Parte manual: restrições que o schema Prisma não expressa.

-- Coerência entre o tipo e o vínculo: somente o estorno referencia outra operação.
ALTER TABLE "payment_operation"
  ADD CONSTRAINT "payment_operation_reversal_link" CHECK (
    ("type" = 'TRANSFER' AND "reverses_operation_id" IS NULL)
    OR ("type" = 'REVERSAL' AND "reverses_operation_id" IS NOT NULL)
  );

-- O estorno espelha a operação de origem do mesmo workspace: origem TRANSFER,
-- contas invertidas e mesmo valor. Origem ausente fica para a chave estrangeira.
CREATE FUNCTION "check_reversal_matches_original"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  original RECORD;
BEGIN
  IF NEW."type" <> 'REVERSAL' OR NEW."reverses_operation_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "type", "debit_account_id", "credit_account_id", "amount_cents" INTO original
    FROM "payment_operation"
   WHERE "workspace_id" = NEW."workspace_id" AND "id" = NEW."reverses_operation_id";

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF original."type" <> 'TRANSFER'
     OR NEW."debit_account_id" <> original."credit_account_id"
     OR NEW."credit_account_id" <> original."debit_account_id"
     OR NEW."amount_cents" <> original."amount_cents" THEN
    RAISE EXCEPTION 'estorno incoerente com a operação de origem' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_operation_reversal_matches"
  BEFORE INSERT ON "payment_operation"
  FOR EACH ROW EXECUTE FUNCTION "check_reversal_matches_original"();

-- Identidade da conta imutável: id, workspace e tipo não mudam depois de criada.
-- O saldo materializado continua alterável somente pelo PaymentExecution; divergências
-- entre saldo e ledger são detectadas pela reconciliação.
CREATE FUNCTION "reject_account_identity_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'identidade da conta imutável' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "account_identity_immutable"
  BEFORE UPDATE ON "account"
  FOR EACH ROW EXECUTE FUNCTION "reject_account_identity_change"();
