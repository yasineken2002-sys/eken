-- CreateEnum
CREATE TYPE "ContractImportBatchStatus" AS ENUM ('PENDING', 'SCANNING', 'SCANNED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContractImportRowStatus" AS ENUM ('PENDING', 'SCANNING', 'SCANNED', 'FAILED');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "maxContractBatchCostSek" DECIMAL(10,2) NOT NULL DEFAULT 50,
ADD COLUMN     "maxContractBatchFiles" INTEGER NOT NULL DEFAULT 50;

-- CreateTable
CREATE TABLE "ContractImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "ContractImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "scannedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostSek" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fileCapApplied" INTEGER NOT NULL,
    "costCapApplied" DECIMAL(10,2) NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileData" BYTEA,
    "rowStatus" "ContractImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "originalScanData" JSONB,
    "reviewedData" JSONB,
    "confidence" DOUBLE PRECISION,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContractImportBatch_organizationId_idx" ON "ContractImportBatch"("organizationId");

-- CreateIndex
CREATE INDEX "ContractImportBatch_status_idx" ON "ContractImportBatch"("status");

-- CreateIndex
CREATE INDEX "ContractImportRow_batchId_idx" ON "ContractImportRow"("batchId");

-- CreateIndex
CREATE INDEX "ContractImportRow_organizationId_idx" ON "ContractImportRow"("organizationId");

-- CreateIndex
CREATE INDEX "ContractImportRow_rowStatus_idx" ON "ContractImportRow"("rowStatus");

-- AddForeignKey
ALTER TABLE "ContractImportBatch" ADD CONSTRAINT "ContractImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractImportRow" ADD CONSTRAINT "ContractImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ContractImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
