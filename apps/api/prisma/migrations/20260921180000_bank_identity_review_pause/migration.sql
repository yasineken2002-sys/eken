-- G2-AVSLUT — granskningspausen som PERIOD, med skilda aviseringstillstånd.
--
-- ADDITIV. Ingen befintlig rad rörs, ingen kolumn ändras, ingen backfill. En
-- organisation utan olösta rader får ingen period, och historiska rader är
-- oberörda — `identityReviewAt` raderas aldrig av någonting här.

CREATE TABLE "BankIdentityReviewPause" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "mailQueuedAt" TIMESTAMP(3),
    "mailJobId" TEXT,
    "mailAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BankIdentityReviewPause_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BankIdentityReviewPause_organizationId_endedAt_idx"
    ON "BankIdentityReviewPause"("organizationId", "endedAt");

-- ── ETT ÖPPET PER ORGANISATION, AVGJORT AV DATABASEN ────────────────────────
--
-- Partiellt: bara pågående perioder omfattas, så en organisation kan ha hur
-- många AVSLUTADE perioder som helst i historiken.
--
-- Varför ett unikt villkor och inte en läs-sedan-skriv: två samtidiga importer
-- kan båda läsa "ingen öppen period" och båda skapa en. Då finns två
-- aviseringstillfällen för samma paus, och operatören får två brev. Med
-- indexet avgörs kapplöpningen av databasen.
--
-- HUR ANROPAREN ANVÄNDER DET: `INSERT … ON CONFLICT ("organizationId")
-- WHERE "endedAt" IS NULL DO NOTHING RETURNING "id"`. Ingen returnerad rad
-- betyder "en period var redan öppen".
--
-- INTE create-och-fånga-P2002. Öppnandet sker inne i anroparens transaktion,
-- och ett misslyckat statement FÖRGIFTAR transaktionen i Postgres — att fånga
-- felet i JavaScript häver inte det. Mätt: nästa statement föll med 25P02 och
-- granskningsraden skrevs aldrig. Skyddet hade blivit en ny lucka.
--
-- Den som bygger nästa vakt efter den här förlagan ska ärva ON CONFLICT, inte
-- fångsten. (Identitetsindexet i #F034b använder create-och-fånga, och det är
-- rätt DÄR: create:t är transaktionens sista handling.)
CREATE UNIQUE INDEX "bank_identity_review_pause_open_unique"
    ON "BankIdentityReviewPause"("organizationId")
    WHERE "endedAt" IS NULL;

ALTER TABLE "BankIdentityReviewPause"
    ADD CONSTRAINT "BankIdentityReviewPause_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
