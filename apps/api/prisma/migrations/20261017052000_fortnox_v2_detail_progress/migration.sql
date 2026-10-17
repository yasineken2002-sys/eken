-- V2: en validerad detalj per manifestnyckel, därefter verifierad sidläsning.
-- Ingen reducering, ekonomisk publicering eller aktivering. V1/null bevaras.
-- Ersätter bara guardfunktionernas v2-grenar; inga tabeller eller index ändras.
-- Tjänsten låser connection→run→child. SQL bevisar grundform/progress, inte
-- caller-token eller TS-validatorns fulla radsemantik/stabila SHA.
BEGIN;

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
  pending_key TEXT;
  detail_total INTEGER;
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
      -- Detaljen är framsteget. Leaseändringar faller igenom till tidigare
      -- claim/renew/release-gren; blandad fas- och leaseändring är förbjuden.
      IF OLD."status" = 'RUNNING' AND NEW."status" = 'RUNNING'
         AND OLD."phase" = 'DETAILS'
         AND (NEW."phase" IS DISTINCT FROM OLD."phase"
           OR (to_jsonb(NEW) - ARRAY['phase', 'checkpointUpdatedAt'])
              IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['phase', 'checkpointUpdatedAt'])) THEN
        IF (to_jsonb(NEW) - ARRAY['phase', 'checkpointUpdatedAt'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['phase', 'checkpointUpdatedAt'])
           OR NEW."checkpointUpdatedAt" IS NULL
           OR NEW."checkpointUpdatedAt" < OLD."checkpointUpdatedAt" THEN
          RAISE EXCEPTION 'Invalid v2 detail progress' USING ERRCODE = '23514';
        END IF;
        SELECT "key" INTO pending_key FROM "FortnoxReadVoucherCheckpoint"
          WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId"
            AND "detailDigest" IS NULL ORDER BY "key" COLLATE "C" LIMIT 1;
        expected_phase := CASE WHEN pending_key IS NULL
          THEN 'READY_TO_REDUCE'::"FortnoxReadPhase" ELSE 'DETAILS'::"FortnoxReadPhase" END;
        IF NEW."phase" IS DISTINCT FROM expected_phase THEN
          RAISE EXCEPTION 'V2 detail has wrong next phase' USING ERRCODE = '23514';
        END IF;
        IF pending_key IS NULL THEN
          -- Antalet kontrolleras bara vid sista detaljens fasövergång.
          SELECT "totalResources" INTO detail_total FROM "FortnoxReadManifestPage"
            WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId"
              AND "page" = OLD."nextManifestPage" - 1;
          SELECT count(*) INTO voucher_count FROM "FortnoxReadVoucherCheckpoint"
            WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId";
          IF detail_total IS NULL OR detail_total < 1
             OR voucher_count IS DISTINCT FROM detail_total::bigint THEN
            RAISE EXCEPTION 'V2 detail final coverage is incomplete' USING ERRCODE = '23514';
          END IF;
        END IF;
        SELECT * INTO connection FROM "FortnoxConnection"
          WHERE "id" = OLD."connectionId" AND "organizationId" = OLD."organizationId";
        IF connection."status" IS DISTINCT FROM 'ACTIVE'::"FortnoxConnectionStatus"
           OR connection."generation" IS DISTINCT FROM OLD."connectionGeneration"
           OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM OLD."fortnoxDatabaseNumber"
           OR connection."fortnoxOrgNumber" IS DISTINCT FROM OLD."fortnoxOrgNumber" THEN
          RAISE EXCEPTION 'V2 detail connection changed' USING ERRCODE = '23514';
        END IF;
        now_utc := timezone('UTC', clock_timestamp());
        IF OLD."claimVersion" < 1 OR OLD."claimToken" IS NULL OR OLD."leaseUntil" IS NULL
           OR OLD."leaseUntil" <= now_utc
           OR NEW."checkpointUpdatedAt" > now_utc::timestamp(3) THEN
          RAISE EXCEPTION 'V2 detail requires a current source run lease' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
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

CREATE OR REPLACE FUNCTION fortnox_v2_manifest_child_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_version INTEGER;
  new_version INTEGER;
  run "FortnoxReadRun"%ROWTYPE;
  connection "FortnoxConnection"%ROWTYPE;
  first_manifest "FortnoxReadManifestPage"%ROWTYPE;
  current_manifest "FortnoxReadManifestPage"%ROWTYPE;
  entry JSONB;
  pending_key TEXT;
  detail_day DATE;
  now_utc TIMESTAMP;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD; -- Verklig orgcascade, också när en annan FK redan tagit parent.
    END IF;
    SELECT "workVersion" INTO old_version FROM "FortnoxReadRun"
      WHERE "id" = OLD."runId" AND "organizationId" = OLD."organizationId";
    IF old_version = 2 THEN
      IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'FortnoxReadVoucherCheckpoint' THEN
        -- Childtuple är redan låst. Ta inga nya parentlås här: tjänsten och
        -- en direkt SQL-skrivare ska hålla connection→run före childUPDATE.
        SELECT * INTO run FROM "FortnoxReadRun"
          WHERE "id" = OLD."runId" AND "organizationId" = OLD."organizationId";
        IF run."workVersion" IS DISTINCT FROM 2
           OR run."status" IS DISTINCT FROM 'RUNNING'::"FortnoxReadStatus"
           OR run."phase" IS DISTINCT FROM 'DETAILS'::"FortnoxReadPhase"
           OR (to_jsonb(NEW) - ARRAY['validated', 'detailDigest', 'observedAt'])
              IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['validated', 'detailDigest', 'observedAt'])
           OR OLD."detailDigest" IS NOT NULL OR OLD."validated" IS NOT NULL OR OLD."observedAt" IS NOT NULL
           OR NEW."detailDigest" IS NULL OR NEW."detailDigest" !~ '^[a-f0-9]{64}$'
           OR NEW."observedAt" IS NULL
           OR jsonb_typeof(NEW."validated") IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'V2 detail permits only one scoped pending transition' USING ERRCODE = '23514';
        END IF;
        -- Detta är grundform och fryst bindning, inte en andra ekonomisk
        -- radvalidator. TS kontrollerar ALLA rader och den stabila SHA:n.
        IF NOT (NEW."validated" ?& ARRAY['key', 'date', 'headerDimensionPresent', 'reference', 'rows'])
           OR (NEW."validated" - ARRAY['key', 'date', 'headerDimensionPresent', 'reference', 'rows'])
              IS DISTINCT FROM '{}'::jsonb
           OR jsonb_typeof(NEW."validated"->'key') IS DISTINCT FROM 'string'
           OR NEW."validated"->>'key' IS DISTINCT FROM NEW."key"
           OR split_part(NEW."key", '|', 1) IS DISTINCT FROM run."financialYearId"::text
           OR jsonb_typeof(NEW."validated"->'date') IS DISTINCT FROM 'string'
           OR (NEW."validated"->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           OR jsonb_typeof(NEW."validated"->'headerDimensionPresent') IS DISTINCT FROM 'boolean'
           OR jsonb_typeof(NEW."validated"->'rows') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Invalid v2 detail normal form' USING ERRCODE = '23514';
        END IF;
        IF jsonb_array_length(NEW."validated"->'rows') < 2 THEN
          RAISE EXCEPTION 'V2 detail requires at least two rows' USING ERRCODE = '23514';
        END IF;
        IF NEW."validated"->'reference' IS DISTINCT FROM 'null'::jsonb THEN
          IF jsonb_typeof(NEW."validated"->'reference') IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'Invalid v2 detail reference' USING ERRCODE = '23514';
          END IF;
          IF NOT ((NEW."validated"->'reference') ?& ARRAY['type', 'number'])
             OR ((NEW."validated"->'reference') - ARRAY['type', 'number']) IS DISTINCT FROM '{}'::jsonb
             OR jsonb_typeof(NEW."validated"#>'{reference,type}') NOT IN ('string', 'null')
             OR jsonb_typeof(NEW."validated"#>'{reference,number}') NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'Invalid v2 detail reference' USING ERRCODE = '23514';
          END IF;
        END IF;
        BEGIN
          detail_day := (NEW."validated"->>'date')::date;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          RAISE EXCEPTION 'Invalid v2 detail calendar date' USING ERRCODE = '23514';
        END;
        IF run."financialYearStart" IS NULL OR run."financialYearEnd" IS NULL
           OR detail_day < run."financialYearStart"::date OR detail_day > run."financialYearEnd"::date
           OR to_char(detail_day, 'YYYY-MM-DD') IS DISTINCT FROM NEW."validated"->>'date' THEN
          RAISE EXCEPTION 'V2 detail date is outside its frozen year' USING ERRCODE = '23514';
        END IF;
        SELECT "key" INTO pending_key FROM "FortnoxReadVoucherCheckpoint"
          WHERE "runId" = run."id" AND "organizationId" = run."organizationId"
            AND "detailDigest" IS NULL ORDER BY "key" COLLATE "C" LIMIT 1;
        IF pending_key IS DISTINCT FROM OLD."key" THEN
          RAISE EXCEPTION 'V2 detail must follow pending C order' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO connection FROM "FortnoxConnection"
          WHERE "id" = run."connectionId" AND "organizationId" = run."organizationId";
        IF connection."status" IS DISTINCT FROM 'ACTIVE'::"FortnoxConnectionStatus"
           OR connection."generation" IS DISTINCT FROM run."connectionGeneration"
           OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM run."fortnoxDatabaseNumber"
           OR connection."fortnoxOrgNumber" IS DISTINCT FROM run."fortnoxOrgNumber" THEN
          RAISE EXCEPTION 'V2 detail connection changed' USING ERRCODE = '23514';
        END IF;
        now_utc := timezone('UTC', clock_timestamp());
        IF run."claimVersion" < 1 OR run."claimToken" IS NULL OR run."leaseUntil" IS NULL
           OR run."leaseUntil" <= now_utc
           OR run."checkpointUpdatedAt" IS NULL
           OR NEW."observedAt" < run."checkpointUpdatedAt"
           OR NEW."observedAt" > now_utc::timestamp(3) THEN
          RAISE EXCEPTION 'V2 detail requires current lease and observation time' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
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

CREATE FUNCTION fortnox_v2_detail_must_advance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run "FortnoxReadRun"%ROWTYPE;
  pending_key TEXT;
  expected_phase "FortnoxReadPhase";
BEGIN
  IF OLD."detailDigest" IS NOT NULL OR NEW."detailDigest" IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = NEW."organizationId") THEN RETURN NULL; END IF;
  SELECT * INTO run FROM "FortnoxReadRun"
    WHERE "id" = NEW."runId" AND "organizationId" = NEW."organizationId";
  IF run."workVersion" IS DISTINCT FROM 2 THEN RETURN NULL; END IF;
  SELECT "key" INTO pending_key FROM "FortnoxReadVoucherCheckpoint"
    WHERE "runId" = run."id" AND "organizationId" = run."organizationId"
      AND "detailDigest" IS NULL ORDER BY "key" COLLATE "C" LIMIT 1;
  expected_phase := CASE WHEN pending_key IS NULL
    THEN 'READY_TO_REDUCE'::"FortnoxReadPhase" ELSE 'DETAILS'::"FortnoxReadPhase" END;
  -- Även FAILED: fångat fel efter sista detaljen får inte lämna DETAILS.
  -- Detta bevisar komplett tillstånd, inte historiken av callback/anrop.
  -- Ett komplett giltigt prefix följt av FAILED kan därför bestå.
  IF run."phase" IS DISTINCT FROM expected_phase
     OR run."checkpointUpdatedAt" IS NULL OR NEW."observedAt" IS NULL
     OR run."checkpointUpdatedAt" < NEW."observedAt" THEN
    RAISE EXCEPTION 'V2 detail must have complete progress before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fortnox_v2_detail_must_advance
  AFTER UPDATE ON "FortnoxReadVoucherCheckpoint"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fortnox_v2_detail_must_advance();

COMMIT;
