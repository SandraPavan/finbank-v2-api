-- Extrato da conta: lançamentos do mais recente ao mais antigo, com desempate pelo id. Aditiva: nenhum dado muda.
CREATE INDEX "ledger_entry_workspace_id_account_id_created_at_id_idx" ON "ledger_entry"("workspace_id", "account_id", "created_at" DESC, "id" DESC);
