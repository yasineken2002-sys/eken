-- TESTKUND-20261004/008: organisationsspecifik, versionsbunden kontomappning för Fortnox-export.
-- Bara tillägg: nya enum och två nya tabeller. Ingen backfill, inga ändringar i befintliga
-- tabeller eller äldre migrationer.

-- CreateEnum
CREATE TYPE "FortnoxAccountMappingStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "FortnoxAccountRole" AS ENUM ('KUNDFORDRAN', 'HYRESINTAKT', 'LIKVID', 'DEPOSITIONSSKULD', 'KOSTNAD', 'INGAENDE_MOMS', 'LEVERANTORSSKULD');

-- CreateEnum
CREATE TYPE "FortnoxVatTreatment" AS ENUM ('EJ_TILLAMPLIG', 'MOMSFRI', 'AVDRAGSGILL');

-- CreateEnum
CREATE TYPE "FortnoxTechnicalVat" AS ENUM ('FORENLIG', 'KONFLIKT', 'EJ_BELAGD');

-- CreateTable
CREATE TABLE "FortnoxAccountMappingRevision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "FortnoxAccountMappingStatus" NOT NULL DEFAULT 'DRAFT',
    "connectionId" TEXT NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "fortnoxDatabaseNumber" INTEGER NOT NULL,
    "fortnoxOrgNumber" TEXT NOT NULL,
    "financialYearId" INTEGER NOT NULL,
    "financialYearFrom" DATE NOT NULL,
    "financialYearTo" DATE NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedByRole" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "FortnoxAccountMappingRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FortnoxAccountMappingRow" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "role" "FortnoxAccountRole" NOT NULL,
    "vatTreatment" "FortnoxVatTreatment" NOT NULL,
    "sourceAccountNumber" INTEGER NOT NULL,
    "sourceAccountName" TEXT NOT NULL,
    "targetAccountNumber" INTEGER NOT NULL,
    "targetName" TEXT,
    "targetActive" BOOLEAN,
    "targetVatCode" TEXT,
    "targetVatCodePresent" BOOLEAN NOT NULL,
    "targetYear" INTEGER,
    "targetExists" BOOLEAN NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "technical" "FortnoxTechnicalVat" NOT NULL,
    "technicalReason" TEXT NOT NULL,

    CONSTRAINT "FortnoxAccountMappingRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FortnoxAccountMappingRevision_organizationId_status_idx" ON "FortnoxAccountMappingRevision"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxAccountMappingRevision_organizationId_revision_key" ON "FortnoxAccountMappingRevision"("organizationId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxAccountMappingRow_revisionId_role_sourceAccountNumbe_key" ON "FortnoxAccountMappingRow"("revisionId", "role", "sourceAccountNumber", "vatTreatment");

-- AddForeignKey
ALTER TABLE "FortnoxAccountMappingRevision" ADD CONSTRAINT "FortnoxAccountMappingRevision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxAccountMappingRow" ADD CONSTRAINT "FortnoxAccountMappingRow_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "FortnoxAccountMappingRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Högst EN godkänd revision per (organisation, räkenskapsår) — avgjort av databasen även vid två
-- samtidiga godkännanden (KONTRAKTSBESKED-008 V5a/V6). Prisma-schemat kan inte uttrycka predikatet.
CREATE UNIQUE INDEX "fortnox_account_mapping_one_approved"
  ON "FortnoxAccountMappingRevision" ("organizationId", "financialYearId")
  WHERE "status" = 'APPROVED';
