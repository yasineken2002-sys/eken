#!/bin/sh
# bootstrap.sh — the FIXED start command.
#
#   transport -> verify package hashes -> run gate (verify only) -> real exec
#
# It carries the expected hashes of gate.js and manifest.json literally, so a
# swapped or truncated transport is caught before the tool runs. It never evals
# anything it reads: the two configuration values are decoded to files and
# hashed, never executed as shell.
#
# The target is chosen by a fixed case statement. Mode is the only input and is
# matched against literals; nothing from the environment becomes a command.
set -eu

TOOL_SHA=@TOOL_SHA@
MAN_SHA=@MAN_SHA@

MODE=${1:-}
case "$MODE" in
  migrator|app|selftest) : ;;
  *) echo "BOOT_FAIL unknown_mode $MODE" >&2; exit 30 ;;
esac

[ -n "${GATE_TOOL_B64:-}" ]     || { echo "BOOT_FAIL tool_value_missing" >&2; exit 31; }
[ -n "${GATE_MANIFEST_B64:-}" ] || { echo "BOOT_FAIL manifest_value_missing" >&2; exit 31; }

D=$(mktemp -d) || { echo "BOOT_FAIL tempdir" >&2; exit 32; }
chmod 700 "$D"

printf '%s' "$GATE_TOOL_B64"     | base64 -d > "$D/gate.js"       2>/dev/null || { rm -rf "$D"; echo "BOOT_FAIL tool_decode" >&2; exit 33; }
printf '%s' "$GATE_MANIFEST_B64" | base64 -d > "$D/manifest.json" 2>/dev/null || { rm -rf "$D"; echo "BOOT_FAIL manifest_decode" >&2; exit 33; }

GOT_TOOL=$(sha256sum "$D/gate.js" | cut -d' ' -f1)
GOT_MAN=$(sha256sum "$D/manifest.json" | cut -d' ' -f1)
[ "$GOT_TOOL" = "$TOOL_SHA" ] || { rm -rf "$D"; echo "BOOT_FAIL tool_hash_mismatch got=$GOT_TOOL" >&2; exit 34; }
[ "$GOT_MAN"  = "$MAN_SHA"  ] || { rm -rf "$D"; echo "BOOT_FAIL manifest_hash_mismatch got=$GOT_MAN" >&2; exit 35; }

# Gate verifies and exits. Its non-zero status stops us before any exec.
# NOTE: `if ! cmd; then RC=$?` would capture the NEGATION's status, not the
# command's, and would report rc=0 for every rejection. Capture it directly.
RC=0
node "$D/gate.js" --mode "$MODE" --manifest "$D/manifest.json" --manifest-sha256 "$MAN_SHA" || RC=$?
if [ "$RC" -ne 0 ]; then
  rm -rf "$D"
  echo "BOOT_STOP gate_rejected rc=$RC" >&2
  exit "$RC"
fi

rm -rf "$D"          # nothing of the tool survives into the target process

cd /app/apps/api
case "$MODE" in
  migrator) exec /usr/local/bin/node /app/apps/api/node_modules/prisma/build/index.js migrate deploy ;;
  app)      exec /app/apps/api/scripts/migrate-and-start.sh ;;
  selftest) exec /fixtures/target.sh ;;
esac
echo "BOOT_FAIL exec_fell_through" >&2
exit 36
