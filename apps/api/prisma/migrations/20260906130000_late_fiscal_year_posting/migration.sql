-- Sen bokföring i ett stängt räkenskapsår: händelsedatum + spår.
--
-- ── VARFÖR eventDate ÄR NULLBAR OCH INTE BACKFILLAS ─────────────────────────
--
-- `JournalEntry.date` gör i dag dubbel tjänst: bokföringsdatum OCH, i
-- normalfallet, affärshändelsens datum. De två går isär först när en post
-- flyttas, vilket ingen befintlig rad har blivit — det fanns ingen väg att
-- flytta en. För varje befintlig rad ÄR `date` alltså händelsedatumet, och
-- NULL betyder exakt det.
--
-- En backfill (`eventDate := date`) hade sett ut som ett arbete den inte
-- utförde och samtidigt gjort NULL tvetydigt för framtiden: efteråt hade
-- "eventDate = date" inte längre gått att skilja från "aldrig flyttad".
ALTER TABLE "JournalEntry" ADD COLUMN "eventDate" DATE;

-- ── SPÅRET ──────────────────────────────────────────────────────────────────
--
-- Append-only. Ingen updatedAt, och ingen raderingsväg: raden är beviset för
-- att verifikatets `date` avviker från `eventDate` med avsikt, och vem som
-- beslutade det (BFL 5 kap 7 § — sambandet ska kunna fastställas utan
-- svårighet).
CREATE TABLE "LateFiscalYearPosting" (
  "id"                 TEXT NOT NULL,
  "organizationId"     TEXT NOT NULL,
  "journalEntryId"     TEXT NOT NULL,
  "eventDate"          DATE NOT NULL,
  "bookedDate"         DATE NOT NULL,
  "closedFiscalYear"   INTEGER NOT NULL,
  "amount"             DECIMAL(10,2) NOT NULL,
  "materialityFlagged" BOOLEAN NOT NULL DEFAULT false,
  "reason"             TEXT NOT NULL,
  "actorType"          "EventActorType" NOT NULL,
  "actorUserId"        TEXT,
  "actorLabel"         TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LateFiscalYearPosting_pkey" PRIMARY KEY ("id")
);

-- Ett verifikat flyttas EN gång. Utan det här kunde två spår beskriva samma
-- post med olika skäl, och ingen av dem vara falsk.
CREATE UNIQUE INDEX "LateFiscalYearPosting_journalEntryId_key"
  ON "LateFiscalYearPosting"("journalEntryId");

CREATE INDEX "LateFiscalYearPosting_organizationId_closedFiscalYear_idx"
  ON "LateFiscalYearPosting"("organizationId", "closedFiscalYear");
CREATE INDEX "LateFiscalYearPosting_organizationId_materialityFlagged_idx"
  ON "LateFiscalYearPosting"("organizationId", "materialityFlagged");

-- Restrict genomgående: spåret får aldrig försvinna före posten det förklarar,
-- och inte med organisationen heller (räkenskapsinformation, sju år).
ALTER TABLE "LateFiscalYearPosting"
  ADD CONSTRAINT "LateFiscalYearPosting_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LateFiscalYearPosting"
  ADD CONSTRAINT "LateFiscalYearPosting_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LateFiscalYearPosting"
  ADD CONSTRAINT "LateFiscalYearPosting_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── SKRIVSPÄRR ──────────────────────────────────────────────────────────────
--
-- Återanvänder `append_only_guard()` från 20260828140000 — ingen egen
-- triggerfunktion. Två kopior av samma spärr är en spärr som glider isär, och
-- `check-append-only.mjs` håller mängderna "modeller som SÄGER append-only" och
-- "tabeller som HAR en trigger" lika.
--
-- SATSNIVÅ, inte radnivå: en FOR EACH ROW-trigger körs aldrig på en UPDATE som
-- inte matchar någon rad, och lyckas då tyst. Avsikten är "den här tabellen
-- uppdateras aldrig", inte "de här raderna".
--
-- BARA UPDATE. DELETE är med flit ospärrad, precis som för de åtta befintliga
-- tabellerna: `scripts/delete-organization.ts` måste kunna radera, och en full
-- spärr hade brutit den vägen — vilket hade upptäckts först vid en
-- GDPR-begäran. Se append-only.db.spec.ts, som kräver att DELETE fungerar.
--
-- ── RADNIVÅ, INTE SATSNIVÅ — OCH VARFÖR ─────────────────────────────────────
--
-- Tabellen tar emot en KASKAD-UPDATE: `actorUserId` har ON DELETE SET NULL mot
-- `User`, och SET NULL ÄR en UPDATE, utförd av databasen utan att appen vet om
-- det. Med satsspärren `append_only_guard()` föll varje radering av en användare
-- — uppmätt: elva sviter i shard 1/4 dog på
--
--     ERROR 23001: append-only: LateFiscalYearPosting får inte uppdateras
--       at prisma.user.deleteMany() — cron-error-sink-e2e.db.spec.ts:76
--
-- Exakt samma fälla som `AccountingPeriodEvent` och `TenantAnonymizationLog`
-- gick i (se 20260828140000, stycket "TVÅ TABELLER TAR EMOT EN KASKAD-UPDATE").
-- Den tredje tabellen får därför samma lösning och samma funktion — ingen ny
-- variant: `append_only_guard_actor` släpper igenom att aktörsreferensen nollas
-- och ingenting annat, jämfört på hela raden.
--
-- PRISET, samma som för de två andra: en radnivå-trigger fyrar inte på en UPDATE
-- som matchar noll rader, så `UPDATE … WHERE false` lyckas tyst. Satsen ändrar
-- ingenting, så priset är begreppsmässigt — men det ska stå skrivet.
CREATE TRIGGER append_only_late_fiscal_year_posting
  BEFORE UPDATE ON "LateFiscalYearPosting"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard_actor('actorUserId');

-- ── OCH DEN SOM FAKTISKT BÄR REGELN ─────────────────────────────────────────
--
-- Ett spår ska bara finnas för en post som verkligen flyttats, och en flyttad
-- post ska alltid ha sitt händelsedatum. Att spåret säger en sak och verifikatet
-- en annan är den enda formen av tyst fel som är värre än inget spår alls.
ALTER TABLE "LateFiscalYearPosting"
  ADD CONSTRAINT "LateFiscalYearPosting_flytt_framat"
  CHECK ("bookedDate" > "eventDate");
