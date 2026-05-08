# syntax=docker/dockerfile:1.6
FROM node:20-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# This build context must contain both repos side by side.
# The app depends on shared packages from the upstream framework (agents/).
COPY agents/ agents/
COPY app/ app/

WORKDIR /repo/agents
RUN pnpm install --frozen-lockfile=false && pnpm --filter "./packages/*" build

WORKDIR /repo/app
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @counsel/assistant-client exec vite build
RUN pnpm --filter @counsel/assistant build

FROM node:20-bookworm-slim
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY --from=builder /repo/agents /repo/agents
COPY --from=builder /repo/app /repo/app

WORKDIR /repo/app/apps/counsel
ENV NODE_ENV=production
EXPOSE 17501
CMD ["node", "dist/index.js"]
