# finbank-v2-api

API NestJS/TypeScript do FinBank V2 (monólito modular, arquitetura hexagonal pragmática). Este repositório é público e autossuficiente: setup, execução e testes dependem só dele (e de `finbank-v2-web` e `finbank-v2-infra` para o ambiente completo). As referências a histórias (DEV-xxx) e decisões (PD-xx) vêm da documentação interna da equipe e não são necessárias para usar o projeto.

Estado atual (DEV-001, DEV-003, DEV-005, DEV-006, DEV-010, DEV-011, DEV-012, DEV-014, DEV-015, DEV-016, DEV-017, DEV-018, DEV-019 e DEV-020): bootstrap, composição de módulos, módulo técnico `health` (liveness e readiness), adaptador de persistência PostgreSQL/Prisma, contrato de domínio dos modos educacionais (sem endpoint e com catálogo de defeitos vazio) e núcleo de execução financeira (ledger de dupla entrada, PaymentExecution com estorno compensatório e reconciliação somente leitura, sem rota exposta), com a API conectando por um papel de execução de privilégios mínimos, e o modelo de identidades e vínculos com workspaces (consulta interna de acesso, sem rota) e autenticação por HTTP em `/api/v1/auth` e autorização por operação com consulta de workspaces do facilitador, administração de clientes, recuperação de acesso e linha de comando do operador. Sem PIX, worker ou rotas financeiras.

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
| Pact (`@pact-foundation/pact`, só desenvolvimento) | 17.1.4 |
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
npm run audit:prod            # npm audit --omit=dev --audit-level=high (requer rede)
npm run test:contract         # verifica o contrato da interface web (Pact) com PostgreSQL real (requer Docker)
npm run verify                # audit:prod + lint + typecheck + test + build (sem Docker; requer rede)
```

**Qualidade:** ESLint com `--max-warnings 0`, typecheck estrito, Vitest e PostgreSQL real nos testes de integração. Os testes cobrem o comportamento correto. Não há meta percentual de cobertura. Os testes de contrato HTTP (PactumJS) dos health checks fazem parte de `test:integration`.

## Dependências e auditoria (DEV-013)

`npm run verify` começa por `audit:prod`, que falha com qualquer aviso alto ou crítico em dependências de produção. O passo consulta o registro do npm: sem rede, o `verify` falha nesse ponto, e um aviso publicado depois pode fazê-lo falhar sem mudança de código.

Overrides em `package.json`, restritos ao pacote que puxa a versão afetada (nunca globais) e com versões publicadas há pelo menos 7 dias quando adotadas:

| Pacote que puxa | Override | Motivo |
|---|---|---|
| `@prisma/config` (CLI `prisma` 7.10.1) | `effect` 3.22.4 | o `@prisma/config` fixa `effect` 3.20.0, afetado por aviso alto (até 3.22.0) |
| `archiver-utils` (`testcontainers` → `archiver`) | `glob` 14.0.6, e `minimatch` 11.0.8 dentro dele | `glob` 10.5.0 e `minimatch` 9.0.9 afetados por avisos moderados |
| `@typescript-eslint/typescript-estree` (`typescript-eslint` 8.72.2) | `minimatch` 11.0.8 | `minimatch` 10.2.6 afetado por aviso moderado; é a versão usada por `typescript-eslint` 8.73.0 e pelo ESLint |

Compatibilidade verificada com as suítes, `prisma validate`/`migrate deploy` e expansão de padrões do `archiver-utils`. Ao atualizar Prisma, Testcontainers ou `typescript-eslint`, remova o override correspondente se a nova versão já trouxer a dependência corrigida e confirme com `npm audit` e `npm ls effect glob minimatch`. Situação na adoção: `npm audit` sem avisos (produção e desenvolvimento). Não usar `npm audit fix`: as correções sugeridas rebaixam dependências diretas.

## Configuração por ambiente

Copie `.env.example` para `.env` (ignorado pelo Git) e ajuste localmente. Nunca versionar credenciais reais.

| Variável | Padrão | Regra |
|---|---|---|
| `PORT` | `3000` | Inteiro de 1 a 65535; valor inválido encerra com código 1 e mensagem sem coerção silenciosa |
| `DATABASE_URL` | — (obrigatória) | URL `postgres://` ou `postgresql://` com host; ausente ou inválida encerra com código 1. A mensagem nunca inclui o valor |
| `SESSION_IDLE_MINUTES` | `30` | Inteiro de 1 a 1440, menor ou igual a `SESSION_ABSOLUTE_MINUTES`; inválido encerra com código 1 |
| `SESSION_ABSOLUTE_MINUTES` | `480` | Inteiro de 1 a 1440; inválido encerra com código 1 |
| `COOKIE_TRANSPORT` | `secure` | `secure` ou `local-http`; inválido encerra com código 1 |
| `FINBANK_ENVIRONMENT` | `SHARED` | `ISOLATED` ou `SHARED`; classifica a implantação para os defeitos educacionais. Inválido encerra com código 1 |
| `TEMPORARY_CREDENTIAL_HOURS` | `24` | 1 a 168; validade da credencial temporária (também na linha de comando) |
| `LOGIN_MAX_ATTEMPTS` | `5` | 1 a 100 |
| `LOGIN_WINDOW_MINUTES` | `15` | 1 a 1440 |
| `LOGIN_RESTRICTION_SECONDS` | `30` | 1 a 3600 |
| `LOGIN_MAX_RESTRICTION_SECONDS` | `900` | Até 86400, não menor que a inicial |

