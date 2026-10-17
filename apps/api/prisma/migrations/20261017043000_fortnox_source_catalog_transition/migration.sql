-- V2:s första konsument: verifierad katalog till MANIFEST/sida1.
-- Ingen ny tabell, HTTP-/providerkoppling, detaljprogress eller publicering.
-- Lease-, terminal-, v1/null-, DELETE/cascade- och TRUNCATE-regler behålls.
-- CHECK-omläggningen tar tabellås; produktionslåstid är inte uppmätt.
BEGIN;


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
      AND "phase" IS NOT NULL AND "phase" IN ('SOURCE_CAPTURED', 'MANIFEST')
      AND "connectionGeneration" IS NOT NULL AND "connectionGeneration" >= 0
      AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[a-f0-9]{64}$'
      AND "checkpointUpdatedAt" IS NOT NULL
      AND "frozenContext" IS NULL
      AND "summary" IS NULL AND "rows" IS NULL
      AND (
        ("phase" = 'SOURCE_CAPTURED' AND "catalog" IS NULL
          AND "financialYearStart" IS NULL AND "financialYearEnd" IS NULL)
        OR ("phase" = 'MANIFEST' AND "catalog" IS NOT NULL
          AND jsonb_typeof("catalog") = 'object'
          AND "financialYearStart" IS NOT NULL AND "financialYearEnd" IS NOT NULL
          AND "financialYearStart" <= "financialYearEnd"
          AND "periodFrom" >= "financialYearStart" AND "periodTo" <= "financialYearEnd")
      )
      AND "coverage" = '{}'::jsonb AND "uncertainties" = '[]'::jsonb
      AND ("claimToken" IS NULL OR ("claimVersion" > 0 AND length("claimToken") > 0))
      AND ("status" = 'RUNNING' OR ("claimToken" IS NULL AND "leaseUntil" IS NULL))
      AND "nextAttemptAt" IS NULL AND "nextManifestPage" = 1
      AND (
        ("status" = 'RUNNING' AND "completedAt" IS NULL AND "reason" IS NULL)
        OR ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "reason" IS NOT NULL)
      )
    )
  )
);

