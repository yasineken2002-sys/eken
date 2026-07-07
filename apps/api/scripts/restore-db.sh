#!/usr/bin/env bash
# Återställer en Eveno-databasbackup (pg_dump custom-format) till en mål-databas.
#
# Backuperna ligger i Cloudflare R2 under db-backups/ (se BackupService). Hämta
# önskad .dump-fil därifrån FÖRST (R2-dashboard eller rclone), och kör sedan:
#
#   ./restore-db.sh <dump-fil> <mål-DATABASE_URL>
#
# Exempel (till en NY, tom databas — återställ ALDRIG rakt över produktion utan
# att först ha en färsk backup och en medveten plan):
#   ./restore-db.sh eken-20260707T030512Z.dump \
#     "postgresql://user:pass@host:5432/eken_restore"
#
# Verifiera efteråt att radantal stämmer mot förväntan innan du växlar över.
set -euo pipefail

DUMP_FILE="${1:-}"
TARGET_URL="${2:-}"

if [[ -z "$DUMP_FILE" || -z "$TARGET_URL" ]]; then
  echo "Användning: $0 <dump-fil> <mål-DATABASE_URL>" >&2
  exit 1
fi
if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Dump-filen finns inte: $DUMP_FILE" >&2
  exit 1
fi

# Flytta lösenordet från connection-strängen till PGPASSWORD så det inte syns i
# `ps aux` under körning (samma mönster som BackupService.pgDump).
if [[ "$TARGET_URL" =~ ^([a-zA-Z]+)://([^:/@]+):([^@]+)@(.+)$ ]]; then
  export PGPASSWORD="${BASH_REMATCH[3]}"
  TARGET_URL="${BASH_REMATCH[1]}://${BASH_REMATCH[2]}@${BASH_REMATCH[4]}"
fi

echo "Återställer $DUMP_FILE → (mål-DB)"
echo "  (pg_restore --no-owner --no-privileges --clean --if-exists)"

# --clean --if-exists: droppar objekt före återskapande så en delvis fylld mål-DB
# inte ger krockar. --exit-on-error INTE satt: fortsätt vid ofarliga varningar
# (t.ex. saknade roller) — kontrollera slutrapporten manuellt.
pg_restore \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --dbname "$TARGET_URL" \
  "$DUMP_FILE"

echo "Klart. Verifiera radantal i nyckeltabeller (Invoice, JournalEntry, RentNotice)"
echo "innan du växlar över trafik."
