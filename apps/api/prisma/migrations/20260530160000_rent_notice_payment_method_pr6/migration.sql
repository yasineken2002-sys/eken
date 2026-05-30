-- FIX 9 · PR 6 — Sluten intäktscykel: betalningsregistrering bokförs (markAsPaid)
--
-- PR 2 bokförde hyresfordran vid avisering (1510 D / 39xx K), men när en avi
-- markerades betald manuellt skapades ingen motpost — kundfordran 1510 växte
-- obegränsat och kontanta/Swish-betalningar saknades helt i bokföringen.
--
-- Denna migration:
--   1. Inför PaymentMethod-enum + RentNotice.paymentMethod (audit: hur betalades
--      avin) — nullbar, ingen backfill (historiska/obetalda avier saknar värde).
--   2. Backfillar likvidkontot 1910 (Kassa) för alla organisationer som redan
--      har en seedad kontoplan, så att createJournalEntryForRentNoticeManualPayment
--      kan debitera rätt konto per betalningssätt (BANK/SWISH/MANUAL → 1930,
--      CASH → 1910). 1930 finns redan sedan grundseeden; Swish bokförs mot 1930
--      (landar på företagskontot) och kräver inget eget konto. Utan 1910 skulle
--      ett kontant-verifikat tyst utebli — exakt buggen vi åtgärdar.
--
-- Befintliga konton/journalposter rörs inte (BFL 5 kap 5 § append-only,
-- 7 kap 2 § 7-årig bevaring). Insättningen är idempotent (NOT EXISTS per
-- org + kontonummer).

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK', 'CASH', 'SWISH', 'MANUAL');

-- AlterTable
ALTER TABLE "RentNotice" ADD COLUMN "paymentMethod" "PaymentMethod";

-- Backfill likvidkonto 1910 (Kassa) för befintliga orgs.
INSERT INTO "Account" (id, "organizationId", number, name, type, "isActive")
SELECT gen_random_uuid(), o.id, v.number, v.name, v.type::"AccountType", true
FROM "Organization" o
CROSS JOIN (VALUES
  (1910, 'Kassa', 'ASSET')
) AS v(number, name, type)
-- Bara organisationer som redan har en kontoplan — vi skapar inte konton för
-- orgs som medvetet saknar seedning.
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o.id)
  -- Idempotent: hoppa över konton som redan finns (unik per org + nummer).
  AND NOT EXISTS (
    SELECT 1 FROM "Account" a2
    WHERE a2."organizationId" = o.id AND a2.number = v.number
  );
