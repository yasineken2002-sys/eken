-- TESTKUND-20261004/041 (moms v1 + BP1): bara tillägg. Ny enum, nullbara kolumner och två nya
-- tabeller. INGEN backfill: befintliga leverantörsfakturor får null-val (MJ-B1) och oförändrade
-- belopp; inga befintliga rader uppdateras.

-- CreateEnum
CREATE TYPE "SupplierVatTreatment" AS ENUM ('INGEN_MOMS', 'HELT_AVDRAG', 'INGET_AVDRAG');

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "vatTreatment" "SupplierVatTreatment",
ADD COLUMN     "vatTreatmentCurrent" "SupplierVatTreatment",
ADD COLUMN     "vatTreatmentDecidedAt" TIMESTAMP(3),
ADD COLUMN     "vatTreatmentDecidedById" TEXT,
ADD COLUMN     "vatTreatmentDecisionSource" TEXT;

-- CreateTable
CREATE TABLE "SupplierInvoiceVatAdjustment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierInvoiceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "fran" "SupplierVatTreatment" NOT NULL,
    "till" "SupplierVatTreatment" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedRole" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "journalEntryId" TEXT NOT NULL,
    "originalExportId" TEXT NOT NULL,
    "originalSentPayloadHash" TEXT NOT NULL,
    "fortnoxDatabaseNumber" INTEGER NOT NULL,
    "kostnadMal" INTEGER NOT NULL,
    "momsMal" INTEGER NOT NULL,
    "momsMalInfortAv" INTEGER NOT NULL,
    "mappingRevisionId" TEXT,

    CONSTRAINT "SupplierInvoiceVatAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseVatDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "vatTreatment" "SupplierVatTreatment" NOT NULL,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "vatAmount" DECIMAL(10,2) NOT NULL,
    "grossAmount" DECIMAL(10,2) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "ExpenseVatDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceVatAdjustment_journalEntryId_key" ON "SupplierInvoiceVatAdjustment"("journalEntryId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceVatAdjustment_organizationId_idx" ON "SupplierInvoiceVatAdjustment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceVatAdjustment_supplierInvoiceId_seq_key" ON "SupplierInvoiceVatAdjustment"("supplierInvoiceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceVatAdjustment_supplierInvoiceId_clientKey_key" ON "SupplierInvoiceVatAdjustment"("supplierInvoiceId", "clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseVatDecision_journalEntryId_key" ON "ExpenseVatDecision"("journalEntryId");

-- CreateIndex
CREATE INDEX "ExpenseVatDecision_organizationId_idx" ON "ExpenseVatDecision"("organizationId");

-- AddForeignKey
ALTER TABLE "SupplierInvoiceVatAdjustment" ADD CONSTRAINT "SupplierInvoiceVatAdjustment_supplierInvoiceId_fkey" FOREIGN KEY ("supplierInvoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
