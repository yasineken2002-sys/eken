-- Teknisk förvaltning · Spår A PR 4b — MiscCharge betalbar på avi.
--
-- RentNotice.miscChargeAmount — summan av övriga debiterbara poster (MiscCharge:
-- skada/nyckel m.m.) som attach:ats som rader på avin. SPEGLAR consumptionAmount/
-- reminderFeeAmount: brutto, ingår i den betalbara totalen (rentNoticePayableTotal)
-- och i skuld-/OCR-beräkningen (computeRentDebt) så fordran på 1510, avins OCR och
-- bankavstämningen matchar mot SAMMA summa. Bokförs via eget verifikat (1510 D /
-- 3990 K, PR 2/3) — inte här.
--
-- Default 0 → noll påverkan på befintliga/icke-debiterade avier. ALDRIG hopslaget
-- med consumptionAmount (IMD-attach skriver över det vid varje generering, och
-- rapportering håller isär IMD från skadedebitering).

ALTER TABLE "RentNotice" ADD COLUMN     "miscChargeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
