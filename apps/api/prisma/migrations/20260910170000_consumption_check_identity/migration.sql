-- Kontrollrevisioner ordnar spår oberoende av transaktionens starttid.
-- Första migrationen inför tabellen tom, så inga äldre godkännanden uppfinns.
ALTER TABLE "ConsumptionChargeCheck" ADD COLUMN "revision" INTEGER NOT NULL;
CREATE UNIQUE INDEX "ConsumptionChargeCheck_organizationId_chargeId_revision_key"
  ON "ConsumptionChargeCheck"("organizationId", "chargeId", "revision");
CREATE UNIQUE INDEX "ConsumptionCharge_control_identity_key"
  ON "ConsumptionCharge"("organizationId", "id", "meterReadingId");
ALTER TABLE "ConsumptionChargeCheck" DROP CONSTRAINT "ConsumptionChargeCheck_chargeId_fkey";
ALTER TABLE "ConsumptionChargeCheck" ADD CONSTRAINT "ConsumptionChargeCheck_organizationId_chargeId_readingId_fkey"
  FOREIGN KEY ("organizationId", "chargeId", "readingId")
  REFERENCES "ConsumptionCharge"("organizationId", "id", "meterReadingId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "ConsumptionChargeCheck_consumption_lock" BEFORE INSERT OR UPDATE OR DELETE ON "ConsumptionChargeCheck"
  FOR EACH ROW EXECUTE FUNCTION lock_consumption_evidence();
