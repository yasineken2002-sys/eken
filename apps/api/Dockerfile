FROM node:20-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ─── Dependencies ─────────────────────────────────────────────────────────────

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ─── Development ─────────────────────────────────────────────────────────────

FROM deps AS development
COPY . .
CMD ["pnpm", "--filter=@eken/api", "dev"]

# ─── Build ────────────────────────────────────────────────────────────────────

FROM deps AS builder
COPY . .
RUN pnpm --filter=@eken/api build

# ─── Production ──────────────────────────────────────────────────────────────

FROM node:20-alpine AS production
RUN corepack enable pnpm
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
CMD ["node", "dist/main"]
