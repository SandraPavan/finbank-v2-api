# FinBank V2 — repositório filho

@../CLAUDE.md

Este repositório é público. Os caminhos `../` abaixo (import, rules e histórias) só existem no workspace interno da equipe; num clone isolado, siga o README.md.

Este diretório possui Git independente. Documentação oficial, regras e skills estão na coordenação, um nível acima. Não criar cópias locais do PRD ou backlog.

Antes de trabalhar, ler `../.claude/rules/` e a história solicitada em `../_bmad-output/implementation-artifacts/stories/`. Para descoberta consistente das skills compartilhadas, iniciar Claude na raiz da coordenação. Se a sessão foi aberta aqui, reabrir na raiz ou invocar a skill lendo seu caminho explicitamente; não presumir descoberta de catálogo entre repositórios.

Comandos Git e testes do componente executam neste diretório. Project-root do BMAD continua sendo a pasta pai, nunca instalar outra cópia aqui. Estado: DEV-001, DEV-003, DEV-005, DEV-006, DEV-010, DEV-011 e DEV-012 implementadas (bootstrap NestJS, composição de módulos, rotas técnicas `/health/live` e `/health/ready`, adaptador PostgreSQL/Prisma, contrato de domínio dos modos educacionais em `src/education/` com catálogo de defeitos vazio, núcleo de execução financeira com estorno compensatório em `src/payment-execution/` e reconciliação somente leitura em `src/reconciliation/`, sem rota; a API conecta por um usuário de execução com privilégios mínimos, provisionado por `scripts/provision-runtime-role.mjs`); ainda sem PIX, autenticação ou rotas financeiras. Testes de integração exigem Docker em execução. Antes de concluir mudanças, rodar `npm run verify` (lint com tipos, typecheck, unit, build). Versões e comandos no README.md.
