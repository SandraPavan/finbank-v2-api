# FinBank V2 — repositório filho

@../CLAUDE.md

Este diretório possui Git independente. Documentação oficial, regras e skills estão na coordenação, um nível acima. Não criar cópias locais do PRD ou backlog.

Antes de trabalhar, ler `../.claude/rules/` e a história solicitada em `../_bmad-output/implementation-artifacts/stories/`. Para descoberta consistente das skills compartilhadas, iniciar Claude na raiz da coordenação. Se a sessão foi aberta aqui, reabrir na raiz ou invocar a skill lendo seu caminho explicitamente; não presumir descoberta de catálogo entre repositórios.

Comandos Git e testes do componente executam neste diretório. Project-root do BMAD continua sendo a pasta pai, nunca instalar outra cópia aqui. Estado: DEV-001 e DEV-003 implementadas (bootstrap NestJS, composição de módulos, rota técnica `/health` e adaptador PostgreSQL/Prisma sem modelos); ainda sem domínio, tabelas financeiras, autenticação ou rotas financeiras. Testes de integração exigem Docker em execução. Versões e comandos no README.md.