CREATE OR REPLACE FUNCTION fortnox_source_run_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source "FortnoxReadSourceCapture"%ROWTYPE;
  stage "FortnoxReadNormalizationStage"%ROWTYPE;
  snapshot "FortnoxReadContextSnapshot"%ROWTYPE;
  connection "FortnoxConnection"%ROWTYPE;
  now_utc TIMESTAMP := timezone('UTC', clock_timestamp());
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
      IF OLD."status" = 'RUNNING' AND NEW."status" = 'RUNNING'
         AND OLD."phase" = 'SOURCE_CAPTURED' AND NEW."phase" = 'MANIFEST' THEN
        IF (to_jsonb(NEW) - ARRAY['phase', 'catalog', 'financialYearStart',
                                  'financialYearEnd', 'checkpointUpdatedAt'])
           IS DISTINCT FROM
           (to_jsonb(OLD) - ARRAY['phase', 'catalog', 'financialYearStart',
                                  'financialYearEnd', 'checkpointUpdatedAt'])
           OR OLD."catalog" IS NOT NULL OR NEW."catalog" IS NULL
           OR NEW."checkpointUpdatedAt" IS NULL
           OR NEW."checkpointUpdatedAt" < OLD."checkpointUpdatedAt" THEN
          RAISE EXCEPTION 'Invalid source catalog transition' USING ERRCODE = '23514';
        END IF;
        -- UPDATE har redan låst run-raden. Ta INGA nya parentlås här.
        -- Tjänsten håller connection→run och kontrollerar caller-token/version.
        -- SQL skyddar DB-form/bindning/aktuell lease; det är ingen caller-auth.
        SELECT * INTO source FROM "FortnoxReadSourceCapture"
          WHERE "id" = OLD."sourceCaptureId" AND "organizationId" = OLD."organizationId";
        SELECT * INTO stage FROM "FortnoxReadNormalizationStage"
          WHERE "id" = OLD."id" AND "runId" = OLD."id" AND "organizationId" = OLD."organizationId";
        SELECT * INTO snapshot FROM "FortnoxReadContextSnapshot"
          WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId";
        SELECT * INTO connection FROM "FortnoxConnection"
          WHERE "id" = OLD."connectionId" AND "organizationId" = OLD."organizationId";
        IF source."id" IS DISTINCT FROM OLD."id" OR source."formatVersion" IS DISTINCT FROM 1
           OR source."sealedAt" IS NULL OR source."requestHash" IS DISTINCT FROM OLD."requestHash"
           OR stage."sourceCaptureId" IS DISTINCT FROM source."id"
           OR stage."formatVersion" IS DISTINCT FROM 1 OR stage."status" IS DISTINCT FROM 'NORMALIZED'
           OR stage."normalizedAt" IS NULL OR stage."requestHash" IS DISTINCT FROM source."requestHash"
           OR stage."mappingCount" IS DISTINCT FROM source."mappingCount"
           OR stage."exportCount" IS DISTINCT FROM source."exportCount"
           OR stage."mappingsDone" IS DISTINCT FROM source."mappingCount"
           OR stage."exportsDone" IS DISTINCT FROM source."exportCount"
           OR snapshot."id" IS NULL OR snapshot."sealedAt" IS NULL
           OR snapshot."manifest"->'version' IS DISTINCT FROM '1'::jsonb
           OR snapshot."manifest"->'input' IS DISTINCT FROM source."input"
           OR snapshot."manifest"->'connection' IS DISTINCT FROM jsonb_build_object(
                'id', source."connectionId", 'generation', source."connectionGeneration",
                'databaseNumber', source."fortnoxDatabaseNumber", 'orgNumber', source."fortnoxOrgNumber")
           OR snapshot."manifest"#>'{collections,MAPPINGS,itemCount}' IS DISTINCT FROM to_jsonb(source."mappingCount")
           OR snapshot."manifest"#>'{collections,OWN_EXPORTS,itemCount}' IS DISTINCT FROM to_jsonb(source."exportCount")
           OR connection."status" IS DISTINCT FROM 'ACTIVE'::"FortnoxConnectionStatus"
           OR connection."generation" IS DISTINCT FROM OLD."connectionGeneration"
           OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM OLD."fortnoxDatabaseNumber"
           OR connection."fortnoxOrgNumber" IS DISTINCT FROM OLD."fortnoxOrgNumber" THEN
          RAISE EXCEPTION 'Catalog requires a bound sealed normalized context' USING ERRCODE = '23514';
        END IF;
        -- Full katalogpolicy och fulla payloadhashar verifieras av tjänsten.
        -- Ingen cast av okänd JSON: null/feltyp ska inte bli ett CHECK-NULL-hål.
        IF jsonb_typeof(NEW."catalog") IS DISTINCT FROM 'object'
           OR NEW."catalog"->'version' IS DISTINCT FROM '1'::jsonb
           OR NEW."catalog"->'companyDatabaseNumber' IS DISTINCT FROM to_jsonb(OLD."fortnoxDatabaseNumber")
           OR NEW."catalog"#>'{financialYear,id}' IS DISTINCT FROM to_jsonb(OLD."financialYearId")
           OR NEW."financialYearStart" IS NULL OR NEW."financialYearEnd" IS NULL
           OR NEW."catalog"#>'{financialYear,fromDate}' IS DISTINCT FROM to_jsonb(to_char(NEW."financialYearStart", 'YYYY-MM-DD'))
           OR NEW."catalog"#>'{financialYear,toDate}' IS DISTINCT FROM to_jsonb(to_char(NEW."financialYearEnd", 'YYYY-MM-DD'))
           OR (source."input" ? 'financialYearStart' AND
               source."input"->'financialYearStart' IS DISTINCT FROM NEW."catalog"#>'{financialYear,fromDate}')
           OR (source."input" ? 'financialYearEnd' AND
               source."input"->'financialYearEnd' IS DISTINCT FROM NEW."catalog"#>'{financialYear,toDate}') THEN
          RAISE EXCEPTION 'Catalog does not match frozen company and year' USING ERRCODE = '23514';
        END IF;
        now_utc := timezone('UTC', clock_timestamp());
        IF OLD."claimVersion" < 1 OR OLD."claimToken" IS NULL OR OLD."leaseUntil" IS NULL
           OR OLD."leaseUntil" <= now_utc
           OR NEW."checkpointUpdatedAt" > now_utc::timestamp(3) THEN
          RAISE EXCEPTION 'Catalog requires a current source run lease' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      -- Bara anspråk och stopp får ändras. Varken läsning, sista sidan eller
      -- en ny ägare innebär att någon normalisering har blivit klar.
      IF NEW."workVersion" IS DISTINCT FROM 2 OR OLD."status" <> 'RUNNING'
         OR (to_jsonb(NEW) - ARRAY['status', 'reason', 'completedAt', 'checkpointUpdatedAt',
                                  'claimVersion', 'claimToken', 'leaseUntil'])
            IS DISTINCT FROM
            (to_jsonb(OLD) - ARRAY['status', 'reason', 'completedAt', 'checkpointUpdatedAt',
                                  'claimVersion', 'claimToken', 'leaseUntil'])
         OR NEW."checkpointUpdatedAt" IS NULL
         OR NEW."checkpointUpdatedAt" < OLD."checkpointUpdatedAt"
         OR NEW."checkpointUpdatedAt" > now_utc::timestamp(3) THEN
        RAISE EXCEPTION 'Source-bound run identity and progress are immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW."status" = 'FAILED' THEN
        -- Start kan stoppa en historiskt giltig källa vid generationsrotation.
        -- Tjänsten kontrollerar en workers fence innan den får göra samma sak.
        IF NEW."claimVersion" <> OLD."claimVersion"
           OR NEW."claimToken" IS NOT NULL OR NEW."leaseUntil" IS NOT NULL THEN
          RAISE EXCEPTION 'Terminal source run must release its claim' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW."status" <> 'RUNNING'
         OR NEW."reason" IS DISTINCT FROM OLD."reason"
         OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
        RAISE EXCEPTION 'Source run permits no normalization progress' USING ERRCODE = '23514';
      END IF;

      IF (OLD."leaseUntil" IS NULL OR OLD."leaseUntil" <= now_utc)
         AND NEW."claimVersion"::bigint = OLD."claimVersion"::bigint + 1
         AND NEW."claimToken" IS NOT NULL AND length(NEW."claimToken") > 0
         AND NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
         AND NEW."leaseUntil" > now_utc
         AND NEW."leaseUntil" <= now_utc::timestamp(3) + interval '60 seconds' THEN
        RETURN NEW; -- Första anspråk eller en ny ägare efter faktisk DB-utgång.
      END IF;
      IF OLD."leaseUntil" > now_utc AND NEW."claimVersion" = OLD."claimVersion" THEN
        IF NEW."claimToken" IS NOT DISTINCT FROM OLD."claimToken"
           AND NEW."leaseUntil" > OLD."leaseUntil"
           AND NEW."leaseUntil" <= now_utc::timestamp(3) + interval '60 seconds' THEN
          RETURN NEW; -- Bara ett fortfarande giltigt anspråk kan förlängas.
        END IF;
        IF NEW."claimToken" IS NULL AND NEW."leaseUntil" IS NULL THEN
          RETURN NEW; -- Släpp giltigt anspråk utan att återanvända dess version.
        END IF;
      END IF;
      RAISE EXCEPTION 'Invalid source run lease transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."workVersion" IS DISTINCT FROM 2 THEN
    RETURN NEW;
  END IF;
  IF NEW."phase" IS DISTINCT FROM 'SOURCE_CAPTURED'::"FortnoxReadPhase"
     OR NEW."status" <> 'RUNNING' OR NEW."claimVersion" <> 0
     OR NEW."claimToken" IS NOT NULL OR NEW."leaseUntil" IS NOT NULL THEN
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

COMMIT;
