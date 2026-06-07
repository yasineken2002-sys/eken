-- Bankavstämnings-härdning PR 1 — granulär betalningsallokering (RentNoticePayment).
--
-- Penganeutral grund-PR. Inför en härledd betalningstabell bredvid hyresavin så
-- att betalningar blir GRANULÄRA (en rad per faktisk betalning) istället för
-- enbart en samlad paidAmount-cache. paidAmount och matchedRentNoticeId behålls
-- som HÄRLEDDA SPEGLAR — inga läsare bryts.
--
-- Rör ALDRIG huvudboken: inga verifikat (JournalEntry) skapas eller ändras här,
-- ingen statusövergång, inget utskick, inget kravbeslut. Backfillen är förlustfri
-- och idempotent och avslutas med en INBYGGD verifikation som asserterar
-- Σ allokeringar == paidAmount per PAID-avi (förväntat: noll avvikelser).

-- ── 1. Enum för betalningens ursprung ────────────────────────────────────────
CREATE TYPE "RentNoticePaymentSource" AS ENUM ('BANK_RECONCILIATION', 'MANUAL');

-- ── 2. Lyft @unique på BankTransaction.matchedRentNoticeId ────────────────────
-- Dubbel-allokeringsskyddet flyttas till RentNoticePayment.bankTransactionId
-- @unique (en bank-transaktion → exakt en avi). matchedRentNoticeId blir en
-- härledd spegel som på sikt kan delas av flera transaktioner mot samma avi
-- (delbetalning). Den status-guardade updateMany:en i applyMatchToRentNotice bär
-- redan race-garantin "en avi claimas en gång", så ingen skyddslucka uppstår.
-- Vi byter det unika indexet mot ett vanligt index (uppslag/relation behålls).
DROP INDEX "BankTransaction_matchedRentNoticeId_key";
CREATE INDEX "BankTransaction_matchedRentNoticeId_idx" ON "BankTransaction"("matchedRentNoticeId");

-- ── 3. Tabell RentNoticePayment ──────────────────────────────────────────────
CREATE TABLE "RentNoticePayment" (
    "id" TEXT NOT NULL,
    "rentNoticeId" TEXT NOT NULL,
    "bankTransactionId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "source" "RentNoticePaymentSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentNoticePayment_pkey" PRIMARY KEY ("id")
);

-- En bank-transaktion får allokeras till EXAKT en avi (dubbel-allokeringsskydd).
-- NULL (manuella betalningar) är distinkt i Postgres unika index → flera tillåts.
CREATE UNIQUE INDEX "RentNoticePayment_bankTransactionId_key" ON "RentNoticePayment"("bankTransactionId");
CREATE INDEX "RentNoticePayment_rentNoticeId_idx" ON "RentNoticePayment"("rentNoticeId");

-- Cascade mot avin: allokeringen är härledd data, inte verifikat. Restrict-skyddet
-- mot org på RentNotice bevarar räkenskapsinformationen i 7 år ändå.
ALTER TABLE "RentNoticePayment"
  ADD CONSTRAINT "RentNoticePayment_rentNoticeId_fkey"
  FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RentNoticePayment"
  ADD CONSTRAINT "RentNoticePayment_bankTransactionId_fkey"
  FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Backfill (förlustfri + idempotent) ─────────────────────────────────────
-- En allokering per redan betald avi (status PAID, paidAmount satt). Beloppet =
-- paidAmount (spegeln), datumet = paidAt (fallback updatedAt). Källan härleds:
-- finns en matchad bank-transaktion för avin → BANK_RECONCILIATION + länk, annars
-- MANUAL (markAsPaid). NOT EXISTS-guarden gör backfillen idempotent ( skapar inte
-- en andra allokering om migrationen körs om mot redan migrerad data).
INSERT INTO "RentNoticePayment" ("id", "rentNoticeId", "bankTransactionId", "amount", "paidAt", "source", "createdAt")
SELECT
    gen_random_uuid(),
    rn."id",
    bt."id",
    rn."paidAmount",
    COALESCE(rn."paidAt", rn."updatedAt"),
    CASE WHEN bt."id" IS NOT NULL THEN 'BANK_RECONCILIATION'::"RentNoticePaymentSource"
         ELSE 'MANUAL'::"RentNoticePaymentSource" END,
    CURRENT_TIMESTAMP
FROM "RentNotice" rn
LEFT JOIN LATERAL (
    SELECT b."id"
    FROM "BankTransaction" b
    WHERE b."matchedRentNoticeId" = rn."id"
      AND b."status" = 'MATCHED'
    ORDER BY b."matchedAt" ASC NULLS LAST, b."createdAt" ASC
    LIMIT 1
) bt ON true
WHERE rn."status" = 'PAID'
  AND rn."paidAmount" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "RentNoticePayment" p WHERE p."rentNoticeId" = rn."id"
  );

-- ── 5. INBYGGD VERIFIKATION ───────────────────────────────────────────────────
-- Asserterar invarianten Σ allokeringar == paidAmount för varje PAID-avi med satt
-- paidAmount. Vid avvikelse RAISE EXCEPTION → hela migrationen rullas tillbaka
-- (transaktionell DDL i Postgres) och deployen stoppas. Förväntat: noll avvikelser.
DO $$
DECLARE
  mismatch_count integer;
  mismatch_sample text;
BEGIN
  SELECT count(*), string_agg(rn."noticeNumber", ', ' ORDER BY rn."noticeNumber")
    INTO mismatch_count, mismatch_sample
  FROM "RentNotice" rn
  LEFT JOIN (
    SELECT "rentNoticeId", COALESCE(sum("amount"), 0) AS allocated
    FROM "RentNoticePayment"
    GROUP BY "rentNoticeId"
  ) p ON p."rentNoticeId" = rn."id"
  WHERE rn."status" = 'PAID'
    AND rn."paidAmount" IS NOT NULL
    AND COALESCE(p.allocated, 0) <> rn."paidAmount";

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'PR1 backfill-verifikation MISSLYCKADES: % PAID-avi(er) där Σ allokeringar <> paidAmount (ex: %)',
      mismatch_count, left(COALESCE(mismatch_sample, ''), 200);
  END IF;

  RAISE NOTICE 'PR1 backfill-verifikation OK: alla PAID-avier har Σ allokeringar == paidAmount.';
END $$;
