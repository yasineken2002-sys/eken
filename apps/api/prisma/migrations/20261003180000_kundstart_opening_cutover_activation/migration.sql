-- KUNDSTART-001 (FORTNOX-KUNDSTART-20261003): öppningspaket för historiska fordringar och
-- depositioner, brytdatum per organisation och kontrollerad Fortnox-kundaktivering.
-- Bara tillägg: nya enum-värden, nullbara kolumner med default, nya tabeller. Ingen backfill.
-- OBS återgång: RentNoticeStatus 'OPENING' kan inte läsas av äldre generationer (fail-closed).

-- CreateEnum
CREATE TYPE "RecordOrigin" AS ENUM ('EVENO', 'OPENING_PACKAGE');

-- CreateEnum
CREATE TYPE "OpeningPackageStatus" AS ENUM ('DRAFT', 'VALIDATED', 'APPROVED', 'EXECUTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "OpeningReconciliationStatus" AS ENUM ('AVSTAMD', 'AVGRANSAD', 'DIFFERENS');

-- CreateEnum
CREATE TYPE "OpeningRowKind" AS ENUM ('RECEIVABLE', 'DEPOSIT');

-- CreateEnum
CREATE TYPE "FortnoxCustomerActivationStatus" AS ENUM ('ACTIVE', 'REVOKED', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "RentNoticeStatus" ADD VALUE 'OPENING';

-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN     "openingRowId" TEXT,
ADD COLUMN     "origin" "RecordOrigin" NOT NULL DEFAULT 'EVENO';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingCutoverDate" DATE,
ADD COLUMN     "billingCutoverSetAt" TIMESTAMP(3),
ADD COLUMN     "billingCutoverSetById" TEXT;

-- AlterTable
ALTER TABLE "RentNotice" ADD COLUMN     "openingRowId" TEXT,
ADD COLUMN     "origin" "RecordOrigin" NOT NULL DEFAULT 'EVENO';

-- CreateTable
CREATE TABLE "OpeningPackage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "OpeningPackageStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "cutoverDate" DATE NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "orgNumber" TEXT,
    "fortnoxDatabaseNumber" INTEGER,
    "fortnoxConnectionId" TEXT,
    "totals" JSONB,
    "reconciliation" JSONB,
    "fortnoxBalance1510Ore" INTEGER,
    "fortnoxBalance2890Ore" INTEGER,
    "reconciliationStatus" "OpeningReconciliationStatus",
    "separateLedgerSpec" JSONB,
    "fortnoxReadRunId" TEXT,
    "zeroOpening" BOOLEAN NOT NULL DEFAULT false,
    "approvedWatermark" TEXT,
    "approvedCutoverDate" DATE,
    "approvedReadRunId" TEXT,
    "invalidatedReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedSha256" TEXT,
    "approvedVersion" INTEGER,
    "executedById" TEXT,
    "executedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningExecutedSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningExecutedSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningPackageRow" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" "OpeningRowKind" NOT NULL,
    "tenantRef" TEXT NOT NULL,
    "leaseRef" TEXT,
    "propertyRef" TEXT,
    "unitRef" TEXT,
    "periodYear" INTEGER,
    "periodMonth" INTEGER,
    "dueDate" DATE,
    "receivedDate" DATE,
    "originalAmount" DECIMAL(12,2) NOT NULL,
    "openAmount" DECIMAL(12,2) NOT NULL,
    "tenantId" TEXT,
    "leaseId" TEXT,
    "propertyId" TEXT,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningPackageRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FortnoxCustomerActivation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "FortnoxCustomerActivationStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectionId" TEXT NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "fortnoxDatabaseNumber" INTEGER NOT NULL,
    "fortnoxOrgNumber" TEXT NOT NULL,
    "financialYearId" INTEGER NOT NULL,
    "financialYearFrom" DATE NOT NULL,
    "financialYearTo" DATE NOT NULL,
    "voucherSeries" TEXT NOT NULL,
    "mappingSha256" TEXT NOT NULL,
    "openingPackageId" TEXT NOT NULL,
    "fortnoxReadRunId" TEXT NOT NULL,
    "consequencesText" TEXT NOT NULL,
    "consequencesSha256" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "invalidatedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FortnoxCustomerActivation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpeningPackage_organizationId_status_idx" ON "OpeningPackage"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningExecutedSource_rowId_key" ON "OpeningExecutedSource"("rowId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningExecutedSource_organizationId_sourceId_key" ON "OpeningExecutedSource"("organizationId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningPackageRow_packageId_sourceId_key" ON "OpeningPackageRow"("packageId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningPackageRow_packageId_rowNo_key" ON "OpeningPackageRow"("packageId", "rowNo");

-- CreateIndex
CREATE INDEX "FortnoxCustomerActivation_organizationId_status_idx" ON "FortnoxCustomerActivation"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_openingRowId_key" ON "Deposit"("openingRowId");

-- CreateIndex
CREATE UNIQUE INDEX "RentNotice_openingRowId_key" ON "RentNotice"("openingRowId");

-- AddForeignKey
ALTER TABLE "OpeningPackage" ADD CONSTRAINT "OpeningPackage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningExecutedSource" ADD CONSTRAINT "OpeningExecutedSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningPackageRow" ADD CONSTRAINT "OpeningPackageRow_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "OpeningPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxCustomerActivation" ADD CONSTRAINT "FortnoxCustomerActivation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