## Persistência

- `src/persistence/prisma.service.ts`: adaptador dono do ciclo de vida. Cria o cliente com `@prisma/adapter-pg` (timeout de conexão de 5 s). Na inicialização executa `SELECT 1` (o `$connect` do driver adapter é preguiçoso) e falha imediatamente se o banco estiver indisponível; no encerramento desconecta.
- `src/persistence/database-errors.ts`: toda falha de conexão vira `DatabaseUnavailableError`, com mensagem genérica e somente um código técnico em allowlist (por exemplo `DatabaseNotReachable` ou o código PostgreSQL `28P01`). URL, host, porta, usuário, senha e a causa original não são expostos.
- Banco indisponível na subida: a aplicação registra a mensagem sanitizada e encerra com código 1.
- O `schema.prisma` declara somente os modelos do núcleo de execução financeira (`Workspace`, `Account`, `PaymentOperation`, `LedgerEntry` e os enums `AccountKind` e `OperationType`) e de identidade (`UserIdentity`, `WorkspaceMembership` e os enums de papel e estado). Restrições que o Prisma não expressa ficam na migração SQL (veja a seção Execução financeira).

## Migrações

- Migrações ficam em `prisma/migrations/` e são aplicadas com `npm run prisma:migrate:deploy`.
- A migração `00000000000000_baseline` é técnica: valida o mecanismo e não cria tabelas.
- A migração `20261119000000_payment_execution_core` é aditiva: cria as tabelas do núcleo financeiro e, em SQL manual, os `CHECK`s, o índice parcial e os triggers de imutabilidade e equilíbrio.
- A migração `20261121000000_runtime_role_privileges` cria, se não existir, o papel de grupo `finbank_runtime` (o migrador precisa poder criar papéis: superusuário ou `CREATEROLE`; vale no Compose e nos testes) e concede somente os privilégios da execução (veja Papéis no banco). Toda migração futura que criar tabela deve conceder explicitamente o que a execução precisa: o teste da matriz de privilégios acusa divergência.
- A migração `20261120000000_payment_reversal_reconciliation` é aditiva: acrescenta o tipo da operação (as existentes ficam `TRANSFER`) e o vínculo do estorno e, em SQL manual, o `CHECK` de coerência do vínculo, o trigger que confere o estorno contra a operação de origem e o trigger que impede alterar a identidade da conta.
- A migração `20261123000000_identity_membership` é aditiva: cria identidades e vínculos, sem dados iniciais, e concede só leitura à execução.
- A migração `20261124000000_identity_profile` acrescenta perfil, e-mail e alias. Se houver identidade ou vínculo cadastrado, ela para sem alterar nada (perfil e e-mail não podem ser deduzidos). Nesse caso o Prisma registra a migração como falha: trate os dados e use `prisma migrate resolve --rolled-back 20261124000000_identity_profile` antes de aplicar de novo.
- A migração `20261125000000_password_session` é aditiva: cria credenciais e sessões, sem dados iniciais, com as concessões da execução.
- A migração `20261126000000_authentication_control` é aditiva: cria o contador de tentativas.
- A migração `20261201000000_simulation_clock` é aditiva: cria as revisões do relógio simulado, só de inserção; nenhum workspace ganha revisão gravada.
- A migração `20261129000000_educational_config` é aditiva: cria as revisões da configuração educacional, só de inserção.
- A migração `20261128000000_temporary_credential` é aditiva: cria a credencial temporária, a invalidação da senha e o escopo da sessão; senhas e sessões existentes continuam valendo.
- A migração `20261127000000_administration` é aditiva: cria a auditoria, restringe a mudança de estado de facilitador e concede o estado da identidade à execução.
- A suíte de integração aplica as migrações no `global-setup.ts` e verifica em banco descartável: as migrações registradas em ordem, repetir é idempotente, as restrições manuais existem no catálogo do PostgreSQL, `migrate status` informa banco atualizado e `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` não encontra divergência.
- Não executar reset nem migração destrutiva em banco persistente sem autorização explícita.

## Testes

