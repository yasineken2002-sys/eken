-- V2-listmanifest: en avgränsad sida och dess unika nycklar, sedan cursor.
-- Ingen detaljskrivning, reducering, HTTP/provider eller resultatpublicering.
-- Delade tabeller behåller v1/null-beteende; dessa spärrar gäller bara v2.
-- CHECK-omläggningen tar tabellås. Produktionslåstid/kapacitet är inte mätt.
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
      AND "phase" IS NOT NULL AND "phase" IN ('SOURCE_CAPTURED', 'MANIFEST', 'DETAILS', 'READY_TO_REDUCE')
      AND "connectionGeneration" IS NOT NULL AND "connectionGeneration" >= 0
      AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[a-f0-9]{64}$'
      AND "checkpointUpdatedAt" IS NOT NULL
      AND "frozenContext" IS NULL
      AND "summary" IS NULL AND "rows" IS NULL
      AND (
        ("phase" = 'SOURCE_CAPTURED' AND "nextManifestPage" = 1 AND "catalog" IS NULL
          AND "financialYearStart" IS NULL AND "financialYearEnd" IS NULL)
        OR ("phase" IN ('MANIFEST', 'DETAILS', 'READY_TO_REDUCE') AND "catalog" IS NOT NULL
          AND jsonb_typeof("catalog") = 'object'
          AND "financialYearStart" IS NOT NULL AND "financialYearEnd" IS NOT NULL
          AND "financialYearStart" <= "financialYearEnd"
          AND "periodFrom" >= "financialYearStart" AND "periodTo" <= "financialYearEnd")
      )
      AND "coverage" = '{}'::jsonb AND "uncertainties" = '[]'::jsonb
      AND ("claimToken" IS NULL OR ("claimVersion" > 0 AND length("claimToken") > 0))
      AND ("status" = 'RUNNING' OR ("claimToken" IS NULL AND "leaseUntil" IS NULL))
      AND "nextAttemptAt" IS NULL
      AND (
        ("status" = 'RUNNING' AND "completedAt" IS NULL AND "reason" IS NULL)
        OR ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "reason" IS NOT NULL)
      )
    )
  )
);

-- Högst100 entries: bounded medlemskontroll även för en mellansida.
-- Stable-SHA och ursprungligt råsvar verifieras av tjänsten, inte av SQL.
CREATE FUNCTION fortnox_v2_manifest_entries_complete(run_id TEXT, org_id TEXT, page_number INTEGER)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  saved "FortnoxReadManifestPage"%ROWTYPE;
BEGIN
  SELECT * INTO saved FROM "FortnoxReadManifestPage"
    WHERE "runId" = run_id AND "organizationId" = org_id AND "page" = page_number;
  IF saved."id" IS NULL OR jsonb_typeof(saved."entries") IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(saved."entries") AS e(item)
    WHERE NOT EXISTS (SELECT 1 FROM "FortnoxReadVoucherCheckpoint" v
      WHERE v."runId" = run_id AND v."organizationId" = org_id
        AND v."key" = e.item->>'key' AND v."manifestDigest" = e.item->>'digest')
  );
END;
$$;

