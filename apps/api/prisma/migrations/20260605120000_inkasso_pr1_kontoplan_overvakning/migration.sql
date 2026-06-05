-- Inkasso · PR 1 — kontoplan (6352/8131/8313) + referensränte-tabell +
-- hyresavins kravtrappa + förfalloövervakning.
--
-- Skuld-sidans grund för flödet avi → påminnelse → dröjsmålsränta →
-- inkasso-ready. PR 1 är PENGANEUTRAL: inga avgifter, ingen ränta, inget
-- utskick. Den lägger bara persistensen + detektionen på plats. Eveno bygger
-- ALDRIG förverkande/uppsägning/avhysning — det är hyresvärdens egen process.
--
-- Lagrum (hänvisning, inte AI-skrivet facit — se docs/legal/46):
--   • Lag (1981:739) om ersättning för inkassokostnader — påminnelseavgift.
--   • Räntelagen (1975:635) 6 § + 9 § — dröjsmålsränta = referensränta + 8 pp,
--     referensräntan fastställd halvårsvis.
--   • Bokföringslagen (1999:1078) — räkenskapsinformation + append-only spår.

-- ── Enums ────────────────────────────────────────────────────────────────────
CREATE TYPE "RentCollectionStage" AS ENUM ('NONE', 'REMINDED', 'INKASSO_READY', 'WRITTEN_OFF');

CREATE TYPE "RentNoticeEventType" AS ENUM ('CREATED', 'SENT', 'SEND_FAILED', 'EMAIL_DELIVERED', 'EMAIL_BOUNCED', 'PAYMENT_RECEIVED', 'OVERDUE', 'REMINDER_SENT', 'INTEREST_ACCRUED', 'COLLECTION_READY', 'WRITTEN_OFF', 'NOTE_ADDED');

-- ── Org-konfig: hyres-specifik kravtrappa (skild från faktura-flödet) ────────
-- Additiva kolumner med juristens defaults (dag 7 / +14). Aldrig hårdkodade i
-- logiken — läses härifrån av PR 2 resp. PR 4.
ALTER TABLE "Organization" ADD COLUMN     "rentInkassoDaysAfterReminder" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "rentReminderDay" INTEGER NOT NULL DEFAULT 7;

-- ── RentNotice: kravtrappa-fält (additiva, default NONE = ingen påverkan) ────
ALTER TABLE "RentNotice" ADD COLUMN     "collectionReadyAt" TIMESTAMP(3),
ADD COLUMN     "collectionStage" "RentCollectionStage" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "remindedAt" TIMESTAMP(3),
ADD COLUMN     "writtenOffAt" TIMESTAMP(3);

-- ── Referensränte-tabell (plattformsglobal, nationell, INTE org-scopad) ──────
CREATE TABLE "ReferenceInterestRate" (
    "id" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceInterestRate_pkey" PRIMARY KEY ("id")
);

-- ── RentNoticeEvent: append-only krav-/leveranslogg (speglar InvoiceEvent) ───
CREATE TABLE "RentNoticeEvent" (
    "id" TEXT NOT NULL,
    "rentNoticeId" TEXT NOT NULL,
    "type" "RentNoticeEventType" NOT NULL,
    "actorType" "EventActorType" NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentNoticeEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReferenceInterestRate_effectiveFrom_idx" ON "ReferenceInterestRate"("effectiveFrom");

CREATE UNIQUE INDEX "ReferenceInterestRate_effectiveFrom_key" ON "ReferenceInterestRate"("effectiveFrom");

CREATE INDEX "RentNoticeEvent_rentNoticeId_createdAt_idx" ON "RentNoticeEvent"("rentNoticeId", "createdAt");

CREATE INDEX "RentNoticeEvent_rentNoticeId_type_idx" ON "RentNoticeEvent"("rentNoticeId", "type");

CREATE INDEX "RentNoticeEvent_createdAt_idx" ON "RentNoticeEvent"("createdAt");

CREATE INDEX "RentNotice_organizationId_collectionStage_idx" ON "RentNotice"("organizationId", "collectionStage");

ALTER TABLE "RentNoticeEvent" ADD CONSTRAINT "RentNoticeEvent_rentNoticeId_fkey" FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Kontoplan-backfill: 6352 / 8131 / 8313 ───────────────────────────────────
-- Samma mönster som FIX 9 PR 1 (3900-serien). Lägger till de nya kontona för
-- alla organisationer som redan har en seedad kontoplan. Nya orgs får dem via
-- basChartFor() vid registrering. Gamla konton raderas aldrig (BFL 7 kap 2 §).
--   6352 — Konstaterade förluster på kundfordringar (EXPENSE). Kundförlust
--          bokförs 1515 (befarad) → 6352 (konstaterad) i PR 5.
--   8131 — Dröjsmålsränta, kundfordringar (REVENUE, finansiell intäkt). PR 3
--          posterar dröjsmålsräntan hit per fastställd regel (INTE 3593).
--   8313 — Ränteintäkter från kundfordringar (REVENUE). BAS standardkonto för
--          ränteintäkt på kundfordringar; seedas parallellt. Vilket av 8131/8313
--          som PR 3 slutligt bokför mot bekräftas av redovisningskonsult
--          (docs/legal/46). Ofarligt i PR 1 — inget bokförs.
INSERT INTO "Account" (id, "organizationId", number, name, type, "isActive")
SELECT gen_random_uuid(), o.id, v.number, v.name, v.type::"AccountType", true
FROM "Organization" o
CROSS JOIN (VALUES
  (6352, 'Konstaterade förluster på kundfordringar', 'EXPENSE'),
  (8131, 'Dröjsmålsränta, kundfordringar', 'REVENUE'),
  (8313, 'Ränteintäkter från kundfordringar', 'REVENUE')
) AS v(number, name, type)
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o.id)
  AND NOT EXISTS (
    SELECT 1 FROM "Account" a2
    WHERE a2."organizationId" = o.id AND a2.number = v.number
  );

-- ── Seed: gällande referensränta (oläst i PR 1) ──────────────────────────────
-- En rad så tabellen inte är tom när PR 3 byggs. PRELIMINÄRT värde — det är
-- INTE ett fastställt facit. Det faktiska gällande värdet verifieras mot
-- Riksbankens publicering INNAN PR 3 läser tabellen och bokför ränta. Idempotent.
INSERT INTO "ReferenceInterestRate" (id, "effectiveFrom", "ratePercent", source)
VALUES (
  gen_random_uuid(),
  DATE '2026-01-01',
  2.00,
  'PRELIMINÄRT — verifieras mot Riksbankens referensränta före PR 3 läser värdet'
)
ON CONFLICT ("effectiveFrom") DO NOTHING;
