-- PSD2 P1 — källidentitet & cross-source-dedup på BankTransaction.
-- Bägge kolumnerna NULLABLE: befintliga fil-rader och all filimport är oförändrade
-- (externalId/dedupKey = NULL). Postgres behandlar NULL som distinkt i UNIQUE, så
-- flera fil-rader med externalId=NULL tillåts; unikheten gäller bara icke-NULL
-- (API-)transaktions-id per organisation.

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "dedupKey" TEXT,
ADD COLUMN     "externalId" TEXT;

-- CreateIndex
CREATE INDEX "BankTransaction_organizationId_dedupKey_idx" ON "BankTransaction"("organizationId", "dedupKey");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_organizationId_externalId_key" ON "BankTransaction"("organizationId", "externalId");
