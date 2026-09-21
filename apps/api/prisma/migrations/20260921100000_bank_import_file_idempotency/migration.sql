-- FILNIVÅNS IDEMPOTENS I BANKIMPORTEN (#F034b)
--
-- Basen (661e79e6) bar luckan skriven i klartext vid sin egen fält-dedup i
-- `reconciliation.service.ts`:
--
--   "Läs-sedan-skriv utan unikt index: två PARALLELLA importer av samma fil kan
--    fortfarande passera båda. Det är en egen, känd brist (filnivå-idempotens,
--    kräver migration) och den är varken införd eller lagad här."
--
-- Mätt på basen före den här migrationen: två parallella importer av EN CSV med
-- EN inbetalningsrad, med överlappet tvingat av en barriär, gav **2**
-- BankTransaction-rader. Båda anropen svarade `imported: 1, duplicates: 0`.
--
-- Migrationen inför de två strukturer som stänger luckan.

-- ── 1. RADIDENTITETEN SOM ETT UNIKT VILLKOR ─────────────────────────────────
--
-- `identityKey` är SHA-256 över EXAKT de fält varje filvägs fält-dedup redan
-- frågar efter (F034:s identitet per väg, oförändrad). `identitySeq` är radens
-- FÖREKOMSTNUMMER inom den fil som skapade den, 0-baserat.
--
-- Förekomstnumret är hela skälet till att villkoret får finnas: ett unikt index
-- på bara datum, belopp och text hade slagit ihop två VERKLIGT skilda
-- betalningar som råkar vara lika i allt filen bär. Med numret får de 0 och 1
-- och bevaras båda.
--
-- NOT NULL MED SENTINEL, INTE NULLBAR. Två NULL är distinkta i ett unikt index
-- (SQL-standarden, inte en Postgres-egenhet) — en nullbar kolumn i villkoret
-- hade alltså lämnat exakt de rader som fanns före kolumnen oskyddade. Se
-- CLAUDE.md § "Ett unikt villkor över en NULLBAR kolumn skyddar inte raderna
-- utan värde".
ALTER TABLE "BankTransaction"
  ADD COLUMN "identityKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "identitySeq" INTEGER NOT NULL DEFAULT 0;

-- INGEN BACKFILL. Varje befintlig rad får sentinelen `''`. Att räkna fram en
-- identitet i efterhand hade krävt att man antar vilken filväg och vilken
-- kodversion som skrev raden — OCR-härledningen ändrades i #556 och PDF-vägens
-- `reference`-sanering är yngre än skrivningen (F034 § Avgränsning). En sådan
-- stämpel hade varit ett påstående utan täckning, alltså historikläkning.

-- PARTIELLT INDEX, eftersom sentinelen kolliderar med SIG SJÄLV: med `''` på
-- alla befintliga rader hade ett totalt unikt index varit omöjligt att skapa.
-- Predikatet utesluter dem. Nya filrader beräknar ALLTID en riktig nyckel och
-- kan därför aldrig hamna utanför predikatet.
--
-- Raderna med `''` skyddas fortfarande av fält-dedupens LÄSNING, som är kvar
-- som första lager just för dem.
CREATE UNIQUE INDEX "bank_transaction_identity_unique"
  ON "BankTransaction" ("organizationId", "identityKey", "identitySeq")
  WHERE "identityKey" <> '';

-- Uppslag på identiteten (förekomsträkningen) utan att skanna organisationen.
CREATE INDEX "BankTransaction_organizationId_identityKey_idx"
  ON "BankTransaction" ("organizationId", "identityKey");

-- ── 2. IMPORTFÖRSÖKET SOM EN DB-AVGJORD VINNARE ─────────────────────────────
--
-- En rad per AVTRYCK. `@@unique(organizationId, fingerprint)` gör Postgres till
-- skiljedomare: `create` och fånga P2002. Ett processlokalt lås hade inte synts
-- för en andra appinstans.
CREATE TYPE "BankImportAttemptStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

CREATE TABLE "BankImportAttempt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "mappingHash" TEXT NOT NULL,
  "status" "BankImportAttemptStatus" NOT NULL DEFAULT 'RUNNING',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "resultJson" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BankImportAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankImportAttempt_organizationId_fingerprint_key"
  ON "BankImportAttempt" ("organizationId", "fingerprint");

CREATE INDEX "BankImportAttempt_organizationId_status_idx"
  ON "BankImportAttempt" ("organizationId", "status");

-- CASCADE, TILL SKILLNAD FRÅN GRANNARNA. `BankTransaction` och
-- `BankStatementImport` har `Restrict` därför att de är räkenskapsinformation
-- respektive underlag för sådan (BFL 1999:1078, 7 år). Den här raden är en
-- DRIFTKVITTENS på ett importförsök och besvarar en enda fråga — "har filen
-- redan importerats?" — som är meningslös när organisationen är borta. Det
-- verkliga underlaget, bankraderna, skyddas av sin egen Restrict.
--
-- Valet är inte bekvämlighet: `Restrict` hade tvingat varje väg som raderar en
-- organisation att först tömma en tabell vars innehåll inget skyddar, och den
-- friktionen hade betalats i varje provfixtur utan att någon rad blev säkrare.
ALTER TABLE "BankImportAttempt"
  ADD CONSTRAINT "BankImportAttempt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. PDF-BEKRÄFTELSENS ANSPRÅK PÅ DRAFTEN ─────────────────────────────────
--
-- Filnivåskyddet arbetar på AVTRYCKET, och två bekräftelser av samma draft med
-- OLIKA redigerade listor är två olika avtryck — båda släpps med rätta igenom.
-- Utan ett anspråk på själva draften hade de då kunnat skriva bankrader från
-- samma underlag samtidigt.
--
-- `CONFIRMING` är det läge övergången PARSED → (commit pågår) gör synlig.
-- Anspråket är en status-guardad UPDATE vars radantal avgör vem som får köra.
--
-- EGET VÄRDE OCH INTE ÅTERANVÄNT `PARSING`: det senare betyder "AI:n läser
-- filen". Att låna det hade gjort ett AI-fel oskiljbart från ett avbrutet
-- commit.
--
-- Ingen befintlig rad ändrar värde — enum-värdet läggs bara till.
ALTER TYPE "BankStatementImportStatus" ADD VALUE IF NOT EXISTS 'CONFIRMING' AFTER 'PARSED';
