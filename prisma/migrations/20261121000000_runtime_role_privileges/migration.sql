-- DEV-012: papel de execução com privilégios mínimos. Migração aditiva, sem alteração de dados.
-- O dono do esquema (migrador) continua dono de todos os objetos. A API conecta com um usuário de
-- login membro de "finbank_runtime", provisionado por ambiente depois das migrações.
-- Toda migração futura que criar tabela deve conceder explicitamente o que a execução precisa.

-- Papel de grupo sem login e sem atributos administrativos (global ao servidor; criado uma vez).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finbank_runtime') THEN
    CREATE ROLE "finbank_runtime" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Ponto de partida explícito: nada para PUBLIC nem para o papel de execução.
REVOKE ALL ON TABLE "workspace", "account", "payment_operation", "ledger_entry" FROM PUBLIC;
REVOKE ALL ON TABLE "workspace", "account", "payment_operation", "ledger_entry" FROM "finbank_runtime";

GRANT USAGE ON SCHEMA "public" TO "finbank_runtime";

-- Workspaces são criados fora da execução (ainda sem caso de uso); a execução só os lê.
GRANT SELECT ON TABLE "workspace" TO "finbank_runtime";

-- Contas: abertura e leitura; somente o saldo pode ser alterado. O UPDATE na coluna de saldo
-- também habilita a trava de linha (FOR NO KEY UPDATE) usada pelo PaymentExecution.
GRANT SELECT, INSERT ON TABLE "account" TO "finbank_runtime";
GRANT UPDATE ("balance_cents") ON TABLE "account" TO "finbank_runtime";

-- Operações e lançamentos: somente inclusão e leitura.
GRANT SELECT, INSERT ON TABLE "payment_operation" TO "finbank_runtime";
GRANT SELECT, INSERT ON TABLE "ledger_entry" TO "finbank_runtime";
