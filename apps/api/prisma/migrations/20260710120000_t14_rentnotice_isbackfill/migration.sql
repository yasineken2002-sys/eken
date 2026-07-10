-- T1.4 / #44 — markör för bakdaterad debitering.
--
-- Additiv, icke-destruktiv: alla befintliga avier är per definition INTE
-- efterdebiterade → default false. Markören exkluderar backfill-avier från
-- kravtrappans auto-eskalering (RentReminderService) och behåller type=RENT så
-- @@unique([leaseId,year,month,type]) fortsatt hindrar dubbel-avisering.
ALTER TABLE "RentNotice" ADD COLUMN "isBackfill" BOOLEAN NOT NULL DEFAULT false;
