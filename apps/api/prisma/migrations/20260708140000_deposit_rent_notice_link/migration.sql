-- #41 — koppla Deposit-raden till aktiverings-avin (RentNotice{DEPOSIT}).
-- Nullbar + @unique: en Deposit kan länkas till max en deposition-avi, och en
-- avi till max en Deposit. Ingen datamigrering här — själva bakåtfyllnaden av
-- Deposit-rader + bokföring (1510 D/2890 K) för befintliga orphan-avier görs av
-- en idempotent tjänste-backfill (DepositsService.backfillOrphanDepositNotices),
-- som återanvänder EXAKT samma create-väg som aktiveringen (rätt verifikations-
-- nummer + stängd-period-kontroll). Att skapa Deposit-rader utan bokförd 1510
-- D/2890 K vore den ogrundade-1510-fällan; därför får matchning ske FÖRST när en
-- länkad Deposit finns (fail-closed i reconciliation).

ALTER TABLE "Deposit" ADD COLUMN "rentNoticeId" TEXT;

CREATE UNIQUE INDEX "Deposit_rentNoticeId_key" ON "Deposit"("rentNoticeId");

ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_rentNoticeId_fkey"
  FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