- `test/unit/`: configuração, sanitização de erros, mapeamento do `HealthService` (readiness e transições de log), matriz dos modos educacionais (`education/`), domínio e lógica de decisão do PaymentExecution (`payment-execution/`), cálculo da reconciliação (`reconciliation/`) e regras de arquitetura (`architecture.spec.ts`), sem banco.
- `test/integration/`: o `global-setup.ts` sobe um container `postgres:18.6-alpine` efêmero (porta aleatória, sem volume) via Testcontainers e o remove ao final. Cobre conexão real, abertura/encerramento de sessões (`pg_stat_activity`), indisponibilidade, credencial incorreta, timeout, migrações e bootstrap HTTP. Nunca substituir PostgreSQL por SQLite.
- `test/integration/health.api.spec.ts`: contrato HTTP de health com PactumJS (3.9.1), contra um container PostgreSQL próprio. Cobre:
  - banco disponível;
  - banco recusando conexões (`ALLOW_CONNECTIONS false` e conexões encerradas);
  - recuperação;
  - banco sem resposta (`docker pause`, caminho do timeout);
  - banco parado.

  Em todos os cenários verifica que o payload não traz dados sensíveis e que o liveness continua 200.
- `test/integration/payment-execution/`: atomicidade (com falha real injetada no PostgreSQL), idempotência sequencial e paralela, concorrência (débitos disputando saldo e transferências cruzadas), isolamento entre dois workspaces, imutabilidade e equilíbrio do ledger, estorno (sequencial, paralelo e concorrente com transferências) e restrições do estorno e da conta por SQL direto. `test/integration/reconciliation.spec.ts` cobre a reconciliação, inclusive operações desequilibradas gravadas com as restrições desligadas só no teste, e `test/integration/migration-upgrade.spec.ts` aplica a migração do estorno sobre um banco separado que já tem dados no formato anterior. Cada teste cria seu próprio workspace, porque operações e lançamentos não podem ser apagados.

## Contrato com a interface web (Pact, DEV-021)

`test/contract/` verifica `pacts/finbank-v2-web-finbank-v2-api.json` (cópia versionada do `finbank-v2-web`) contra a aplicação real, com PostgreSQL real e sessões reais. O filtro de requisição troca o cookie e o token de exemplo pelos do contexto preparado. Remover ou renomear campo, ou trocar código de erro que a interface lê, faz a verificação falhar. Mudou o pacto: copie o arquivo da web e rode `npm run test:contract`. O binário nativo vem de dependência opcional, sem install script, e a telemetria do pacote fica desligada; sem suporte à plataforma, só este comando não roda.

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

## Identidade e vínculos (DEV-014 e DEV-015)

`src/identity/` responde se uma identidade acessa um workspace e com qual papel (`CUSTOMER` ou `FACILITATOR`), por meio de `WorkspaceAccessService.resolve(identityId, workspaceId)`:

- **Perfis:** `CUSTOMER` pertence a exatamente um workspace e só acessa o próprio; `FACILITATOR` é global e só acessa onde tem vínculo administrativo `ACTIVE`.
- **Nega por padrão:** a identidade precisa estar `ACTIVE`. Qualquer outro caso produz o mesmo `ACCESS_DENIED`, sem revelar o que existe.
- **Erros:** `INVALID_INPUT` (identificador que não é UUID em minúsculas; o banco não é consultado) e `ACCESS_CHECK_FAILED` (falha do banco, sem a causa original; nunca concede acesso).
- **Sem cache:** revogar um vínculo ou desativar uma identidade vale na consulta seguinte.
- **Não é autenticação:** quem chamar precisa fornecer uma identidade já autenticada.
- **E-mail (`domain/email.ts`):** sem espaços externos, em minúsculas, ASCII, até 254 caracteres; pontos e sufixos com `+` preservados. Único por workspace entre clientes e único entre facilitadores. O banco recusa a forma não normalizada.
- **Alias (`domain/workspace-alias.ts`):** opcional e único, 3 a 40 caracteres `a-z`, `0-9` ou hífen (sem hífen nas pontas). Localiza o workspace, não é credencial, e pode passar a outro workspace numa transação (liberar e depois atribuir).
- **Banco:** vínculo só para facilitador, um por par (workspace, identidade); identificador, perfil e workspace da identidade e identificador do workspace são imutáveis (`23001`); perfil, papel e estados sem valor padrão; a execução só lê, exceto o estado de clientes (DEV-019).

## Autenticação por HTTP (DEV-017)

Contrato completo: `GET /api/v1/openapi.json` (OpenAPI 3.1).

| Rota (`/api/v1/auth`) | Uso |
|---|---|
| `GET /csrf` | Token do contexto; sem sessão, cria o contexto pré-autenticado |
| `POST /customer/login` | `alias`, `email`, `password` |
| `POST /facilitator/login` | `email`, `password` |
| `GET /me` | Identidade, perfil, workspace e prazos |
| `POST /logout`, `POST /logout-all` | 204; removem os cookies |
| `POST /password/change` | `currentPassword`, `newPassword`; abre nova sessão |
| `POST /password/recovery` | `newPassword`; só na sessão restrita, abre sessão normal |

Uso com qualquer cliente que guarde cookies:

```sh
BASE=http://127.0.0.1:13000/api/v1/auth
curl -c jar -b jar $BASE/csrf                       # {"csrfToken":"..."}
curl -c jar -b jar -H 'X-CSRF-Token: <token>' -H 'Content-Type: application/json' \
  -d '{"email":"pessoa@example.test","password":"..."}' $BASE/facilitator/login
curl -b jar $BASE/me                                # use o novo csrfToken do login nos próximos POST
```

