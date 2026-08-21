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
# ── postgresql-client-18: PINNAD, OCH FELET GÅR ÅT ETT HÅLL ──────────────────
#
# pg_dump/pg_restore för det dagliga backup-jobbet, via PGDG-repot.
#
# RIKTNINGEN, som är hela skälet till pinnen: pg_dump som är ÄLDRE än servern
# VÄGRAR köra. Nyare klient mot äldre server går bra. Klientversionen måste
# alltså vara >= serverns — aldrig under.
#
#   pg_dump 16.15 → PG 18.4-server:
#     pg_dump: error: aborting because of server version mismatch
#     pg_dump: detail: server version: 18.4; pg_dump version: 16.15   (exit 1)
#   pg_dump 18    → PG 18.4-server:  exit 0
#
# Uppmätt 2026-08-21 mot en PG 18.4-probe, inte härlett ur dokumentationen.
#
# Railway-servern är PostgreSQL **18.4** (`18.4-1.pgdg13+1`), avläst samma dag
# med `select version()` över DATABASE_PUBLIC_URL.
#
# HÄR STOD `postgresql-client-16` FRAM TILL 2026-08-21, kvarlämnat sedan
# databasen var PG16. Backupen var avstängd hela tiden, så felet var osynligt:
# hade den slagits på hade den fallit varje natt utan att en rad kod var fel.
#
# SÄNK ALDRIG DEN HÄR SIFFRAN, och "städa" inte bort den för att den ser
# överflödig ut — den är ett golv, inte en exakt matchning. Uppgraderas servern
# till PG19 måste klienten upp FÖRST. Sänks den under serverns version slutar
# backupen fungera, inte delvis utan helt. BackupService har en förkontroll som
# fäller med ett läsbart meddelande om det ändå sker (`assertClientCanDumpServer`),
# så felet ska aldrig mer behöva läsas ur pg_dump:s egen text klockan tre på
# natten — men förkontrollen ersätter inte pinnen, den upptäcker att den brutits.
#
# PLUS Chrome-runtime-deps för den puppeteer-hanterade Chrome (ersätter det
# tidigare `chromium`-apt-paketet; libs:en är det som faktiskt behövs för att
# rendera headless — själva binären kommer från cachen nedan).
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
  && apt-get update && apt-get install -y postgresql-client-18 \
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
