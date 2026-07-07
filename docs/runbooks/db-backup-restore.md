# Runbook: Databasbackup & återställning

Eveno tar **daglig full databasbackup** (`pg_dump` custom-format) och laddar upp den
till Cloudflare R2 (geografiskt separerat från Railway-databasen). Detta uppfyller
löftet i integritetspolicyn: _daglig säkerhetskopiering, 30 dagars retention,
geografiskt separerade kopior_.

## Hur det fungerar

- **Jobb:** `BackupService` + `BackupScheduler` (`apps/api/src/backup/`).
- **Schema:** `@Cron('0 3 * * *')` — varje natt 03:00 (serverns tidszon).
- **Steg:** `pg_dump -Fc --no-owner --no-privileges` → temp-fil → upp till R2 under
  `db-backups/eken-<UTC-tidsstämpel>.dump` → gallra backuper äldre än retention.
- **Fel:** loggas + rapporteras till Sentry. Nästa nattkörning försöker igen.

## Aktivering (produktion)

Jobbet är **avstängt** tills följande env-vars är satta (annars no-op):

| Env-var                                                  | Beskrivning                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `BACKUP_ENABLED`                                         | `true` för att aktivera nattjobbet                                                                     |
| `R2_BACKUP_BUCKET`                                       | **Krävs i prod:** dedikerad backup-bucket (dumpen = all PII, ska ej dela bucket med dokumentlagringen) |
| `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` | **Krävs i prod:** dedikerad, minimalt scopad R2-token (List/Get/Put/Delete enbart på backup-bucketen)  |
| `R2_BACKUP_ACCOUNT_ID`                                   | _(valfritt)_ annars `R2_ACCOUNT_ID`                                                                    |
| `BACKUP_RETENTION_DAYS`                                  | _(valfritt)_ standard 30                                                                               |
| `DATABASE_URL`                                           | redan satt                                                                                             |

> ⚠️ **Produktionskrav (säkerhet):** i `NODE_ENV=production` **blockeras** jobbet
> (loggar ett fel, kör inte) om det saknar dedikerad backup-token + bucket och
> skulle dela R2-kredential/bucket med dokumentlagringen. Skapa en separat R2 API-
> token scopad enbart till backup-bucketen så att en läckt dokumentlagrings-nyckel
> inte ger tillgång till hela databasdumpen. I dev faller det tillbaka till
> huvudnycklarna (`R2_ACCESS_KEY_ID` m.fl.).

`pg_dump`/`pg_restore` (postgresql-client-16) ligger i API-imagen (`apps/api/Dockerfile`).

## Verifiera att backuper skapas

Kolla API-loggen efter `[backup] OK db-backups/eken-… (… MB)` runt 03:00, eller
lista i R2-dashboarden under `db-backups/`. Programmatiskt: `BackupService.listBackups()`.

## Återställning

> ⚠️ Återställ **aldrig** rakt över produktion utan en färsk backup och en medveten
> plan. Återställ i första hand till en NY databas och växla över efter verifiering.

1. **Hämta** önskad `.dump` från R2 (`db-backups/`) — R2-dashboard eller `rclone`.
2. **Kör** restore-skriptet (kräver `postgresql-client-16`):

   ```bash
   apps/api/scripts/restore-db.sh eken-20260707T030512Z.dump \
     "postgresql://user:pass@host:5432/eken_restore"
   ```

   Skriptet kör `pg_restore --no-owner --no-privileges --clean --if-exists`.

3. **Verifiera** radantal i nyckeltabeller mot förväntan innan du växlar över:

   ```bash
   psql "$TARGET_URL" -tAc 'SELECT count(*) FROM "Invoice"'
   psql "$TARGET_URL" -tAc 'SELECT count(*) FROM "JournalEntry"'
   psql "$TARGET_URL" -tAc 'SELECT count(*) FROM "RentNotice"'
   ```

## Verifierad restore (bevis)

Round-trip testad lokalt: `pg_dump` av utvecklings-DB → `pg_restore` till en färsk
databas → alla 71 tabeller återställda, radantal identiska (Invoice/JournalEntry/
RentNotice). Kör om samma round-trip mot en R2-hämtad produktionsdump minst
kvartalsvis för att bevisa att backuperna är återställningsbara — en backup som
aldrig testats är ingen backup.