CREATE OR REPLACE FUNCTION fortnox_source_run_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source "FortnoxReadSourceCapture"%ROWTYPE;
  stage "FortnoxReadNormalizationStage"%ROWTYPE;
  snapshot "FortnoxReadContextSnapshot"%ROWTYPE;
  connection "FortnoxConnection"%ROWTYPE;
  manifest_page "FortnoxReadManifestPage"%ROWTYPE;
  page_count BIGINT;
  first_page INTEGER;
  last_page INTEGER;
  totals_match BOOLEAN;
  voucher_count BIGINT;
  expected_phase "FortnoxReadPhase";
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
      -- En sida och dess nycklar måste finnas innan cursorn kan förbrukas.
      -- UPDATE håller redan run-raden: inga nya överordnade radlås här.
      IF OLD."status" = 'RUNNING' AND NEW."status" = 'RUNNING'
         AND OLD."phase" = 'MANIFEST'
         AND (NEW."phase" IS DISTINCT FROM OLD."phase"
           OR NEW."nextManifestPage" IS DISTINCT FROM OLD."nextManifestPage") THEN
        IF (to_jsonb(NEW) - ARRAY['phase', 'nextManifestPage', 'checkpointUpdatedAt'])
           IS DISTINCT FROM
           (to_jsonb(OLD) - ARRAY['phase', 'nextManifestPage', 'checkpointUpdatedAt'])
           OR NEW."nextManifestPage"::bigint IS DISTINCT FROM OLD."nextManifestPage"::bigint + 1
           OR NEW."checkpointUpdatedAt" IS NULL
           OR NEW."checkpointUpdatedAt" < OLD."checkpointUpdatedAt" THEN
          RAISE EXCEPTION 'Invalid v2 manifest progress' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO manifest_page FROM "FortnoxReadManifestPage"
          WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId"
            AND "page" = OLD."nextManifestPage";
        IF manifest_page."id" IS NULL
           OR NOT fortnox_v2_manifest_entries_complete(OLD."id", OLD."organizationId", OLD."nextManifestPage") THEN
          RAISE EXCEPTION 'V2 manifest page requires all checkpoint keys' USING ERRCODE = '23514';
        END IF;
        IF manifest_page."totalPages" = 0 OR manifest_page."page" = manifest_page."totalPages" THEN
          SELECT count(*), min("page"), max("page"),
            bool_and("totalPages" = manifest_page."totalPages"
                     AND "totalResources" = manifest_page."totalResources")
            INTO page_count, first_page, last_page, totals_match
            FROM "FortnoxReadManifestPage"
            WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId";
          SELECT count(*) INTO voucher_count FROM "FortnoxReadVoucherCheckpoint"
            WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId";
          IF page_count IS DISTINCT FROM greatest(1, manifest_page."totalPages")::bigint
             OR first_page IS DISTINCT FROM 1
             OR last_page IS DISTINCT FROM greatest(1, manifest_page."totalPages")
             OR totals_match IS DISTINCT FROM true
             OR voucher_count IS DISTINCT FROM manifest_page."totalResources"::bigint THEN
            RAISE EXCEPTION 'V2 manifest final coverage is incomplete' USING ERRCODE = '23514';
          END IF;
          expected_phase := CASE WHEN manifest_page."totalResources" = 0
            THEN 'READY_TO_REDUCE'::"FortnoxReadPhase" ELSE 'DETAILS'::"FortnoxReadPhase" END;
        ELSE
          expected_phase := 'MANIFEST';
        END IF;
        IF NEW."phase" IS DISTINCT FROM expected_phase THEN
          RAISE EXCEPTION 'V2 manifest has wrong next phase' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO connection FROM "FortnoxConnection"
          WHERE "id" = OLD."connectionId" AND "organizationId" = OLD."organizationId";
        IF connection."status" IS DISTINCT FROM 'ACTIVE'::"FortnoxConnectionStatus"
           OR connection."generation" IS DISTINCT FROM OLD."connectionGeneration"
           OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM OLD."fortnoxDatabaseNumber"
           OR connection."fortnoxOrgNumber" IS DISTINCT FROM OLD."fortnoxOrgNumber" THEN
          RAISE EXCEPTION 'V2 manifest connection changed' USING ERRCODE = '23514';
        END IF;
        now_utc := timezone('UTC', clock_timestamp());
        IF OLD."claimVersion" < 1 OR OLD."claimToken" IS NULL OR OLD."leaseUntil" IS NULL
           OR OLD."leaseUntil" <= now_utc
           OR NEW."checkpointUpdatedAt" > now_utc::timestamp(3) THEN
          RAISE EXCEPTION 'V2 manifest requires a current source run lease' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
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

