-- Inert start-v2: en run binds till en redan förseglad råkälla i samma transaktion.
-- Ingen normalform, katalog, lease, driver eller ekonomisk publicering införs.
-- Det vanliga indexbygget håller skrivlås på FortnoxReadRun under migrationen.
-- Produktionslåstid är INTE uppmätt; driftsättningen måste planeras separat.
-- Den starkare spärren skapas innan den gamla tas bort; migrationen är atomisk.
BEGIN;

ALTER TABLE "FortnoxReadRun" ADD COLUMN "sourceCaptureId" TEXT;
CREATE UNIQUE INDEX "FortnoxReadRun_sourceCaptureId_key" ON "FortnoxReadRun"("sourceCaptureId");
CREATE UNIQUE INDEX "FortnoxReadRun_sourceCaptureId_organizationId_key"
  ON "FortnoxReadRun"("sourceCaptureId", "organizationId");
ALTER TABLE "FortnoxReadRun" ADD CONSTRAINT "FortnoxReadRun_sourceCaptureId_organizationId_fkey"
  FOREIGN KEY ("sourceCaptureId", "organizationId")
  REFERENCES "FortnoxReadSourceCapture"("id", "organizationId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "fortnox_read_one_managed_running_v2" ON "FortnoxReadRun"("organizationId")
  WHERE "workVersion" IN (1, 2) AND "status" = 'RUNNING';
DROP INDEX "fortnox_read_one_managed_running";
ALTER INDEX "fortnox_read_one_managed_running_v2" RENAME TO "fortnox_read_one_managed_running";

ALTER TABLE "FortnoxReadRun" DROP CONSTRAINT "fortnox_read_checkpoint_shape";
ALTER TABLE "FortnoxReadRun" ADD CONSTRAINT "fortnox_read_checkpoint_shape" CHECK (
  "nextManifestPage" >= 1 AND "claimVersion" >= 0
  AND (("claimToken" IS NULL) = ("leaseUntil" IS NULL))
  AND (
    ("workVersion" IS NULL AND "sourceCaptureId" IS NULL)
    OR (
      -- Samma v1-villkor som tidigare, med uttrycklig avgränsning från v2.
      "workVersion" IS NOT NULL AND "workVersion" = 1 AND "sourceCaptureId" IS NULL
      AND "phase" IS NOT NULL AND "phase" IN ('CATALOG', 'MANIFEST', 'DETAILS', 'READY_TO_REDUCE')
      AND "connectionGeneration" >= 0 AND "connectionGeneration" IS NOT NULL
      AND "requestHash" IS NOT NULL AND "frozenContext" IS NOT NULL
      AND "checkpointUpdatedAt" IS NOT NULL
      AND "summary" IS NULL AND "rows" IS NULL
      AND "status" IN ('RUNNING', 'PARTIAL', 'FAILED', 'AUTH_LOST', 'WRONG_COMPANY')
      AND ("status" <> 'RUNNING' OR "completedAt" IS NULL)
    )
    OR (
      "workVersion" IS NOT NULL AND "workVersion" = 2
      AND "sourceCaptureId" IS NOT NULL AND "sourceCaptureId" = "id"
      AND "phase" IS NOT NULL AND "phase" = 'SOURCE_CAPTURED'
      AND "connectionGeneration" IS NOT NULL AND "connectionGeneration" >= 0
      AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[a-f0-9]{64}$'
      AND "checkpointUpdatedAt" IS NOT NULL
      AND "frozenContext" IS NULL AND "catalog" IS NULL
      AND "summary" IS NULL AND "rows" IS NULL
      AND "financialYearStart" IS NULL AND "financialYearEnd" IS NULL
      AND "coverage" = '{}'::jsonb AND "uncertainties" = '[]'::jsonb
      AND "claimVersion" = 0 AND "claimToken" IS NULL AND "leaseUntil" IS NULL
      AND "nextAttemptAt" IS NULL AND "nextManifestPage" = 1
      AND (
        ("status" = 'RUNNING' AND "completedAt" IS NULL AND "reason" IS NULL)
        OR ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "reason" IS NOT NULL)
      )
    )
  )
);

