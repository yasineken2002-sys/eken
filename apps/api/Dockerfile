FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
RUN npm install -g pnpm

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN pnpm --filter=@eken/shared build 2>/dev/null || true
WORKDIR /app/apps/api
RUN npx prisma generate
RUN pnpm build

FROM node:20-alpine AS runner
RUN apk add --no-cache openssl chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
WORKDIR /app
RUN npm install -g pnpm
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
RUN mkdir -p /app/apps/api/uploads/logos
EXPOSE 3000
CMD ["sh", "-c", "cd /app/apps/api && npx prisma migrate deploy && exec node dist/main.js"]