-- INSERT tar run före den nya barnraden. Tjänsten har redan connection→run.
-- UPDATE/DELETE tar INGA parentlås; de nekar även ombindning v1/null→v2.
-- SQL kontrollerar DB-bindning/lease; caller-token och connection-lås ägs av
-- tjänsten. Direkt SQL är inte en separat autentiserad nätväg.
CREATE FUNCTION fortnox_v2_manifest_child_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_version INTEGER;
  new_version INTEGER;
  run "FortnoxReadRun"%ROWTYPE;
  connection "FortnoxConnection"%ROWTYPE;
  first_manifest "FortnoxReadManifestPage"%ROWTYPE;
  current_manifest "FortnoxReadManifestPage"%ROWTYPE;
  entry JSONB;
  now_utc TIMESTAMP;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD; -- Verklig orgcascade, också när en annan FK redan tagit parent.
    END IF;
    SELECT "workVersion" INTO old_version FROM "FortnoxReadRun"
      WHERE "id" = OLD."runId" AND "organizationId" = OLD."organizationId";
    IF old_version = 2 THEN
      RAISE EXCEPTION 'V2 manifest children are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      SELECT "workVersion" INTO new_version FROM "FortnoxReadRun"
        WHERE "id" = NEW."runId" AND "organizationId" = NEW."organizationId";
      IF new_version = 2 THEN
        RAISE EXCEPTION 'Existing child cannot adopt a v2 manifest' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    RETURN OLD;
  END IF;

  SELECT "workVersion" INTO new_version FROM "FortnoxReadRun"
    WHERE "id" = NEW."runId" AND "organizationId" = NEW."organizationId";
  IF new_version IS DISTINCT FROM 2 THEN RETURN NEW; END IF;
  SELECT * INTO run FROM "FortnoxReadRun"
    WHERE "id" = NEW."runId" AND "organizationId" = NEW."organizationId" FOR UPDATE;
  IF run."id" IS NULL THEN
    RAISE EXCEPTION 'V2 manifest child has no scoped run' USING ERRCODE = '23503';
  END IF;
  IF run."workVersion" IS DISTINCT FROM 2 OR run."status" IS DISTINCT FROM 'RUNNING'::"FortnoxReadStatus"
     OR run."phase" IS DISTINCT FROM 'MANIFEST'::"FortnoxReadPhase" THEN
    RAISE EXCEPTION 'V2 manifest child requires manifest phase' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO connection FROM "FortnoxConnection"
    WHERE "id" = run."connectionId" AND "organizationId" = run."organizationId";
  IF connection."status" IS DISTINCT FROM 'ACTIVE'::"FortnoxConnectionStatus"
     OR connection."generation" IS DISTINCT FROM run."connectionGeneration"
     OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM run."fortnoxDatabaseNumber"
     OR connection."fortnoxOrgNumber" IS DISTINCT FROM run."fortnoxOrgNumber" THEN
    RAISE EXCEPTION 'V2 manifest child connection changed' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'FortnoxReadManifestPage' THEN
    IF jsonb_typeof(NEW."entries") IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'V2 manifest entries must be an array' USING ERRCODE = '23514';
    END IF;
    IF NEW."page" IS DISTINCT FROM run."nextManifestPage"
       OR NEW."itemCount" IS DISTINCT FROM jsonb_array_length(NEW."entries")
       OR NEW."itemCount" < 0 OR NEW."itemCount" > 100
       OR NEW."digest" !~ '^[a-f0-9]{64}$'
       OR NEW."totalPages" < 0 OR NEW."totalResources" < 0
       OR (NEW."totalPages" = 0 AND (NEW."page" <> 1 OR NEW."totalResources" <> 0 OR NEW."itemCount" <> 0))
       OR (NEW."totalPages" > 0 AND NEW."page" > NEW."totalPages") THEN
      RAISE EXCEPTION 'Invalid v2 manifest page shape or position' USING ERRCODE = '23514';
    END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(NEW."entries") LOOP
      -- Separat typgrind: jsonb-subtraktion av skalär ska aldrig bli ett
      -- oavsiktligt operatorfel beroende på uttrycksutvärderingens ordning.
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid v2 manifest entry' USING ERRCODE = '23514';
      END IF;
      IF jsonb_typeof(entry->'key') IS DISTINCT FROM 'string'
         OR jsonb_typeof(entry->'digest') IS DISTINCT FROM 'string'
         OR (entry - 'key' - 'digest') IS DISTINCT FROM '{}'::jsonb
         OR (entry->>'key') !~ '^[0-9]+\|[A-Za-z0-9]{1,10}\|[0-9]+$'
         OR split_part(entry->>'key', '|', 1) IS DISTINCT FROM run."financialYearId"::text
         OR (entry->>'digest') !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'Invalid v2 manifest entry' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."entries") AS e(item)
      GROUP BY e.item->>'key' HAVING count(DISTINCT e.item->>'digest') > 1) THEN
      RAISE EXCEPTION 'V2 manifest has conflicting duplicate keys' USING ERRCODE = '23514';
    END IF;
    IF NEW."page" > 1 THEN
      SELECT * INTO first_manifest FROM "FortnoxReadManifestPage"
        WHERE "runId" = run."id" AND "organizationId" = run."organizationId" AND "page" = 1;
      IF first_manifest."id" IS NULL
         OR first_manifest."totalPages" IS DISTINCT FROM NEW."totalPages"
         OR first_manifest."totalResources" IS DISTINCT FROM NEW."totalResources" THEN
        RAISE EXCEPTION 'V2 manifest totals changed' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF NEW."detailDigest" IS NOT NULL OR NEW."validated" IS NOT NULL OR NEW."observedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'V2 manifest cannot write voucher details' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO current_manifest FROM "FortnoxReadManifestPage"
      WHERE "runId" = run."id" AND "organizationId" = run."organizationId"
        AND "page" = run."nextManifestPage";
    IF current_manifest."id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(current_manifest."entries") AS e(item)
      WHERE e.item->>'key' = NEW."key" AND e.item->>'digest' = NEW."manifestDigest"
    ) THEN
      RAISE EXCEPTION 'V2 checkpoint must match current manifest entry' USING ERRCODE = '23514';
    END IF;
  END IF;
  now_utc := timezone('UTC', clock_timestamp());
  IF run."claimVersion" < 1 OR run."claimToken" IS NULL OR run."leaseUntil" IS NULL
     OR run."leaseUntil" <= now_utc THEN
    RAISE EXCEPTION 'V2 manifest child requires current lease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fortnox_v2_manifest_page_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadManifestPage"
  FOR EACH ROW EXECUTE FUNCTION fortnox_v2_manifest_child_write_guard();
