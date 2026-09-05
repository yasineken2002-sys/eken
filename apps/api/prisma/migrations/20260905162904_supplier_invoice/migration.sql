-- Leverantörsfaktura (fakturametoden): två verifikat per faktura, mottagande
-- (kostnad + 2641 / 2440) och betalning (2440 / 1930).
--
-- INGEN status-kolumn: tillståndet härleds ur `paidAt`/`cancelledAt` och
-- verifikaten. Samma princip som skulden i övrigt — ett beräknat tillstånd,
-- aldrig en flagga.
ALTER TYPE "JournalEntrySource" ADD VALUE 'SUPPLIER_INVOICE';

CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "description" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "expenseAccount" INTEGER NOT NULL,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "vatRate" INTEGER NOT NULL DEFAULT 25,
    "vatAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "attachmentUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierInvoice_organizationId_idx" ON "SupplierInvoice"("organizationId");
-- Öppna poster sorteras på förfallodatum — listans enda ordning.
CREATE INDEX "SupplierInvoice_organizationId_dueDate_idx" ON "SupplierInvoice"("organizationId", "dueDate");

ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
