-- T1.4 PR3 — momsredovisningsperiod per organisation (SFL 26 kap).
-- Används enbart för att namnge vilka momsperioder en bakdaterad debitering
-- berör. Påverkar aldrig bokföring/verifikat. Kalenderbaserad.

-- CreateEnum
CREATE TYPE "VatReportingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- AlterTable: default QUARTERLY (vanligast för segmentet 1–40 MSEK); befintliga
-- rader backfillas till QUARTERLY av DEFAULT + NOT NULL.
ALTER TABLE "Organization" ADD COLUMN "vatReportingPeriod" "VatReportingPeriod" NOT NULL DEFAULT 'QUARTERLY';
