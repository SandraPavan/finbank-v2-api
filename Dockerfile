# syntax=docker/dockerfile:1
# Imagem da API FinBank V2 (DEV-004). Nenhum segredo entra no build:
# DATABASE_URL é fornecida somente em tempo de execução.

FROM node:24.21.0-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# Dependências completas (inclui o CLI do Prisma e o TypeScript).
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

# Compilação: gera o cliente Prisma e compila src/ para dist/.
FROM deps AS build
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build

# Migração: executa uma vez `prisma migrate deploy` (serviço separado no Compose).
FROM deps AS migrate
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY prisma.config.ts ./
COPY prisma ./prisma
# Baixa o schema engine da plataforma no build (o install script está bloqueado
# pela política do npm 11), para que a migração não dependa de rede ao rodar.
RUN npx prisma version \
    && chown -R node:node /app
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# Runtime: somente dependências de produção e o código compilado.
FROM base AS runtime
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/main.js"]