- **Cookies:** `__Host-finbank_session` e `__Host-finbank_preauth` (`HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/`, sem `Domain`). O segredo nunca vai no corpo. O modo é `COOKIE_TRANSPORT`: `secure` (padrão, exige HTTPS) ou `local-http` (sem `Secure` e sem prefixo; as rotas de autenticação só atendem `Host` de loopback).
- **CSRF:** todo `POST` exige `X-CSRF-Token` do contexto atual, inclusive o login. O token deriva do segredo do contexto e muda após login e troca de senha (ambos devolvem o novo). `Sec-Fetch-Site: cross-site` é recusado. Não há CORS.
- **Contexto:** uma identidade por contexto; novo login bem-sucedido encerra a sessão anterior do mesmo contexto. Contextos diferentes convivem. O contexto pré-autenticado não tem estado no servidor: depois do login, deixa de valer no contexto autenticado.
- **Limite de tentativas:** por login (perfil, alias e e-mail), exista ou não, e por identidade na troca de senha. A 5ª falha em 15 min restringe por 30 s; cada falha seguinte dobra, até 15 min. Durante a restrição a resposta é 429 com `Retry-After`, mesmo com senha correta. Sucesso zera. Não há bloqueio permanente nem limite por IP. Logins corretos paralelos são aceitos (até 50 em espera por login).
- **Erros:** Problem Details (RFC 9457) com `code` estável e `correlationId`; `X-Correlation-ID` válido (8 a 64 caracteres `A-Z a-z 0-9 . _ -`) é devolvido. Nunca repetem valores recebidos.
- **Entrada:** JSON UTF-8 sem compressão, até 10 KiB, com exatamente os campos do contrato.

Um ambiente novo não tem quem possa entrar: crie o acesso pela linha de comando do operador (veja Administração).

## Autorização por operação (DEV-018)

`src/access/` tem a guarda de todas as rotas. Cada rota declara a política com um decorador de `src/http/access-policy.ts`; **rota sem política é negada (403)** e acusada por teste.

| Rota (`/api/v1/facilitator`) | Uso |
|---|---|
| `GET /workspaces?limit=20&offset=0` | Workspaces com vínculo ativo do facilitador: `{ items, nextOffset }`; `limit` de 1 a 100 |
| `GET /workspaces/{workspaceId}` | Um workspace com vínculo ativo |

- **Ordem:** política, transporte e cookies, sessão (401), perfil (403), CSRF em métodos que alteram estado (403), workspace (404).
- **404:** workspace inexistente, sem vínculo, com vínculo revogado ou identificador malformado recebem a mesma resposta. Falha do banco é 503 e nunca concede acesso.
- **Sem cache:** vínculo, identidade e sessão são conferidos a cada requisição. O workspace vem só do caminho; cabeçalho, query e corpo não influenciam.
- **Rota nova com workspace:** use `{workspaceId}`, `@FacilitatorWorkspaceAccess()` e `@CurrentWorkspace()` (nunca `@Param`), e inclua-a na matriz de `test/integration/access/`. A guarda não cobre revogação concorrente: escritas devem reconferir o acesso na própria transação.

## Administração (DEV-019)

**Operador, por linha de comando** (`src/admin.ts`; no Compose, `scripts/admin.sh` do `finbank-v2-infra`). Não há endpoint nem identidade criada na subida.

```sh
npm run build
DATABASE_URL=<url do dono> npm run admin -- bootstrap --alias minha-turma --email facilitador@example.test
```

Comandos: `bootstrap`, `workspace create`, `facilitator create|disable|enable|reset`, `membership grant|revoke` e `customer create`. Sem argumentos, mostra o uso.

- Conecta como dono do esquema, porque a execução não cria identidades, credenciais, vínculos nem workspaces.
- A senha vem do terminal, sem eco e com confirmação, ou de uma linha da entrada padrão; nunca de argumento ou variável. Saída e erros não trazem senha, e-mail nem SQL.
- `bootstrap` é idempotente, não altera senha existente e não reverte desativação nem revogação. Saída: 0 sucesso ou sem mudança; 1 falha; 2 uso; 3 conflito.

**Facilitador, por HTTP** (`/api/v1/facilitator/workspaces/{workspaceId}`):

| Rota | Uso |
|---|---|
| `GET /customers` | `customerId`, `email` e `status`, paginados |
| `POST /customers/{customerId}/disable` | Desativa e encerra as sessões |
| `POST /customers/{customerId}/enable` | Reativa, sem restaurar sessões |

- Repetir devolve o mesmo estado. Cliente de outro workspace, inexistente ou malformado é o mesmo 404. O vínculo é reconferido na transação, com trava consultiva por facilitador.
- **Só o operador muda o estado de um facilitador**, também no banco (trigger).
- **Auditoria (`audit_record`):** ator, perfil, workspace, operação, recurso, resultado, instante real e correlação, na mesma transação da mudança; sem ela, a mudança não acontece. Só inserção, inclusive para o dono. Sem senha, e-mail ou segredo. Recusas não são registradas. Quem é dono do banco pode desligar triggers: a auditoria não protege contra o operador.

