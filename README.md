# finbank-v2-api

API NestJS/TypeScript do FinBank V2 (monólito modular, arquitetura hexagonal pragmática). Documentação oficial, regras e histórias ficam na coordenação (`../_bmad-output/`, `../.claude/rules/`).

Estado atual (DEV-001, DEV-003 e DEV-005): bootstrap, composição de módulos, módulo técnico `health` (liveness e readiness) e adaptador de persistência PostgreSQL/Prisma sem modelos. Sem domínio, tabelas financeiras, autenticação, worker ou rotas financeiras.

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

Dependências são fixadas com versão exata (`.npmrc`: `save-exact=true`, `engine-strict=true`). Atenção: o dist-tag `latest` do pacote `prisma` aponta para um release candidate da linha 8; sempre instalar com versão explícita. Atualizações exigem verificação de compatibilidade e registro em história.

## Comandos

```sh
npm ci                        # instala exatamente o lockfile
npm run prisma:generate       # gera o cliente Prisma em src/generated/ (ignorado pelo Git)
npm run typecheck             # prisma generate + tsc --noEmit (src + test)
npm run build                 # prisma generate + compila src/ para dist/
npm start                     # node dist/main.js, carregando .env se existir (requer build)
npm test                      # testes unitários (sem Docker)
npm run test:integration      # integração com PostgreSQL real descartável (requer Docker em execução)
npm run prisma:migrate:deploy # aplica migrações pendentes no banco de DATABASE_URL
npm run prisma:migrate:status # mostra o estado das migrações no banco de DATABASE_URL
```

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
- O `schema.prisma` não declara modelos. Modelos financeiros dependem das decisões pendentes PD-05/PD-06 e de histórias futuras.

## Migrações

- Migrações ficam em `prisma/migrations/` e são aplicadas com `npm run prisma:migrate:deploy`.
- A migração `00000000000000_baseline` é técnica: valida o mecanismo e não cria tabelas de domínio. Após aplicá-la, a única tabela é o controle `_prisma_migrations`.
- A suíte de integração verifica em banco descartável: `migrate deploy` aplica a baseline, repetir é idempotente, `migrate status` informa banco atualizado e `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` não encontra divergência.
- Não executar reset nem migração destrutiva em banco persistente sem autorização explícita.

## Testes

- `test/unit/`: configuração, sanitização de erros e mapeamento do `HealthService` (readiness e transições de log), sem banco.
- `test/integration/`: o `global-setup.ts` sobe um container `postgres:18.6-alpine` efêmero (porta aleatória, sem volume) via Testcontainers e o remove ao final. Cobre conexão real, abertura/encerramento de sessões (`pg_stat_activity`), indisponibilidade, credencial incorreta, timeout, migrações e bootstrap HTTP. Nunca substituir PostgreSQL por SQLite.
- `test/integration/health.api.spec.ts`: contrato HTTP de health com PactumJS (3.9.1), contra um container PostgreSQL próprio. Cobre:
  - banco disponível;
  - banco recusando conexões (`ALLOW_CONNECTIONS false` e conexões encerradas);
  - recuperação;
  - banco sem resposta (`docker pause`, caminho do timeout);
  - banco parado.

  Em todos os cenários verifica que o payload não traz dados sensíveis e que o liveness continua 200.

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

## Convenção de módulos

- `src/main.ts`: somente bootstrap (configuração, criação da aplicação, shutdown hooks, listen).
- `src/app.module.ts`: raiz de composição (`AppModule.forRoot(config)`); importa módulos, sem regras.
- `src/<módulo>/`: módulo NestJS. Controllers traduzem HTTP e delegam a serviços de caso de uso.
- `src/persistence/`: adaptador de infraestrutura; sem regras de negócio. Portas de repositório serão criadas quando houver caso de uso concreto.
- Quando houver regra de domínio, ela fica em código sem dependência de NestJS, HTTP ou Prisma; portas e adaptadores são criados somente quando houver necessidade concreta (sem pastas ou interfaces vazias).
- PaymentExecution será o único módulo autorizado a alterar saldos (ver arquitetura na coordenação).

## Imagem Docker (DEV-004)

`Dockerfile` multi-stage sobre `node:24.21.0-bookworm-slim`:

- `deps`: `npm ci` com dependências de desenvolvimento;
- `build`: `npm run build`;
- `migrate`: `prisma migrate deploy`, com o schema engine da plataforma baixado no build e `openssl`;
- `runtime`: `npm ci --omit=dev`, usuário `node`, `node dist/main.js`, porta 3000.

Nenhum segredo entra na imagem: `DATABASE_URL` é fornecida quando o container roda. O `.dockerignore` exclui `node_modules`, `dist`, `src/generated`, `test`, `.env` e Git. Orquestração em `../finbank-v2-infra`.
