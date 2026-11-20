-- DEV-010: núcleo de execução financeira. Migração aditiva.
-- Parte gerada pelo Prisma (tabelas, índices e chaves compostas por workspace).

-- CreateEnum
CREATE TYPE "account_kind" AS ENUM ('STANDARD', 'CONTRA');

-- CreateTable
CREATE TABLE "workspace" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "kind" "account_kind" NOT NULL,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_operation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "debit_account_id" UUID NOT NULL,
    "credit_account_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_workspace_id_id_key" ON "account"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_operation_workspace_id_operation_key_key" ON "payment_operation"("workspace_id", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_operation_workspace_id_id_key" ON "payment_operation"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "ledger_entry_workspace_id_account_id_idx" ON "ledger_entry"("workspace_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_operation_id_account_id_key" ON "ledger_entry"("operation_id", "account_id");

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_workspace_id_debit_account_id_fkey" FOREIGN KEY ("workspace_id", "debit_account_id") REFERENCES "account"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_operation" ADD CONSTRAINT "payment_operation_workspace_id_credit_account_id_fkey" FOREIGN KEY ("workspace_id", "credit_account_id") REFERENCES "account"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_workspace_id_operation_id_fkey" FOREIGN KEY ("workspace_id", "operation_id") REFERENCES "payment_operation"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_workspace_id_account_id_fkey" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "account"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Parte manual: restrições que o schema Prisma não expressa.

-- Valores e consistência das operações.
ALTER TABLE "payment_operation"
  ADD CONSTRAINT "payment_operation_amount_positive" CHECK ("amount_cents" > 0),
  ADD CONSTRAINT "payment_operation_distinct_accounts" CHECK ("debit_account_id" <> "credit_account_id"),
  ADD CONSTRAINT "payment_operation_key_format" CHECK ("operation_key" ~ '^[A-Za-z0-9_-]{8,128}$'),
  ADD CONSTRAINT "payment_operation_fingerprint_format" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_amount_nonzero" CHECK ("amount_cents" <> 0);

-- Conta comum nunca fica negativa; a contrapartida do workspace pode.
ALTER TABLE "account"
  ADD CONSTRAINT "account_standard_non_negative" CHECK ("kind" = 'CONTRA' OR "balance_cents" >= 0);

-- Uma única conta de contrapartida por workspace.
CREATE UNIQUE INDEX "account_one_contra_per_workspace" ON "account"("workspace_id") WHERE "kind" = 'CONTRA';

-- Imutabilidade: operações e lançamentos não podem ser alterados nem removidos.
-- Correções futuras são feitas por lançamentos compensatórios.
CREATE FUNCTION "reject_immutable_change"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registro imutável' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "payment_operation_immutable"
  BEFORE UPDATE OR DELETE ON "payment_operation"
  FOR EACH ROW EXECUTE FUNCTION "reject_immutable_change"();
CREATE TRIGGER "payment_operation_no_truncate"
  BEFORE TRUNCATE ON "payment_operation"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_immutable_change"();
CREATE TRIGGER "ledger_entry_immutable"
  BEFORE UPDATE OR DELETE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION "reject_immutable_change"();
CREATE TRIGGER "ledger_entry_no_truncate"
  BEFORE TRUNCATE ON "ledger_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_immutable_change"();

-- Equilíbrio verificado no commit: cada operação tem exatamente dois lançamentos,
-- débito negativo na conta de origem e crédito positivo na de destino, somando zero.
CREATE FUNCTION "check_operation_balanced"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  target_operation UUID;
  op RECORD;
  entry_count INTEGER;
  debit_total BIGINT;
  credit_total BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'payment_operation' THEN
    target_operation := NEW."id";
  ELSE
    target_operation := NEW."operation_id";
  END IF;

  SELECT "debit_account_id", "credit_account_id", "amount_cents" INTO op
    FROM "payment_operation" WHERE "id" = target_operation;

  SELECT count(*),
         coalesce(sum("amount_cents") FILTER (WHERE "account_id" = op."debit_account_id"), 0),
         coalesce(sum("amount_cents") FILTER (WHERE "account_id" = op."credit_account_id"), 0)
    INTO entry_count, debit_total, credit_total
    FROM "ledger_entry" WHERE "operation_id" = target_operation;

  IF entry_count <> 2 OR debit_total <> -op."amount_cents" OR credit_total <> op."amount_cents" THEN
    RAISE EXCEPTION 'operação desequilibrada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payment_operation_balanced"
  AFTER INSERT ON "payment_operation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_operation_balanced"();
CREATE CONSTRAINT TRIGGER "ledger_entry_balanced"
  AFTER INSERT ON "ledger_entry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_operation_balanced"();
