# finbank-v2-api

API NestJS/TypeScript do FinBank V2 (monólito modular, arquitetura hexagonal pragmática). Este repositório é público e autossuficiente: setup, execução e testes dependem só dele (e de `finbank-v2-web` e `finbank-v2-infra` para o ambiente completo). As referências a histórias (DEV-xxx) e decisões (PD-xx) vêm da documentação interna da equipe e não são necessárias para usar o projeto.

Estado atual (DEV-001, DEV-003, DEV-005, DEV-006 e DEV-010): bootstrap, composição de módulos, módulo técnico `health` (liveness e readiness), adaptador de persistência PostgreSQL/Prisma, contrato de domínio dos modos educacionais (sem endpoint e com catálogo de defeitos vazio) e núcleo de execução financeira (ledger de dupla entrada e PaymentExecution, sem rota exposta). Sem PIX, autenticação, worker ou rotas financeiras.

## Runtime e versões (PD-02, resolvida na DEV-001)

| Item | Versão |
|---|---|
| Node.js | 24.21.0 (`.nvmrc`; `engines: >=24.12.0 <25`) |
| npm | 11.19.0 (`packageManager`), lockfile versionado |
| Módulos | ESM (`"type": "module"`, `nodenext`); imports relativos com sufixo `.js` |
| NestJS | 12.4.2 (`common`, `core`, `platform-express`, `testing`) |
| TypeScript | 6.0.3 |
| Vitest | 4.1.12 |
| Prisma (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) | 7.10.1 |
| PostgreSQL (testes e smoke) | imagem `postgres:18.6-alpine` |
| Testcontainers (`testcontainers`, `@testcontainers/postgresql`) | 12.2.1 |
| PactumJS (`pactum`) | 3.9.1 |
| ESLint (`eslint`, `@eslint/js`, `typescript-eslint`, `globals`) | 10.15.0, 10.0.1, 8.72.2, 17.14.0 |

Dependências são fixadas com versão exata (`.npmrc`: `save-exact=true`, `engine-strict=true`). Atenção: o dist-tag `latest` do pacote `prisma` aponta para um release candidate da linha 8; sempre instalar com versão explícita. Atualizações exigem verificação de compatibilidade e registro em história.

## Comandos

```sh
npm ci                        # instala exatamente o lockfile
npm run prisma:generate       # gera o cliente Prisma em src/generated/ (ignorado pelo Git)
npm run lint                  # prisma generate + ESLint (typescript-eslint com tipos), --max-warnings 0
npm run typecheck             # prisma generate + tsc --noEmit (src, test e configs)
npm run build                 # prisma generate + compila src/ para dist/
npm start                     # node dist/main.js, carregando .env se existir (requer build)
npm test                      # testes unitários (sem Docker)
npm run test:integration      # integração com PostgreSQL real descartável (requer Docker em execução)
npm run prisma:migrate:deploy # aplica migrações pendentes no banco de DATABASE_URL
npm run prisma:migrate:status # mostra o estado das migrações no banco de DATABASE_URL
npm run verify                # lint + typecheck + test + build (sem Docker)
```

**Qualidade:** ESLint com `--max-warnings 0`, typecheck estrito, Vitest e PostgreSQL real nos testes de integração. Os testes cobrem o comportamento correto. Não há meta percentual de cobertura. Os testes de contrato HTTP (PactumJS) dos health checks fazem parte de `test:integration`.

## Configuração por ambiente

Copie `.env.example` para `.env` (ignorado pelo Git) e ajuste localmente. Nunca versionar credenciais reais.

| Variável | Padrão | Regra |
|---|---|---|
| `PORT` | `3000` | Inteiro de 1 a 65535; valor inválido encerra com código 1 e mensagem sem coerção silenciosa |
| `DATABASE_URL` | — (obrigatória) | URL `postgres://` ou `postgresql://` com host; ausente ou inválida encerra com código 1. A mensagem nunca inclui o valor |

## Persistência

- `src/persistence/prisma.service.ts`: adaptador dono do ciclo de vida. Cria o cliente com `@prisma/adapter-pg` (timeout de conexão de 5 s). Na inicialização executa `SELECT 1` (o `$connect` do driver adapter é preguiçoso) e falha imediatamente se o banco estiver indisponível; no encerramento desconecta.
- `src/persistence/database-errors.ts`: toda falha de conexão vira `DatabaseUnavailableError`, com mensagem genérica e somente um código técnico em allowlist (por exemplo `DatabaseNotReachable` ou o código PostgreSQL `28P01`). URL, host, porta, usuário, senha e a causa original não são expostos.
- Banco indisponível na subida: a aplicação registra a mensagem sanitizada e encerra com código 1.
- O `schema.prisma` declara somente os modelos do núcleo de execução financeira (`Workspace`, `Account`, `PaymentOperation`, `LedgerEntry`). Restrições que o Prisma não expressa ficam na migração SQL (veja a seção Execução financeira).