CREATE TRIGGER fortnox_v2_voucher_checkpoint_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadVoucherCheckpoint"
  FOR EACH ROW EXECUTE FUNCTION fortnox_v2_manifest_child_write_guard();

CREATE FUNCTION fortnox_manifest_page_must_advance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run "FortnoxReadRun"%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = NEW."organizationId") THEN RETURN NULL; END IF;
  SELECT * INTO run FROM "FortnoxReadRun"
    WHERE "id" = NEW."runId" AND "organizationId" = NEW."organizationId";
  IF run."workVersion" IS DISTINCT FROM 2 THEN RETURN NULL; END IF;
  -- Även FAILED måste ha förbrukat insatt sida: fångat child-fel + stopp
  -- får aldrig göra en halv sida beständig. Ingen parentlåsning eller statusbypass.
  IF run."nextManifestPage" <= NEW."page"
     OR NOT fortnox_v2_manifest_entries_complete(NEW."runId", NEW."organizationId", NEW."page") THEN
    RAISE EXCEPTION 'V2 manifest page must advance before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fortnox_manifest_page_must_advance
  AFTER INSERT ON "FortnoxReadManifestPage"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fortnox_manifest_page_must_advance();

CREATE FUNCTION fortnox_v2_manifest_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'FortnoxReadManifestPage' THEN
    IF EXISTS (SELECT 1 FROM "FortnoxReadManifestPage" p JOIN "FortnoxReadRun" r
      ON r."id" = p."runId" AND r."organizationId" = p."organizationId" WHERE r."workVersion" = 2) THEN
      RAISE EXCEPTION 'V2 manifest pages cannot be truncated' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "FortnoxReadVoucherCheckpoint" p JOIN "FortnoxReadRun" r
      ON r."id" = p."runId" AND r."organizationId" = p."organizationId" WHERE r."workVersion" = 2) THEN
      RAISE EXCEPTION 'V2 voucher checkpoints cannot be truncated' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER fortnox_v2_manifest_page_no_truncate BEFORE TRUNCATE ON "FortnoxReadManifestPage"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_v2_manifest_reject_truncate();
CREATE TRIGGER fortnox_v2_voucher_checkpoint_no_truncate BEFORE TRUNCATE ON "FortnoxReadVoucherCheckpoint"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_v2_manifest_reject_truncate();

COMMIT;