## Recuperação de acesso (DEV-020)

| Quem recupera | Como se emite |
|---|---|
| Cliente | Facilitador vinculado: `POST /api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/password-reset` |
| Facilitador | Operador: `facilitator reset --email` na linha de comando |

1. **Emitir** invalida na hora a senha e as sessões da pessoa, revoga a credencial anterior e mostra a nova **uma única vez** (100 bits, guardada só como Argon2id). Repetir emite outra.
2. A pessoa entra pelo **mesmo login**, com a credencial no campo `password`. O uso é único; expirada, usada ou revogada é recusada como qualquer credencial inválida. Desativada, a pessoa não entra; a credencial não é revogada.
3. A **sessão restrita** (`passwordChangeRequired: true`) só permite `csrf`, `me`, `logout`, `logout-all`, novo login e `password/recovery`. O resto, inclusive rota futura, recebe 403 `PASSWORD_CHANGE_REQUIRED`.
4. `POST /api/v1/auth/password/recovery` define a senha (diferente da credencial), encerra as sessões e abre uma normal. Abandonada a sessão restrita, é preciso nova emissão.

- 409 `IDENTITY_STATE_CONFLICT`: identidade desativada ou sem senha cadastrada.
- Emissão, uso, conclusão e toda troca de senha são auditados na mesma transação; se a auditoria falha, a operação não acontece.
- No banco, a execução só emite para clientes e não muda prazo, hash ou dono; credencial terminada não volta e o escopo da sessão é imutável.
- Quem emite vê a credencial: entregue-a só à pessoa.

## Senha e sessões (DEV-016)

`src/authentication/` oferece `AuthenticationService`: `loginCustomer` (alias, e-mail e senha), `loginFacilitator` (e-mail e senha), `validate`, `logout`, `logoutAll` e `changePassword`. Login e troca de senha só são expostos por `LimitedAuthenticationService`, que aplica o limite de tentativas.

- **Senha:** 12 a 128 caracteres (pontos de código), sem composição obrigatória; não é aparada, normalizada nem truncada. Persistida só como Argon2id do `node:crypto` (19 MiB, 2 passagens, paralelismo 1), em formato PHC com sal próprio.
- **Recusa de login:** sempre `INVALID_CREDENTIALS`, sem sessão. Sem credencial correspondente, executa a mesma verificação contra um hash fictício; isso reduz a diferença de tempo, sem prometer tempo idêntico.
- **Sessão:** segredo aleatório de 256 bits entregue uma vez; o banco guarda só o SHA-256. Cada `validate` renova a inatividade até o prazo absoluto. O relógio é sempre o do banco. O workspace do cliente vem da identidade: trocar o alias não move a sessão.
- **Estados terminais:** um trigger impede reativar sessão encerrada, renovar sessão expirada ou mudar seus dados de origem (`23001`).
- **Concorrência:** login, troca de senha, encerramento geral e desativação da identidade são serializados pela linha da credencial. Desativar encerra as sessões por trigger; reativar não as restaura.
- **Troca de senha:** exige sessão válida e senha atual; troca, encerra todas as sessões e abre uma nova na mesma transação.
- **Erros:** `INVALID_CREDENTIALS`, `SESSION_INVALID`, `SESSION_EXPIRED`, `PASSWORD_POLICY` e `AUTHENTICATION_FAILED`, sem valores recebidos nem causa original. O módulo não escreve logs.
- **Privilégios:** a execução lê e atualiza o hash da credencial, mas não cria credencial; na sessão, insere, lê e altera só atividade, prazo de inatividade e encerramento. Sessões antigas não são apagadas.

## Modos educacionais (DEV-006, DEV-022)

`src/education/` é domínio puro: não importa NestJS, HTTP nem Prisma, e não depende dos demais módulos. A persistência, o serviço e as rotas (DEV-023) ficam em `adapters/`, `application/` e `http/`. Os identificadores de defeito são opacos (`d-` + 16 hexadecimais) e não descrevem o defeito. Presets de laboratório são indexados pelo SHA-256 de um código de laboratório: o código nunca fica no repositório, e o hash não é autorização.

- **Padrão sem defeitos:** workspace sem configuração resolve `STUDENT` com preset `NONE`, revisão 0. `ALL` e `LAB` só valem escritos na alteração; `STUDENT` sem preset é rejeitado; `CONTROLLED` começa vazio.
- **Quem lê e altera:** o ator é o acesso confirmado pela autorização (`WorkspaceAccess`). Só `FACILITATOR` do próprio workspace lê ou altera, conferido antes de interpretar o conteúdo; `CUSTOMER` é recusado.
- **Catálogo (`defect-catalog.ts`):** versão `AAAA.MM.N`, lista pública de operações (`OPERATION_KEYS`, vazia até existirem casos de uso que as declarem) e, por defeito, operações afetadas e incompatibilidades simétricas. `validateCatalog` recusa o que estiver fora disso e presets com par incompatível. O catálogo vigente é **vazio**: zero defeitos executáveis.
- **Política (`educational-policy.ts`):** `affectsSecurity` nunca em `SHARED`; resultado na ordem do catálogo, imutável; combinação incompatível é rejeitada (sem precedência); cada alteração cria a revisão seguinte com a versão do catálogo; revisão criada com outra versão do catálogo não ativa nada (`stale`).
- **Por operação:** `isDefectActive(resolvida, operação, defeito, catálogo)` só é verdadeiro para defeito resolvido no workspace e declarado para a operação; operação desconhecida é erro.
- **Mensagens:** citam o campo e a regra, nunca o valor recebido, o código nem o hash.

