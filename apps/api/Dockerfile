FROM node:20-slim AS base
RUN apt-get update && apt-get install -y \
  openssl \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
# Puppeteer ska INTE ladda ner Chrome under `pnpm install` (deps-steget). Chrome
# installeras istället explicit i builder-steget till en cache-katalog som kopieras
# till runnern — så att browser-versionen pinnas av puppeteer-versionen (24.40) och
# INTE kan drifta som den opinnade apt-chromium gjorde (#169-regressionen).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY . .
# @eken/shared beror på @eken/ui (brandfärgens sanning, EVENO_BRAND). Bygg ui
# FÖRST så att sharedens CJS-runtime-require('@eken/ui') hittar dist/cjs vid drift.
RUN pnpm --filter=@eken/ui build
RUN pnpm --filter=@eken/shared build
WORKDIR /app/apps/api
RUN npx prisma generate
RUN cd /app && pnpm --filter=@eken/api build
# Installera EXAKT den Chrome som puppeteer@24.40 pinnar, till en stabil cache-
# katalog. `browsers install` ignorerar SKIP-flaggan ovan. Reproducerbart: samma
# puppeteer-version → samma Chrome-buildId, varje bygge.
RUN PUPPETEER_CACHE_DIR=/app/.cache/puppeteer npx puppeteer browsers install chrome

FROM node:20-slim AS runner
# postgresql-client-16 (matchar Railway PG16-servern) för pg_dump/pg_restore i den
# dagliga backup-jobbet — via PGDG-repot. PLUS Chrome-runtime-deps för den puppeteer-
# hanterade Chrome (ersätter det tidigare `chromium`-apt-paketet; libs:en är det som
# faktiskt behövs för att rendera headless — själva binären kommer från cachen nedan).
RUN apt-get update && apt-get install -y \
  openssl \
  ca-certificates \
  gnupg \
  wget \
  fonts-freefont-ttf \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libatspi2.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libexpat1 \
  libgbm1 \
  libglib2.0-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libx11-6 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  && install -d /usr/share/postgresql-common/pgdg \
  && wget -qO /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer hittar sin Chrome i cache-katalogen (samma path som builder installerade
# till). INGEN PUPPETEER_EXECUTABLE_PATH → puppeteer använder sin egen pinnade Chrome,
# inte en opinnad system-binär.
ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

WORKDIR /app
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/apps/api/scripts ./apps/api/scripts
# Den pinnade Chrome-binären (nedladdad i builder-steget).
COPY --from=builder /app/.cache/puppeteer /app/.cache/puppeteer
RUN mkdir -p /app/apps/api/uploads/logos && chmod +x /app/apps/api/scripts/migrate-and-start.sh

EXPOSE 8080
CMD ["/app/apps/api/scripts/migrate-and-start.sh"]