## Migrações

- Migrações ficam em `prisma/migrations/` e são aplicadas com `npm run prisma:migrate:deploy`.
- A migração `00000000000000_baseline` é técnica: valida o mecanismo e não cria tabelas.
- A migração `20261119000000_payment_execution_core` é aditiva: cria as tabelas do núcleo financeiro e, em SQL manual, os `CHECK`s, o índice parcial e os triggers de imutabilidade e equilíbrio.
- A suíte de integração aplica as migrações no `global-setup.ts` e verifica em banco descartável: as duas migrações registradas em ordem, repetir é idempotente, as restrições manuais existem no catálogo do PostgreSQL, `migrate status` informa banco atualizado e `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` não encontra divergência.
- Não executar reset nem migração destrutiva em banco persistente sem autorização explícita.

## Testes

- `test/unit/`: configuração, sanitização de erros, mapeamento do `HealthService` (readiness e transições de log), matriz dos modos educacionais (`education/`), domínio e lógica de decisão do PaymentExecution (`payment-execution/`) e regras de arquitetura (`architecture.spec.ts`), sem banco.
- `test/integration/`: o `global-setup.ts` sobe um container `postgres:18.6-alpine` efêmero (porta aleatória, sem volume) via Testcontainers e o remove ao final. Cobre conexão real, abertura/encerramento de sessões (`pg_stat_activity`), indisponibilidade, credencial incorreta, timeout, migrações e bootstrap HTTP. Nunca substituir PostgreSQL por SQLite.
- `test/integration/health.api.spec.ts`: contrato HTTP de health com PactumJS (3.9.1), contra um container PostgreSQL próprio. Cobre:
  - banco disponível;
  - banco recusando conexões (`ALLOW_CONNECTIONS false` e conexões encerradas);
  - recuperação;
  - banco sem resposta (`docker pause`, caminho do timeout);
  - banco parado.

  Em todos os cenários verifica que o payload não traz dados sensíveis e que o liveness continua 200.
- `test/integration/payment-execution/`: atomicidade (com falha real injetada no PostgreSQL), idempotência sequencial e paralela, concorrência (débitos disputando saldo e transferências cruzadas), isolamento entre dois workspaces, imutabilidade e equilíbrio do ledger. Cada teste cria seu próprio workspace, porque operações e lançamentos não podem ser apagados.

## Health checks (DEV-005)

| Rota | Banco disponível | Banco indisponível |
|---|---|---|
| `GET /health/live` | `200 {"status":"ok"}` | `200 {"status":"ok"}` (processo vivo; não consulta dependências) |
| `GET /health/ready` | `200 {"status":"ok","checks":{"database":"up"}}` | `503 {"status":"unavailable","checks":{"database":"down"}}` |

- Ambas respondem com `Cache-Control: no-store`. A rota antiga `GET /health` foi substituída e responde 404.
- **Readiness:** executa `SELECT 1` a cada chamada (`PrismaService.ping`), com limite técnico de 2 s (`READINESS_TIMEOUT_MS`). Esse limite não é um SLO. Estourar o limite conta como `down`. Quando o banco volta, a readiness se recupera sozinha, sem reiniciar a aplicação.
- **Payload:** nunca inclui mensagem de erro, código, host, porta, usuário, URL ou nome do banco.
- **Log:** o motivo sanitizado (por exemplo `DatabaseNotReachable` ou `PingTimeout`) vai só para o log, e apenas na mudança de estado (`up→down` em warn, `down→up` em log).
- **Banco indisponível na subida:** continua sendo fail-fast, com código de saída 1 (DEV-003).
- **Healthcheck de container:** `dist/healthcheck.js` chama `http://127.0.0.1:$PORT/health/ready` e sai com 0 só em HTTP 200. Usa o mesmo parser de `PORT` da aplicação e tem timeout de 2,5 s. O Compose do `finbank-v2-infra` usa esse script.

## Modos educacionais (DEV-006)

`src/education/` é domínio puro: não importa NestJS, HTTP nem Prisma. Os identificadores de defeito são opacos (`d-` + 16 hexadecimais) e não descrevem o defeito. Presets de laboratório são indexados pelo SHA-256 de um código de laboratório: o código nunca fica no repositório, e o hash não é autorização.

