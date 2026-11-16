# FinBank V2 — repositório filho

@../CLAUDE.md

Este diretório possui Git independente. Documentação oficial, regras e skills estão na coordenação, um nível acima. Não criar cópias locais do PRD ou backlog.

Antes de trabalhar, ler `../.claude/rules/` e a história solicitada em `../_bmad-output/implementation-artifacts/stories/`. Para descoberta consistente das skills compartilhadas, iniciar Claude na raiz da coordenação. Se a sessão foi aberta aqui, reabrir na raiz ou invocar a skill lendo seu caminho explicitamente; não presumir descoberta de catálogo entre repositórios.

Comandos Git e testes do componente executam neste diretório. Project-root do BMAD continua sendo a pasta pai, nunca instalar outra cópia aqui. Estado: DEV-001, DEV-003 e DEV-005 implementadas (bootstrap NestJS, composição de módulos, rotas técnicas `/health/live` e `/health/ready`, adaptador PostgreSQL/Prisma sem modelos e contrato de domínio dos modos educacionais em `src/education/`, com catálogo de defeitos vazio); ainda sem domínio, tabelas financeiras, autenticação ou rotas financeiras. Testes de integração exigem Docker em execução. Antes de concluir mudanças, rodar `npm run verify` (lint com tipos, typecheck, unit, build). Versões e comandos no README.md.
