# finbank-v2-api

API NestJS/TypeScript do FinBank V2 (monólito modular, arquitetura hexagonal pragmática). Documentação oficial, regras e histórias ficam na coordenação (`../_bmad-output/`, `../.claude/rules/`).

Estado atual (DEV-001): somente bootstrap, composição de módulos e um módulo técnico `health`. Sem domínio, persistência, autenticação, worker ou rotas financeiras.

## Runtime e versões (PD-02, resolvida na DEV-001)

| Item | Versão |
|---|---|
| Node.js | 24.21.0 (`.nvmrc`; `engines: >=24.12.0 <25`) |
| npm | 11.19.0 (`packageManager`), lockfile versionado |
| Módulos | ESM (`"type": "module"`, `nodenext`); imports relativos com sufixo `.js` |
| NestJS | 12.4.2 (`common`, `core`, `platform-express`, `testing`) |
| TypeScript | 6.0.3 |
| Vitest | 4.1.12 |

Dependências são fixadas com versão exata (`.npmrc`: `save-exact=true`, `engine-strict=true`). Atualizações exigem verificação de compatibilidade e registro em história.

## Comandos

```sh
npm ci              # instala exatamente o lockfile
npm run typecheck   # tsc --noEmit (src + test)
npm run build       # compila src/ para dist/
npm start           # node dist/main.js (requer build)
npm test            # vitest run
```

Configuração por ambiente:

| Variável | Padrão | Regra |
|---|---|---|
| `PORT` | `3000` | Inteiro de 1 a 65535; valor inválido encerra com código 1 e mensagem sem coerção silenciosa |

Rota técnica: `GET /health` → `{"status":"ok"}` (liveness apenas; não verifica dependências).

## Convenção de módulos

- `src/main.ts`: somente bootstrap (configuração, criação da aplicação, shutdown hooks, listen).
- `src/app.module.ts`: raiz de composição; importa módulos, sem regras.
- `src/<módulo>/`: módulo NestJS. Controllers traduzem HTTP e delegam a serviços de caso de uso.
- Quando houver regra de domínio, ela fica em código sem dependência de NestJS, HTTP ou Prisma; portas e adaptadores são criados somente quando houver necessidade concreta (sem pastas ou interfaces vazias).
- PaymentExecution será o único módulo autorizado a alterar saldos (ver arquitetura na coordenação).
