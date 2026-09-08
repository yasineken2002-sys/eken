-- Människans bedömningar sparas som nya revisioner; underlagets org binds av FK.
CREATE TYPE "ReadingReviewAssessment" AS ENUM ('NEEDS_INVESTIGATION', 'CONFIRMED', 'EXPLAINED');
CREATE TABLE "MeterReadingReview" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "readingId" TEXT NOT NULL,
  "findingCode" TEXT NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "assessment" "ReadingReviewAssessment" NOT NULL,
  "comment" VARCHAR(1000) NOT NULL,
  "reviewedById" TEXT NOT NULL,
  "reviewedByName" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MeterReadingReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MeterReading_organizationId_id_key" ON "MeterReading"("organizationId", "id");
CREATE UNIQUE INDEX "MeterReadingReview_revision_key" ON "MeterReadingReview"("organizationId", "readingId", "findingCode", "revision");
CREATE INDEX "MeterReadingReview_organizationId_readingId_idx" ON "MeterReadingReview"("organizationId", "readingId");
ALTER TABLE "MeterReadingReview" ADD CONSTRAINT "MeterReadingReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeterReadingReview" ADD CONSTRAINT "MeterReadingReview_organizationId_readingId_fkey" FOREIGN KEY ("organizationId", "readingId") REFERENCES "MeterReading"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER append_only_meter_reading_review
  BEFORE UPDATE ON "MeterReadingReview"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
