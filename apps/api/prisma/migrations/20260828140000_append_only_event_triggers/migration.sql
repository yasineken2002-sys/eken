-- APPEND-ONLY BLIR EN DATABASINVARIANT I STÄLLET FÖR EN VANA.
--
-- ── VAD SOM MÄTTES ──────────────────────────────────────────────────────────
--
-- Red team-revisionen prövade egenskapen mot en riktig PG 18.6:
--
--     UPDATE "InvoiceEvent" SET type='UPDATED' WHERE id=…   → LYCKADES
--     DELETE FROM "InvoiceEvent" WHERE id=…                 → LYCKADES
--
-- Koden var ren — noll `invoiceEvent.update/delete` i apps/api/src — men
-- egenskapen fanns bara i vanan hos den som skrev koden. Ett revisionsspår som
-- GÅR att ändra är inget revisionsspår när någon frågar, och en agentisk
-- plattform är en maskin för att skapa nya skribenter.
--
-- ── VARFÖR TRIGGER OCH INTE REVOKE (mätt, inte valt) ────────────────────────
--
-- Den självklara mekanismen vore `REVOKE UPDATE ON … FROM <approll>`. Den är
-- VERKNINGSLÖS här, och det är mätt mot prod:
--
--     ansluten som : postgres  (session_user: postgres)
--     superuser    : true
--     tabellägare  : postgres  (alla 88 tabeller)
--
-- Appen är alltså både ÄGARE och SUPERUSER. `REVOKE` gäller inte ägaren, och en
-- superuser förbigår rättighetskontrollen helt. En REVOKE-migration hade gått
-- igenom, sett rätt ut i diffen och skyddat exakt ingenting — den farligaste
-- sortens åtgärd.
--
-- Prövat sida vid sida mot ett kluster i SAMMA läge (ägande superuser):
--
--     REVOKE UPDATE mot ägaren  → UPDATE LYCKADES   (spärren biter inte)
--     BEFORE UPDATE-trigger     → UPDATE AVVISADES  (triggern biter)
--
-- ── VAD SPÄRREN INTE ÄR ─────────────────────────────────────────────────────
--
-- En trigger stoppar inte den som VILL komma förbi: en superuser kan köra
-- `ALTER TABLE … DISABLE TRIGGER` eller sätta `session_replication_role =
-- 'replica'`. Det är avsikten. Spärren flyttar UPDATE från "kan ske av misstag,
-- i vilken kodväg som helst" till "kräver ett uttryckligt, loggbart ingrepp".
-- Den påstår inte mer än så.
--
-- ── DELETE ÄR INTE SPÄRRAD, OCH DET ÄR MÄTT ─────────────────────────────────
--
-- En full spärr hade brutit organisationsraderingen — och det hade upptäckts
-- först vid en GDPR-begäran, alltså på värsta tänkbara sätt.
-- `scripts/delete-organization.ts` raderar uttryckligen fem av tabellerna
-- nedan (RentNoticeCredit:66, RentNoticeEvent:74, SignatureEvidence:88,
-- InvoiceEvent:97, AccountingPeriodEvent:133), och AI-retentionen gallrar
-- andra loggar på schema.
--
-- UPDATE däremot görs ALDRIG: mätt över hela apps/api/src bär ingen av de åtta
-- tabellerna ett enda `.update`, `.updateMany` eller `.upsert`.
--
-- En halv spärr som är sann är värd mer än en hel som måste kringgås. Behöver
-- DELETE spärras senare är rätt väg en egen roll utan DELETE — inte att bygga
-- undantag i den här triggern.
--
-- ── TVÅ TABELLER TAR EMOT EN KASKAD-UPDATE (mätt, och den bröt raderingen) ──
--
-- `ON DELETE SET NULL` är en UPDATE på barnraden, utförd av databasen utan att
-- applikationen vet om det. Två av de åtta tar emot en sådan:
--
--     AccountingPeriodEvent.actorUserId   ← User  ON DELETE SET NULL
--     TenantAnonymizationLog.performedById ← User ON DELETE SET NULL
--
-- Med en ren satsspärr faller organisationsraderingen. Uppmätt genom att köra
-- den RIKTIGA `deleteOrganizations()` mot en riktig Postgres med spärren aktiv:
--
--     ERROR 23001: append-only: AccountingPeriodEvent får inte uppdateras
--       at tx.organization.deleteMany() — delete-organization.ts:189
--
-- Det hade upptäckts först vid en GDPR-begäran, alltså på värsta tänkbara sätt.
--
-- De två får därför en RADNIVÅ-trigger som släpper igenom EXAKT en förändring:
-- aktörsreferensen som nollas, och ingenting annat. Jämförelsen görs på hela
-- raden (`to_jsonb(NEW) - kolumnen = to_jsonb(OLD) - kolumnen`), så en UPDATE
-- som passar på att ändra något mer avvisas.
--
-- PRISET: en radnivå-trigger fyrar inte på en UPDATE som matchar NOLL rader.
-- `UPDATE … WHERE false` lyckas alltså tyst på de två tabellerna. Den satsen
-- ändrar ingenting, så priset är begreppsmässigt och inte praktiskt — men det
-- ska stå skrivet, inte upptäckas.
--
-- ── VILKA TABELLER, OCH VARFÖR JUST DE ──────────────────────────────────────
--
-- Mängden är härledd TVÅ gånger och de två svaren är identiska:
--
--   1. modeller vars docblock i schema.prisma SÄGER append-only  → 8
--   2. modeller som koden aldrig uppdaterar                       → samma 8
--
-- Ett svar hade varit ett påstående. Två oberoende härledningar som pekar på
-- samma mängd är en mätning.
--
-- ── OM NÅGON TAR BORT DEN ───────────────────────────────────────────────────
--
-- `check-append-only.mjs` fäller: mängden triggrar i migrationerna måste vara
-- exakt mängden modeller som säger append-only i schemat, åt BÅDA hållen.
-- `append-only.db.spec.ts` prövar dessutom mot en RIKTIG databas att en UPDATE
-- faktiskt avvisas — att spärren står i en migration är inte samma sak som att
-- den gäller.