**Configuração por workspace (DEV-023):** `GET` e `PATCH /api/v1/facilitator/workspaces/{workspaceId}/flags`, só para facilitador vinculado.

- Sem revisão gravada, vale a revisão 0 (`STUDENT`/`NONE`); consultar não grava. A resposta traz `revision`, `catalogVersion`, `stale`, `mode`, o tipo do preset, `enabledDefectIds`, `environment` e `availableDefectIds`.
- `PATCH` recebe `{ "baseRevision": n, "configuration": { ... } }`; `baseRevision` diferente da vigente é 409 `CONFIGURATION_CONFLICT`. Configuração recusada é 422 `EDUCATIONAL_CONFIG_INVALID`, sem detalhe; corpo fora do formato, 400.
- Cada alteração grava a revisão seguinte (tabela `educational_config_revision`, só inserção também para o dono) e a auditoria na mesma transação; o vínculo é reconferido nela. Grava-se o hash do código de laboratório, nunca o código, e a resposta mostra só `{ "kind": "LAB" }`.
- O ambiente vem de `FINBANK_ENVIRONMENT`. A revisão ainda não é consultada pelos casos de uso: isso entra com o primeiro defeito.

Os testes ficam em `test/unit/education/`, com catálogo e operações fictícios (`fixture-catalog.ts`) que só existem nos testes e não correspondem a nenhum laboratório.

## Execução financeira (DEV-010)

`src/payment-execution/` é o único caminho que altera saldos. Não há controller nem rota.

- `domain/`: centavos como `bigint` (o tipo `number` é rejeitado), positivos e limitados ao maior `BIGINT` do PostgreSQL (limite técnico, não de negócio); comando de movimentação validado sem coerção; par de lançamentos (débito negativo, crédito positivo) com soma zero; impressão digital SHA-256 do conteúdo; erros tipados com mensagens fixas, sem valores, identificadores ou chaves.
- `application/`: `PaymentExecutionService.openAccount` (saldo zero) e `execute`; a porta `PaymentExecutionStore` é uma unidade de trabalho transacional e toda a decisão financeira fica no serviço.
- `adapters/`: transação interativa do Prisma em `READ COMMITTED`. Ordem: registra a operação com `ON CONFLICT (workspace_id, operation_key) DO NOTHING` (chamadas concorrentes com a mesma chave esperam a primeira terminar); se a chave existe, compara a impressão digital e devolve o resultado original (`replayed: true`) ou `IDEMPOTENCY_CONFLICT`; trava as duas contas com `FOR NO KEY UPDATE` em ordem de id; grava os lançamentos e os dois saldos. Sem retry automático.
- **Contas:** `STANDARD` nunca fica negativa (`INSUFFICIENT_FUNDS`); `CONTRA` é a contrapartida única do workspace e pode ficar negativa, para financiar contas pelo próprio `execute`.
- **Workspace:** chave de escopo de dados, não autorização. Chaves estrangeiras compostas `(workspace_id, account_id)` impedem misturar workspaces; conta inexistente ou de outro workspace devolve o mesmo `ACCOUNT_NOT_FOUND`.
- **No banco:** `UPDATE`, `DELETE` e `TRUNCATE` em `payment_operation` e `ledger_entry` são rejeitados (SQLSTATE `23001`); um trigger adiado para o commit exige dois lançamentos por operação, com débito e crédito iguais ao valor; `CHECK`s cobrem valor positivo, contas distintas e saldo não negativo de `STANDARD`.
- Uma operação rejeitada não é registrada: a mesma chave pode ser usada numa nova tentativa.
- Fora deste módulo: reconciliação (`src/reconciliation/`), rotas, autenticação e PIX.

## Estados, crédito educacional e modalidade (DEV-024)

