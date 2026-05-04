-- Kontraktsmall-overhaul: nya fält på Lease/Property/Unit/Document plus två
-- nya enums (PetPolicy, IndexClauseType). Backwards-compatible — alla nya
-- fält har defaults eller är NULL-tillåtna.

-- CreateEnum
CREATE TYPE "PetPolicy" AS ENUM ('ALLOWED', 'REQUIRES_APPROVAL', 'NOT_ALLOWED');

-- CreateEnum
CREATE TYPE "IndexClauseType" AS ENUM ('NONE', 'KPI', 'NEGOTIATED', 'MARKET_RENT');

-- AlterTable Lease (vad ingår, tillägg, husdjur, andrahand, index, försäkring)
ALTER TABLE "Lease"
  ADD COLUMN "includesHeating"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "includesWater"         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "includesHotWater"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "includesElectricity"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "includesInternet"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "includesCleaning"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "includesParking"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "includesStorage"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "includesLaundry"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "parkingFee"            DECIMAL(10,2),
  ADD COLUMN "storageFee"            DECIMAL(10,2),
  ADD COLUMN "garageFee"             DECIMAL(10,2),
  ADD COLUMN "usagePurpose"          TEXT,
  ADD COLUMN "petsAllowed"           "PetPolicy" NOT NULL DEFAULT 'REQUIRES_APPROVAL',
  ADD COLUMN "petsApprovalNotes"     TEXT,
  ADD COLUMN "sublettingAllowed"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "indexClauseType"       "IndexClauseType" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "indexBaseYear"         INTEGER,
  ADD COLUMN "indexAdjustmentDate"   TEXT,
  ADD COLUMN "indexMaxIncrease"      DECIMAL(5,2),
  ADD COLUMN "indexMinIncrease"      DECIMAL(5,2),
  ADD COLUMN "indexNotes"            TEXT,
  ADD COLUMN "requiresHomeInsurance" BOOLEAN NOT NULL DEFAULT true;

-- Backfill: gamla rader med indexClause = true ska få typ KPI så befintliga
-- kontrakt fortfarande visar indexklausul i nya mallen.
UPDATE "Lease" SET "indexClauseType" = 'KPI' WHERE "indexClause" = true;

-- AlterTable Property
ALTER TABLE "Property"
  ADD COLUMN "fireSafetyNotes"      TEXT,
  ADD COLUMN "commonAreasNotes"     TEXT,
  ADD COLUMN "garbageDisposalRules" TEXT;

-- AlterTable Unit
ALTER TABLE "Unit"
  ADD COLUMN "hasBalcony"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hasStorage"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storageNumber"      TEXT,
  ADD COLUMN "parkingSpaceNumber" TEXT;

-- AlterTable Document (signering + version)
ALTER TABLE "Document"
  ADD COLUMN "contentHash"       TEXT,
  ADD COLUMN "signedAt"          TIMESTAMP(3),
  ADD COLUMN "signedByTenantId"  TEXT,
  ADD COLUMN "signedFromIp"      TEXT,
  ADD COLUMN "signedUserAgent"   TEXT,
  ADD COLUMN "locked"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "previousVersionId" TEXT;

-- CreateIndex
CREATE INDEX "Document_previousVersionId_idx" ON "Document"("previousVersionId");

-- AddForeignKey
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_signedByTenantId_fkey"
  FOREIGN KEY ("signedByTenantId") REFERENCES "Tenant"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_previousVersionId_fkey"
  FOREIGN KEY ("previousVersionId") REFERENCES "Document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
