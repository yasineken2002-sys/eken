#!/bin/sh
set -eu

log() { printf '[start] %s\n' "$*" >&2; }

log "container started, cwd=$(pwd)"
log "node=$(node --version) PORT=${PORT:-unset} DATABASE_URL_set=$([ -n "${DATABASE_URL:-}" ] && echo yes || echo no)"

cd /app/apps/api

PRISMA_BIN="/app/apps/api/node_modules/prisma/build/index.js"
if [ ! -f "$PRISMA_BIN" ]; then
  PRISMA_BIN="/app/node_modules/prisma/build/index.js"
fi
log "prisma binary: $PRISMA_BIN"

log "running prisma migrate deploy..."
node "$PRISMA_BIN" migrate deploy
log "migrations done"

# Krypterar kvarvarande klartext-personnummer (Tenant/Customer) innan appen tar
# trafik. Idempotent — utan rader att migrera är den en no-op. Misslyckas den
# stoppas deployen med flit (set -e): hellre ingen ny version än en som kör
# vidare med klartext i databasen.
log "running personnummer-backfill..."
node /app/apps/api/dist/scripts/backfill-personal-numbers.js
log "backfill done, launching node dist/main.js"

exec node /app/apps/api/dist/main.js
