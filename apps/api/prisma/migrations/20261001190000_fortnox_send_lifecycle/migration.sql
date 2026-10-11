-- FORTNOX-SANDNING (2026-10-01): sändningslivscykel för exportkön. Endast tillägg
-- (nya enumvärden, nullbara kolumner, unikt index för extern identitet).

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FortnoxExportState" ADD VALUE 'SENDING';
ALTER TYPE "FortnoxExportState" ADD VALUE 'REJECTED';
ALTER TYPE "FortnoxExportState" ADD VALUE 'RECEIPT_IDENTIFIED';
ALTER TYPE "FortnoxExportState" ADD VALUE 'RECEIPT_MISMATCH';

-- AlterTable
ALTER TABLE "FortnoxVoucherExport" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "lastOutcome" TEXT,
ADD COLUMN     "lastOutcomeAt" TIMESTAMP(3),
ADD COLUMN     "receiptAt" TIMESTAMP(3),
ADD COLUMN     "reconcileDecision" JSONB,
ADD COLUMN     "reconciledAt" TIMESTAMP(3),
ADD COLUMN     "sendAttemptId" TEXT,
ADD COLUMN     "sendClaimedAt" TIMESTAMP(3),
ADD COLUMN     "sendConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "sendConfirmedBy" TEXT,
ADD COLUMN     "sendConnectionId" TEXT,
ADD COLUMN     "sendFinancialYear" INTEGER,
ADD COLUMN     "sendGeneration" INTEGER,
ADD COLUMN     "sendLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "sendSeries" TEXT,
ADD COLUMN     "sentPayloadHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxVoucherExport_external_identity_key" ON "FortnoxVoucherExport"("organizationId", "fortnoxDatabaseNumber", "externalYear", "externalSeries", "externalNumber");