- **Estados:** workspace `ACTIVE`/`ARCHIVED` e conta `ACTIVE`/`BLOCKED` (a contrapartida nunca fica bloqueada). Toda movimentação (transferência, estorno, crédito) confere os dois dentro da transação: conta comum bloqueada em qualquer lado dá `ACCOUNT_BLOCKED`; workspace arquivado, `WORKSPACE_ARCHIVED`. Repetir uma operação já executada devolve o resultado original mesmo depois da mudança de estado, porque não movimenta nada.
- **Concorrência:** a movimentação toma a trava consultiva compartilhada `finbank:workspace:<id>` (o arquivamento deve pedir a exclusiva) e lê o estado da conta sob a trava de linha que já usa; bloqueio e arquivamento concorrentes ficam antes ou depois, nunca no meio.
- **Crédito educacional:** `PaymentExecutionService.credit({ workspaceId, operationKey, accountId, amountCents })` debita a contrapartida do workspace e credita a conta comum, tipo `EDUCATIONAL_CREDIT`, com idempotência própria (impressão digital versão 3). Não é estornável. Limites e autorização ficam com o caso de uso que o chamar. Sem contrapartida: `CONTRA_ACCOUNT_MISSING`; conta não comum: `ACCOUNT_NOT_ELIGIBLE`.
- **Modalidade:** `modality` opcional na transferência (`PIX_KEY`, `PIX_COPY_PASTE`, `PIX_QR_STATIC`), gravada e comparada pela idempotência (versão 4; sem modalidade, a versão 1 de sempre).
- **No banco:** lançamento em conta bloqueada ou workspace arquivado é recusado também para o dono; modalidade só em transferência; crédito só da contrapartida para conta comum. A execução não altera estado de conta nem de workspace.
- **Migração `20261130000000_payment_states_credit`:** aditiva; registros existentes ficam `ACTIVE` e as operações, sem modalidade.

## Relógio simulado (DEV-025)

`src/simulation-clock/`: data de negócio por workspace (`YYYY-MM-DD`), independente do tempo real e sem conversão de fuso.

- **Revisão 0:** sem revisão gravada, vale a data de criação do workspace no fuso `America/Sao_Paulo`, calculada pelo banco e nunca gravada.
- **Rotas:** `GET` e `PATCH /api/v1/facilitator/workspaces/{workspaceId}/clock`, só para facilitador vinculado. A resposta traz `workspaceId`, `date`, `revision` e `timeZone`.
- `PATCH` recebe `{ "baseRevision": n, "date": "YYYY-MM-DD" }`. Base diferente da vigente: 409 `CLOCK_CONFLICT`. Data inexistente, fora do formato ou fora de `2000-01-01`–`2099-12-31`: 422 `CLOCK_DATE_INVALID`, sem eco. Corpo fora do formato: 400. Workspace arquivado: 409 `WORKSPACE_ARCHIVED` (a consulta continua). Avançar e retroceder são aceitos, sem limite de passo; a mesma data vigente não grava nada.
- Cada alteração grava a revisão seguinte (tabela `simulation_clock_revision`, só inserção também para o dono) e a auditoria `SIMULATION_CLOCK_CHANGE` na mesma transação; o vínculo é reconferido nela, e a trava compartilhada `finbank:workspace:<id>` (`src/persistence/workspace-locks.ts`, a mesma da execução financeira) serializa com o futuro arquivamento.
- **Leitura por outros módulos:** `SimulationClockService.today(workspaceId)` devolve `{ date, revision }`; quem usar a data registra a revisão. Autenticação, sessões, credenciais temporárias, limite de tentativas e auditoria seguem o tempo real.

## Papéis no banco (DEV-012)

- **Dono do esquema:** aplica as migrações e é dono de todos os objetos. Só a migração e a linha de comando do operador o usam.
- **Usuário de execução:** a API conecta com ele (`DATABASE_URL`). É membro de `finbank_runtime`, não é dono de nenhum objeto e não é superusuário nem cria papéis ou bancos.
- **Privilégios de `finbank_runtime`:** `USAGE` no schema `public`; `SELECT` em `workspace`, `user_identity` e `workspace_membership`; `SELECT` e `INSERT` (sem `id` nem `created_at`) em `educational_config_revision` e `simulation_clock_revision`; `UPDATE` de `status` em `user_identity` (só clientes, por trigger); `INSERT` em `audit_record`, sem leitura e sem escolher identificador ou instante; `SELECT` e `INSERT` em `account`, `payment_operation` e `ledger_entry`; `SELECT` e `UPDATE` de `hash`, `updated_at` e `invalidated_at` em `password_credential`; em `temporary_credential`, `SELECT`, `INSERT` (só para clientes, por trigger) e `UPDATE` de `consumed_at` e `revoked_at`; `SELECT`, `INSERT` e `UPDATE` de `last_activity_at`, `idle_expires_at` e `revoked_at` em `user_session`; `SELECT`, `INSERT`, `DELETE` e `UPDATE` (exceto a chave) em `authentication_control`, única tabela em que pode apagar; em contas, `UPDATE` somente da coluna `account.balance_cents` (o que também habilita a trava de linha do PaymentExecution); nada em `_prisma_migrations`. Desligar triggers, DDL, `TRUNCATE`, alterar ou apagar operações e lançamentos, mudar `id`, `workspace_id` ou `kind` de conta, inserir workspace, criar identidades, mudar outros dados delas, escrever vínculos e mudar `session_replication_role` são recusados com SQLSTATE `42501`.
- **Provisionamento:** `scripts/provision-runtime-role.mjs` (sem dependências) roda depois de `prisma migrate deploy`, conectado como dono: valida `RUNTIME_DB_USER` e `RUNTIME_DB_PASSWORD`, calcula o verificador SCRAM-SHA-256 (a senha em texto não vai ao banco) e cria ou atualiza o usuário de forma idempotente. Um papel que já existe só é reaproveitado se não tiver atributos administrativos, não pertencer a nenhum papel além de `finbank_runtime`, não for dono de objetos e não tiver privilégios diretos neste banco; caso contrário, o provisionamento falha sem alterá-lo. O próprio dono também é recusado. O estágio `migrate` da imagem executa os dois passos em sequência.
- **Testes:** o `global-setup.ts` provisiona o usuário de execução com o mesmo script e fornece duas URLs. Serviços e bootstrap rodam pelo usuário de execução; o dono só prepara e inspeciona dados. `test/integration/runtime-privileges.spec.ts` verifica atributos, a matriz exata no catálogo e as recusas; `runtime-role-provisioning.spec.ts` verifica idempotência, troca de senha e recusas.
- **Desenvolvimento local:** o `.env` aponta `DATABASE_URL` para o usuário de execução, e o `prisma.config.ts` lê esse arquivo. Para `npm run prisma:migrate:deploy` e para o provisionamento, informe a URL do dono na linha de comando (exemplos no `.env.example`); com a URL de execução, a migração falha por falta de privilégio (`42501`).
- Continua possível: o usuário de execução altera `balance_cents` por SQL (necessário ao PaymentExecution); a reconciliação detecta a divergência.

