-- IMPORTSTOPP-009 (FORTNOX-100): varaktigt, organisationsbundet olöst importstopp.
-- Ingen backfill: tabellen börjar tom; bara nya importer skapar stopp.

-- CreateTable
CREATE TABLE "BankImportStop" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bankAccountId" TEXT,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3),
    "amount" DECIMAL(12,2),
    "reference" TEXT,
    "payerBankgiro" TEXT,
    "stopKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "BankImportStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankImportStop_organizationId_resolvedAt_idx" ON "BankImportStop"("organizationId", "resolvedAt");

-- CreateIndex
CREATE INDEX "BankImportStop_bankAccountId_idx" ON "BankImportStop"("bankAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BankImportStop_organizationId_stopKey_key" ON "BankImportStop"("organizationId", "stopKey");

-- AddForeignKey
ALTER TABLE "BankImportStop" ADD CONSTRAINT "BankImportStop_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankImportStop" ADD CONSTRAINT "BankImportStop_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
