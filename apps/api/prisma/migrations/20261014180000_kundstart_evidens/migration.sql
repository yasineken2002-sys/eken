-- KUNDSTART-205 (R165-3): oföränderligt kundavstämningsunderlag och ekonomigranskning.
-- ADDITIV: ny enum, två nya tabeller och två nullbara kolumner på OpeningPackage. Ingen
-- befintlig rad ändras; verkställda paket (EXECUTED) och deras effekter rörs inte.
-- Ett APPROVED paket utan approvedEvidenceId stoppas vid execute av tjänsten med ett
-- begripligt skäl (ny jämförelse, granskning och godkännande) — migrationen godkänner
-- eller underkänner ingenting själv.

-- CreateEnum
CREATE TYPE "OpeningEvidenceStatus" AS ENUM ('OK', 'AVVIKELSE', 'STOPP');

-- AlterTable
ALTER TABLE "OpeningPackage" ADD COLUMN     "approvedEvidenceId" TEXT,
ADD COLUMN     "approvedEvidenceSha256" TEXT;

-- CreateTable
CREATE TABLE "OpeningEvidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "evidenceVersion" INTEGER NOT NULL,
    "formatVersion" TEXT NOT NULL,
    "mappingFormatVersion" TEXT NOT NULL,
    "normalizationVersion" TEXT NOT NULL,
    "orgNumber" TEXT NOT NULL,
    "cutoverDate" DATE NOT NULL,
    "sourceAsOfDate" DATE NOT NULL,
    "packageVersion" INTEGER NOT NULL,
    "packageSourceSha256" TEXT NOT NULL,
    "sourceSystemProduct" TEXT NOT NULL,
    "sourceCompanyKey" TEXT NOT NULL,
    "scopeDeclaration" TEXT NOT NULL,
    "scopeDeclarationSha256" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceRaw" BYTEA NOT NULL,
    "sourceRawSha256" TEXT NOT NULL,
    "sourceRawBytes" INTEGER NOT NULL,
    "mappingName" TEXT NOT NULL,
    "mappingRaw" BYTEA NOT NULL,
    "mappingRawSha256" TEXT NOT NULL,
    "mappingNormalizedSha256" TEXT NOT NULL,
    "bindingSha256" TEXT NOT NULL,
    "comparisonStatus" "OpeningEvidenceStatus" NOT NULL,
    "comparisonResult" JSONB NOT NULL,
    "comparisonResultSha256" TEXT NOT NULL,
    "comparisonCounts" JSONB NOT NULL,
    "evidenceSha256" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningEvidenceReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "evidenceSha256" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "reviewerRole" "UserRole" NOT NULL,
    "identityMode" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningEvidenceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpeningEvidence_organizationId_packageId_idx" ON "OpeningEvidence"("organizationId", "packageId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningEvidence_packageId_evidenceVersion_key" ON "OpeningEvidence"("packageId", "evidenceVersion");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningEvidenceReview_evidenceId_key" ON "OpeningEvidenceReview"("evidenceId");

-- CreateIndex
CREATE INDEX "OpeningEvidenceReview_organizationId_idx" ON "OpeningEvidenceReview"("organizationId");

-- AddForeignKey
ALTER TABLE "OpeningPackage" ADD CONSTRAINT "OpeningPackage_approvedEvidenceId_fkey" FOREIGN KEY ("approvedEvidenceId") REFERENCES "OpeningEvidence"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OpeningEvidence" ADD CONSTRAINT "OpeningEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningEvidence" ADD CONSTRAINT "OpeningEvidence_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "OpeningPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningEvidenceReview" ADD CONSTRAINT "OpeningEvidenceReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningEvidenceReview" ADD CONSTRAINT "OpeningEvidenceReview_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "OpeningEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- APPEND-ONLY (samma mekanism och skäl som 20260828140000_append_only_event_triggers):
-- en ändrad källa, mappning eller granskning ska vara en NY rad, aldrig en UPDATE.
-- Satsnivå (FOR EACH STATEMENT) så att även en UPDATE som matchar noll rader avvisas.
-- DELETE spärras inte: organisations- och paketradering kaskaderar hit.
CREATE TRIGGER append_only_opening_evidence
  BEFORE UPDATE ON "OpeningEvidence"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER append_only_opening_evidence_review
  BEFORE UPDATE ON "OpeningEvidenceReview"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
