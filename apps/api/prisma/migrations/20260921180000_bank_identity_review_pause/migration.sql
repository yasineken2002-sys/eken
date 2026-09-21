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
-- indexet blir den andra en P2002 som anroparen tolkar som "redan öppen" —
-- samma konstruktion som identitetsindexet i #F034b.
CREATE UNIQUE INDEX "bank_identity_review_pause_open_unique"
    ON "BankIdentityReviewPause"("organizationId")
    WHERE "endedAt" IS NULL;

ALTER TABLE "BankIdentityReviewPause"
    ADD CONSTRAINT "BankIdentityReviewPause_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