CREATE FUNCTION fortnox_source_run_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source "FortnoxReadSourceCapture"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."workVersion" = 2
       AND EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
      -- Radering skulle frigöra unique(sourceCaptureId) och tillåta adoption.
      -- Verklig organisationscascade ser en redan borttagen org och tillåts.
      RAISE EXCEPTION 'Source-bound run cannot be deleted directly' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."workVersion" IS DISTINCT FROM 2 AND NEW."workVersion" = 2 THEN
      RAISE EXCEPTION 'Existing run cannot adopt a frozen source' USING ERRCODE = '23514';
    END IF;
    IF OLD."workVersion" = 2 THEN
      -- Enda uppdateringen i detta paket är RUNNING→FAILED. Alla frysta fält
      -- inklusive id/org/version/source/initiator/starttid förblir identiska.
      IF NEW."workVersion" IS DISTINCT FROM 2
         OR OLD."status" <> 'RUNNING' OR NEW."status" <> 'FAILED'
         OR (to_jsonb(NEW) - ARRAY['status', 'reason', 'completedAt', 'checkpointUpdatedAt'])
            IS DISTINCT FROM
            (to_jsonb(OLD) - ARRAY['status', 'reason', 'completedAt', 'checkpointUpdatedAt']) THEN
        RAISE EXCEPTION 'Source-bound run identity and progress are immutable' USING ERRCODE = '23514';
      END IF;
      -- Källan kontrollerades vid INSERT och kan inte ändras/raderas fristående.
      -- Ett stopp får därför ske även efter anslutningsbyte; ingen live-FK finns.
      RETURN NEW;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."workVersion" IS DISTINCT FROM 2 THEN
    RETURN NEW;
  END IF;
  IF NEW."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'Source-bound run must start running' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO source FROM "FortnoxReadSourceCapture"
    WHERE "id" = NEW."sourceCaptureId" AND "organizationId" = NEW."organizationId"
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source-bound run has no scoped source' USING ERRCODE = '23503';
  END IF;
  IF source."formatVersion" <> 1 OR source."sealedAt" IS NULL
     OR source."connectionId" IS DISTINCT FROM NEW."connectionId"
     OR source."connectionGeneration" IS DISTINCT FROM NEW."connectionGeneration"
     OR source."fortnoxDatabaseNumber" IS DISTINCT FROM NEW."fortnoxDatabaseNumber"
     OR source."fortnoxOrgNumber" IS DISTINCT FROM NEW."fortnoxOrgNumber"
     OR source."requestHash" IS DISTINCT FROM NEW."requestHash"
     OR source."input"->'financialYearId' IS DISTINCT FROM to_jsonb(NEW."financialYearId")
     OR source."input"->'periodFrom' IS DISTINCT FROM to_jsonb(to_char(NEW."periodFrom", 'YYYY-MM-DD'))
     OR source."input"->'periodTo' IS DISTINCT FROM to_jsonb(to_char(NEW."periodTo", 'YYYY-MM-DD'))
     OR source."input"->'costAccounts' IS DISTINCT FROM to_jsonb(NEW."costAccounts") THEN
    RAISE EXCEPTION 'Source-bound run does not match its sealed source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fortnox_source_run_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadRun"
  FOR EACH ROW EXECUTE FUNCTION fortnox_source_run_write_guard();

-- TRUNCATE får inte kringgå v2-radernas DELETE-spärr. Äldre v1/null-regler ändras
-- inte när tabellen saknar v2; deras befintliga FK/childspärrar gäller fortfarande.
CREATE FUNCTION fortnox_source_run_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FortnoxReadRun" WHERE "workVersion" = 2) THEN
    RAISE EXCEPTION 'Source-bound runs cannot be truncated' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER fortnox_source_run_no_truncate BEFORE TRUNCATE ON "FortnoxReadRun"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_source_run_reject_truncate();

COMMIT;
