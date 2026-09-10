CREATE TYPE "BillingBasisDecision" AS ENUM ('VERIFIED_CORRECT_REAL_INCREASE', 'INCORRECT');
ALTER TABLE "MeterReadingReview" ADD COLUMN "billingBasisDecision" "BillingBasisDecision";
CREATE TABLE "ConsumptionChargeCheck" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chargeId" TEXT NOT NULL REFERENCES "ConsumptionCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "organizationId" TEXT NOT NULL,
  "readingId" TEXT NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "checkedById" TEXT NOT NULL,
  "checkedByName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ConsumptionChargeCheck_organizationId_chargeId_createdAt_idx"
  ON "ConsumptionChargeCheck"("organizationId", "chargeId", "createdAt");
CREATE TRIGGER "ConsumptionChargeCheck_no_update" BEFORE UPDATE ON "ConsumptionChargeCheck"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

-- Samma organisationslås som applikationens kontroll. RC-läsningar görs EFTER
-- låset: en väntande kontroll får aldrig använda en snapshot från före väntan.
-- Trigger omfattar även nästlad Prisma, rå SQL och organisationsstädning.
CREATE FUNCTION lock_consumption_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."organizationId" <> NEW."organizationId" THEN
    RAISE EXCEPTION 'Förbrukningsunderlag får inte flyttas mellan organisationer';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('consumption-gate:' ||
    CASE WHEN TG_OP = 'DELETE' THEN OLD."organizationId" ELSE NEW."organizationId" END, 0));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "MeterReading_consumption_lock" BEFORE INSERT OR UPDATE OR DELETE ON "MeterReading"
  FOR EACH ROW EXECUTE FUNCTION lock_consumption_evidence();
CREATE TRIGGER "MeterReadingReview_consumption_lock" BEFORE INSERT OR UPDATE OR DELETE ON "MeterReadingReview"
  FOR EACH ROW EXECUTE FUNCTION lock_consumption_evidence();
CREATE TRIGGER "ConsumptionCharge_consumption_lock" BEFORE INSERT OR UPDATE OR DELETE ON "ConsumptionCharge"
  FOR EACH ROW EXECUTE FUNCTION lock_consumption_evidence();
