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

# Personnummer-backfillen är BORTTAGEN härifrån. Den behövdes mellan expand- och
# contract-migrationen; nu finns klartextkolumnen inte kvar att backfilla, och
# contract-migrationen (20260728000000) vägrar själv köra om någon rad ändå
# skulle ha klartext kvar.

exec node /app/apps/api/dist/main.js
