-- FIX 9 · PR 4 — Gap-free, race-säker verifikationsnummer (LAGBROTT 6)
--
-- Bokföringslagen 5 kap 6 §: varje verifikation ska ha ett verifikationsnummer
-- i en obruten nummerföljd per serie och räkenskapsår. JournalEntry saknade
-- tidigare nummer helt. Denna migration:
--   1. inför räkenskapsår på Organization (kalenderår som default),
--   2. lägger fiscalYear/series/verNumber på JournalEntry,
--   3. backfillar befintliga poster till en obruten serie,
--   4. inför sekvenstabeller för atomär, race-säker nummertilldelning,
--   5. inför fakturanummersekvens (ML 11 kap 8 §),
--   6. hårdgör idempotensen (unikt index på source+sourceId) och gör
--      konteringsrader oraderbara (onDelete Restrict).
--
-- Kolumnerna fiscalYear/verNumber läggs NULLABLE först, backfillas, och sätts
-- därefter NOT NULL — annars skulle ADD COLUMN NOT NULL fela på befintliga rader.

-- ── 1. Räkenskapsårets startmånad (1 = kalenderår, BFL 3 kap 1 §) ───────────
ALTER TABLE "Organization" ADD COLUMN "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1;

-- ── 2. Verifikationsnummer-kolumner (nullable först) ────────────────────────
ALTER TABLE "JournalEntry" ADD COLUMN "fiscalYear" INTEGER;
ALTER TABLE "JournalEntry" ADD COLUMN "series" TEXT NOT NULL DEFAULT 'A';
ALTER TABLE "JournalEntry" ADD COLUMN "verNumber" INTEGER;

-- ── 3. Sekvenstabeller ──────────────────────────────────────────────────────
CREATE TABLE "JournalEntrySequence" (
    "organizationId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'A',
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntrySequence_pkey" PRIMARY KEY ("organizationId","fiscalYear","series")
);

CREATE TABLE "InvoiceNumberSequence" (
    "organizationId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceNumberSequence_pkey" PRIMARY KEY ("organizationId")
);

-- ── 4. Backfill av räkenskapsår för befintliga poster ───────────────────────
-- Räkenskapsår härleds ur date + Organization.fiscalYearStartMonth: om postens
-- månad är före startmånaden hör posten till föregående kalenderår.
UPDATE "JournalEntry" je
SET "fiscalYear" = CASE
    WHEN EXTRACT(MONTH FROM je."date")::int < o."fiscalYearStartMonth"
        THEN EXTRACT(YEAR FROM je."date")::int - 1
    ELSE EXTRACT(YEAR FROM je."date")::int
END
FROM "Organization" o
WHERE je."organizationId" = o."id";

-- ── 5. Retroaktiv verifikationsnummertilldelning för befintlig data ─────────
-- Nummerordningen approximeras via (date, createdAt, id) och ger en obruten
-- serie utan hål. Retroaktiv tilldelning är försvarbar enligt god redovisningssed
-- (BFL 4 kap 2 §): systemet saknade verifikationsnummer före denna migration, så
-- det finns inga tidigare lagstadgade nummer att korrigera mot.
WITH numbered AS (
    SELECT "id",
           ROW_NUMBER() OVER (
               PARTITION BY "organizationId", "fiscalYear", "series"
               ORDER BY "date", "createdAt", "id"
           ) AS rn
    FROM "JournalEntry"
)
UPDATE "JournalEntry" je
SET "verNumber" = n.rn
FROM numbered n
WHERE je."id" = n."id";

-- ── 6. Initiera sekvensräknarna ─────────────────────────────────────────────
-- JournalEntrySequence: nästa nummer fortsätter efter högsta tilldelade.
INSERT INTO "JournalEntrySequence" ("organizationId","fiscalYear","series","lastNumber","updatedAt")
SELECT "organizationId","fiscalYear","series", MAX("verNumber"), NOW()
FROM "JournalEntry"
GROUP BY "organizationId","fiscalYear","series";

-- InvoiceNumberSequence: lastNumber = antal fakturor per org. Matchar den
-- tidigare count()+1-logiken exakt så att nästa fakturanummer fortsätter
-- sömlöst utan kollision mot befintliga F-{år}-{nr}.
INSERT INTO "InvoiceNumberSequence" ("organizationId","lastNumber","updatedAt")
SELECT "organizationId", COUNT(*), NOW()
FROM "Invoice"
GROUP BY "organizationId";

-- ── 7. Sätt NOT NULL nu när all data är backfilld ───────────────────────────
ALTER TABLE "JournalEntry" ALTER COLUMN "fiscalYear" SET NOT NULL;
ALTER TABLE "JournalEntry" ALTER COLUMN "verNumber" SET NOT NULL;

-- ── 8. Index + unika constraints ────────────────────────────────────────────
CREATE INDEX "JournalEntry_organizationId_fiscalYear_idx" ON "JournalEntry"("organizationId", "fiscalYear");
CREATE UNIQUE INDEX "JournalEntry_organizationId_series_fiscalYear_verNumber_key" ON "JournalEntry"("organizationId", "series", "fiscalYear", "verNumber");
-- Idempotens på DB-nivå. Postgres behandlar NULL som distinkt, så manuella
-- poster (sourceId = NULL) tillåts i flera exemplar; automatiska poster med
-- sourceId kan bara bokföras en gång.
-- Säkerhetsspärr: om en gammal körning (innan idempotensindexet fanns) hann
-- skapa dubbletter av samma (source, sourceId) skulle CREATE UNIQUE INDEX faila
-- mitt i migrationen. Avbryt då tydligt i stället för en kryptisk indexkrasch —
-- dubbletterna måste avdupliceras manuellt (append-only: via motverifikat, inte
-- radering) innan migrationen körs om.
DO $$
DECLARE dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "organizationId", "source", "sourceId"
    FROM "JournalEntry"
    WHERE "sourceId" IS NOT NULL
    GROUP BY "organizationId", "source", "sourceId"
    HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Migration avbruten: % dubbletter av (organizationId, source, sourceId) finns i JournalEntry. Avduplicera innan migrationen körs om.', dup_count;
  END IF;
END $$;
CREATE UNIQUE INDEX "JournalEntry_organizationId_source_sourceId_key" ON "JournalEntry"("organizationId", "source", "sourceId");

-- ── 9. Foreign keys för sekvenstabellerna ───────────────────────────────────
ALTER TABLE "JournalEntrySequence" ADD CONSTRAINT "JournalEntrySequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceNumberSequence" ADD CONSTRAINT "InvoiceNumberSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 10. Konteringsrader oraderbara: Cascade → Restrict ──────────────────────
-- JournalEntryLine är räkenskapsinformation (BFL 1 kap 2 § p.9, 5 kap 6 §).
-- Append-only: rättelse sker via motverifikat, aldrig radering.
ALTER TABLE "JournalEntryLine" DROP CONSTRAINT "JournalEntryLine_journalEntryId_fkey";
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
