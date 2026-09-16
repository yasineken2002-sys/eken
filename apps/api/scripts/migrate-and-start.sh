#!/bin/sh
set -eu

log() { printf '[start] %s\n' "$*" >&2; }

log "container started, cwd=$(pwd)"
log "node=$(node --version) PORT=${PORT:-unset} DATABASE_URL_set=$([ -n "${DATABASE_URL:-}" ] && echo yes || echo no)"

cd /app/apps/api

# Appstart och omstart får aldrig migrera. Migrering körs separat, en gång,
# genom identitetsgrindens fasta migrator-kommando med restartPolicyType=NEVER.
# Filnamnet behålls eftersom Dockerfile och det godkända grindpaketet pekar hit.
# exec bevarar PID och signalvägen till Nest (inklusive dess shutdown hooks).

exec node /app/apps/api/dist/main.js
