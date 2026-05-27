-- BankStatementImport: persisterad DRAFT av AI-tolkat PDF-kontoutdrag.
-- Användaren får granska och redigera innan vi commitar BankTransaction-rader
-- (samma reconciliation-flöde som CSV/BgMax — inkl. FIFO-matchning från Fix 6).
--
-- ON DELETE RESTRICT på FK till Organization — samma mönster som Invoice
-- och BankTransaction. Importerade kontoutdrag är räkenskapsunderlag som
-- ska bevaras 7 år enligt bokföringslagen (1999:1078).

-- CreateEnum
CREATE TYPE "BankStatementImportStatus" AS ENUM ('PARSING', 'PARSED', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "status" "BankStatementImportStatus" NOT NULL DEFAULT 'PARSING',
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bank" TEXT,
    "accountNumber" TEXT,
    "periodStart" DATE,
    "periodEnd" DATE,
    "parsedData" JSONB,
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "matchedCount" INTEGER,
    "unmatchedCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankStatementImport_organizationId_idx" ON "BankStatementImport"("organizationId");

-- CreateIndex
CREATE INDEX "BankStatementImport_status_idx" ON "BankStatementImport"("status");

-- AddForeignKey
ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