-- ── FOR EACH STATEMENT, INTE FOR EACH ROW (mätt) ────────────────────────────
--
-- Första versionen var radnivå. En `UPDATE` som matchar NOLL rader fyrar då
-- aldrig triggern och lyckas tyst — uppmätt när spec:en prövade en tom tabell
-- och `UPDATE` gick igenom utan invändning.
--
-- Satsnivå avvisar SATSEN, oavsett hur många rader den skulle ha rört. Det är
-- också den rätta semantiken: avsikten är "den här tabellen uppdateras aldrig",
-- inte "de här raderna uppdateras aldrig".

CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'append-only: % får inte uppdateras. Rätta genom att lägga en NY rad.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = 'Spärren bor i databasen därför att den inte kan bo i '
                 'applikationen: REVOKE gäller inte tabellägaren, och appen '
                 'ansluter som ägare och superuser. Se migrationen '
                 '20260828140000_append_only_event_triggers.';
END $$;

CREATE TRIGGER append_only_failed_email
  BEFORE UPDATE ON "FailedEmail"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER append_only_invoice_event
  BEFORE UPDATE ON "InvoiceEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER append_only_pii_secret_rotation
  BEFORE UPDATE ON "PiiSecretRotation"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER append_only_rent_notice_credit
  BEFORE UPDATE ON "RentNoticeCredit"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER append_only_rent_notice_event
  BEFORE UPDATE ON "RentNoticeEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER append_only_signature_evidence
  BEFORE UPDATE ON "SignatureEvidence"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

-- ── De två som tar emot en GDPR-kaskad ──────────────────────────────────────
--
-- Släpper igenom att aktörsreferensen nollas när användaren raderas, och
-- ingenting annat. Allt annat avvisas med samma meddelande som satsspärren.

-- Triggerfunktioner kan inte ha deklarerade parametrar — kolumnnamnet kommer in
-- via TG_ARGV. (Första versionen skrev `(kolumn text)` och plpgsql svarade
-- "function append_only_guard_actor() does not exist".)
CREATE OR REPLACE FUNCTION append_only_guard_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE kolumn text := TG_ARGV[0]; gammal jsonb; ny jsonb;
BEGIN
  gammal := to_jsonb(OLD) - kolumn;
  ny := to_jsonb(NEW) - kolumn;
  IF to_jsonb(NEW) ->> kolumn IS NULL
     AND to_jsonb(OLD) ->> kolumn IS NOT NULL
     AND ny = gammal THEN
    RETURN NEW;  -- ON DELETE SET NULL från User: tillåten, och bara den.
  END IF;
  RAISE EXCEPTION
    'append-only: % får inte uppdateras. Rätta genom att lägga en NY rad.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation',
          HINT = 'Endast databasens egen ON DELETE SET NULL av aktörsreferensen '
                 'släpps igenom. Se migrationen '
                 '20260828140000_append_only_event_triggers.';
END $$;

CREATE TRIGGER append_only_accounting_period_event
  BEFORE UPDATE ON "AccountingPeriodEvent"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard_actor('actorUserId');

CREATE TRIGGER append_only_tenant_anonymization_log
  BEFORE UPDATE ON "TenantAnonymizationLog"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard_actor('performedById');
