-- Teknisk förvaltning, Spår A PR 1 — datamodell för övrig debiterbar post (MiscCharge).
-- INGEN bokföringslogik, ingen service, ingen frontend i denna migration.
-- Beslut "Väg 2" (egen modell, ej utökning av ConsumptionCharge), specialist-
-- granskningen 2026-06-24.

-- CreateEnum
CREATE TYPE "MiscChargeStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'ATTACHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MiscChargeVatStatus" AS ENUM ('EXEMPT', 'TAXABLE_25');

-- CreateEnum
CREATE TYPE "MiscChargeSource" AS ENUM ('MAINTENANCE_TICKET', 'INSPECTION_ITEM', 'KEY_LOSS');

-- AlterEnum
ALTER TYPE "JournalEntrySource" ADD VALUE 'MISC_CHARGE';

-- AlterTable
ALTER TABLE "MaintenanceTicket" ADD COLUMN     "chargeId" TEXT;

-- AlterTable
ALTER TABLE "RentNoticeLine" ADD COLUMN     "miscChargeId" TEXT;

-- CreateTable
CREATE TABLE "MiscCharge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" "MiscChargeSource" NOT NULL,
    "sourceRefId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "incidentDate" DATE NOT NULL,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "vatStatus" "MiscChargeVatStatus" NOT NULL DEFAULT 'EXEMPT',
    "vatRate" INTEGER NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "status" "MiscChargeStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MiscCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MiscCharge_organizationId_idx" ON "MiscCharge"("organizationId");

-- CreateIndex
CREATE INDEX "MiscCharge_leaseId_idx" ON "MiscCharge"("leaseId");

-- CreateIndex
CREATE INDEX "MiscCharge_status_idx" ON "MiscCharge"("status");

-- CreateIndex
CREATE INDEX "MiscCharge_sourceType_sourceRefId_idx" ON "MiscCharge"("sourceType", "sourceRefId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceTicket_chargeId_key" ON "MaintenanceTicket"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "RentNoticeLine_miscChargeId_key" ON "RentNoticeLine"("miscChargeId");

-- AddForeignKey
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "MiscCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentNoticeLine" ADD CONSTRAINT "RentNoticeLine_miscChargeId_fkey" FOREIGN KEY ("miscChargeId") REFERENCES "MiscCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MiscCharge" ADD CONSTRAINT "MiscCharge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MiscCharge" ADD CONSTRAINT "MiscCharge_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MiscCharge" ADD CONSTRAINT "MiscCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