- `educational-mode.ts`: tipos (modo, preset, ambiente, ator, configuração), erros tipados e parsing estrito de entradas `unknown`, inclusive do código de laboratório (`A-Z`, `0-9` e `-`, 8 a 32 caracteres). As mensagens de erro nunca trazem o valor recebido, o código nem o hash.
- `defect-catalog.ts`: `DEFECT_CATALOG`, **vazio** (nenhum defeito executável), e `validateCatalog`, que exige IDs opacos, hashes SHA-256 válidos e presets coerentes.
- `educational-policy.ts`: política de segurança (`affectsSecurity` nunca em `SHARED`), resolução (`STUDENT/ALL` calculado sobre o catálogo vigente), default `STUDENT/ALL`, leitura isolada por workspace (a leitura de um preset de laboratório indica só o tipo, sem o hash) e alteração só pelo facilitador do próprio workspace.

Ainda não há endpoint, persistência nem variável de ambiente, porque dependem de PD-03 (identidade e workspace). O papel e o workspace do ator devem vir da autorização validada, nunca do payload. Os testes ficam em `test/unit/education/`. O catálogo fictício `fixture-catalog.ts` só existe nos testes, com IDs e códigos aleatórios que não correspondem a nenhum laboratório.

## Execução financeira (DEV-010)

`src/payment-execution/` é o único caminho que altera saldos. Não há controller nem rota.

- `domain/`: centavos como `bigint` (o tipo `number` é rejeitado), positivos e limitados ao maior `BIGINT` do PostgreSQL (limite técnico, não de negócio); comando de movimentação validado sem coerção; par de lançamentos (débito negativo, crédito positivo) com soma zero; impressão digital SHA-256 do conteúdo; erros tipados com mensagens fixas, sem valores, identificadores ou chaves.
- `application/`: `PaymentExecutionService.openAccount` (saldo zero) e `execute`; a porta `PaymentExecutionStore` é uma unidade de trabalho transacional e toda a decisão financeira fica no serviço.
- `adapters/`: transação interativa do Prisma em `READ COMMITTED`. Ordem: registra a operação com `ON CONFLICT (workspace_id, operation_key) DO NOTHING` (chamadas concorrentes com a mesma chave esperam a primeira terminar); se a chave existe, compara a impressão digital e devolve o resultado original (`replayed: true`) ou `IDEMPOTENCY_CONFLICT`; trava as duas contas com `FOR NO KEY UPDATE` em ordem de id; grava os lançamentos e os dois saldos. Sem retry automático.
- **Contas:** `STANDARD` nunca fica negativa (`INSUFFICIENT_FUNDS`); `CONTRA` é a contrapartida única do workspace e pode ficar negativa, para financiar contas pelo próprio `execute`.
- **Workspace:** chave de escopo de dados, não autorização. Chaves estrangeiras compostas `(workspace_id, account_id)` impedem misturar workspaces; conta inexistente ou de outro workspace devolve o mesmo `ACCOUNT_NOT_FOUND`.
- **No banco:** `UPDATE`, `DELETE` e `TRUNCATE` em `payment_operation` e `ledger_entry` são rejeitados (SQLSTATE `23001`); um trigger adiado para o commit exige dois lançamentos por operação, com débito e crédito iguais ao valor; `CHECK`s cobrem valor positivo, contas distintas e saldo não negativo de `STANDARD`.
- Uma operação rejeitada não é registrada: a mesma chave pode ser usada numa nova tentativa.
- Fora deste módulo: estorno compensatório, reconciliação, rotas, autenticação e PIX.

## Convenção de módulos

- `src/main.ts`: somente bootstrap (configuração, criação da aplicação, shutdown hooks, listen).
- `src/app.module.ts`: raiz de composição (`AppModule.forRoot(config)`); importa módulos, sem regras.
- `src/<módulo>/`: módulo NestJS. Controllers traduzem HTTP e delegam a serviços de caso de uso.
- `src/persistence/`: adaptador de infraestrutura; sem regras de negócio. Portas de repositório serão criadas quando houver caso de uso concreto.
- Quando houver regra de domínio, ela fica em código sem dependência de NestJS, HTTP ou Prisma; portas e adaptadores são criados somente quando houver necessidade concreta (sem pastas ou interfaces vazias).
- PaymentExecution (`src/payment-execution/`) é o único módulo autorizado a alterar saldos; `test/unit/architecture.spec.ts` falha se outro arquivo de `src/` escrever em contas, operações ou ledger.

## Imagem Docker (DEV-004)

`Dockerfile` multi-stage sobre `node:24.21.0-bookworm-slim`:

- `deps`: `npm ci` com dependências de desenvolvimento;
- `build`: `npm run build`;
- `migrate`: `prisma migrate deploy`, com o schema engine da plataforma baixado no build e `openssl`;
- `runtime`: `npm ci --omit=dev`, usuário `node`, `node dist/main.js`, porta 3000.

Nenhum segredo entra na imagem: `DATABASE_URL` é fornecida quando o container roda. O `.dockerignore` exclui `node_modules`, `dist`, `src/generated`, `test`, `.env` e Git. Orquestração em `../finbank-v2-infra`.