## Estorno e reconciliação (DEV-011)

- **Estorno:** `PaymentExecutionService.reverse({ workspaceId, operationKey, originalOperationId })` grava uma nova operação `REVERSAL` vinculada, com as contas invertidas e o mesmo valor; a operação original e seus lançamentos não mudam. Somente estorno total, no máximo um por operação, e estorno de estorno é proibido (`NOT_REVERSIBLE`). A chave tem idempotência própria (impressão digital versão 2, que nunca coincide com a de uma transferência). Operação inexistente ou de outro workspace devolve `OPERATION_NOT_FOUND`; conta `STANDARD` sem saldo para devolver, `INSUFFICIENT_FUNDS`; operação já estornada por outra chave, `ALREADY_REVERSED`.
- **Registro:** `ON CONFLICT DO NOTHING` sem alvo cobre a chave e o vínculo único; sem linha inserida, o adaptador procura pela chave (repetição ou conflito) e depois pela operação de origem (já estornada).
- **No banco:** `CHECK` liga o tipo ao vínculo; chave estrangeira composta `(workspace_id, reverses_operation_id)`; índice único do vínculo; trigger confere que o estorno espelha uma `TRANSFER` do mesmo workspace (`23514`); trigger rejeita alterar `id`, `workspace_id` ou `kind` de uma conta (`23001`).
- **Reconciliação:** `src/reconciliation/` (`ReconciliationService.reconcile(workspaceId)`) compara, por workspace, o saldo gravado com a soma do ledger, o equilíbrio de cada operação e o total do workspace, e devolve um relatório com as divergências (`BALANCE_MISMATCH`, `UNBALANCED_OPERATION`, `WORKSPACE_TOTAL_NONZERO`). Lê em uma transação `REPEATABLE READ` somente leitura, sem travar as execuções; não corrige nada e não depende do PaymentExecution. Workspace inexistente devolve `WORKSPACE_NOT_FOUND`.
- O saldo materializado ainda pode ser alterado por SQL com privilégio de escrita; a reconciliação detecta a divergência, mas não a impede.

## Convenção de módulos

- `src/main.ts`: somente bootstrap (configuração, criação da aplicação, shutdown hooks, listen).
- `src/app.module.ts`: raiz de composição (`AppModule.forRoot(config)`); importa módulos, sem regras.
- `src/<módulo>/`: módulo NestJS. Controllers traduzem HTTP e delegam a serviços de caso de uso.
- `src/persistence/`: adaptador de infraestrutura; sem regras de negócio. Portas de repositório serão criadas quando houver caso de uso concreto.
- Quando houver regra de domínio, ela fica em código sem dependência de NestJS, HTTP ou Prisma; portas e adaptadores são criados somente quando houver necessidade concreta (sem pastas ou interfaces vazias).
- PaymentExecution (`src/payment-execution/`) é o único módulo autorizado a alterar saldos; `test/unit/architecture.spec.ts` falha se outro arquivo de `src/` escrever em contas, operações ou ledger. A reconciliação (`src/reconciliation/`) só lê.

## Imagem Docker (DEV-004)

`Dockerfile` multi-stage sobre `node:24.21.0-bookworm-slim`:

- `deps`: `npm ci` com dependências de desenvolvimento;
- `build`: `npm run build`;
- `migrate`: `prisma migrate deploy`, com o schema engine da plataforma baixado no build e `openssl`;
- `runtime`: `npm ci --omit=dev`, usuário `node`, `node dist/main.js`, porta 3000.

Nenhum segredo entra na imagem: `DATABASE_URL` é fornecida quando o container roda. O `.dockerignore` exclui `node_modules`, `dist`, `src/generated`, `test`, `.env` e Git. Orquestração em `../finbank-v2-infra`.
