-- Internal v2 publication only. Legacy/null and v1 branches are preserved exactly.
-- Public/customer/AI consumers remain legacy-only; no activation or HTTP/worker.
-- Replaces the current Run CHECK and run guard atomically. ALTER TABLE takes a
-- write-blocking lock; no production lock-duration/deployment claim is made.
-- Application must DEFER the two named pair constraints before INSERT, write
-- the complete publication then terminal run, SET those constraints IMMEDIATE,
-- and perform a fresh old-lease fence after all SQL before callback return.
-- A separate committed read verifies actual payload/digests; no automatic retry.
BEGIN;

-- Hold the same lock required by the later ALTER before examining old rows.
-- Otherwise a writer could add a reserved outcome after the preflight check.
LOCK TABLE "FortnoxReadRun" IN ACCESS EXCLUSIVE MODE;

-- No previous product path publishes v2. Refuse adoption of a manually written
-- old terminal marker that would otherwise acquire the new reserved meaning.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FortnoxReadRun" WHERE "workVersion" = 2
    AND ("status" IN ('COMPLETE', 'COMPLETE_WITH_UNCERTAINTY')
      OR ("status" = 'FAILED' AND "reason" = 'Beloppssumman ligger utanför säkert talområde'))) THEN
    RAISE EXCEPTION 'Existing v2 outcome needs explicit review before publication migration'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- Whole-result JSON follows result codec version 1. SQL verifies shape/binding,
-- never caller authorization, economic truth or stable content digests.

CREATE TABLE "FortnoxReadPublication" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "FortnoxReadStatus" NOT NULL,
  "failureCode" TEXT,
  "reason" TEXT,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL,
  "binding" JSONB NOT NULL,
  "proof" JSONB NOT NULL,
  "resultDigest" TEXT,
  "canonicalBytes" BIGINT,
  "publicationDigest" TEXT NOT NULL,
  "financialYear" JSONB,
  "summary" JSONB,
  "rows" JSONB,
  "coverage" JSONB,
  "uncertainties" JSONB,
  CONSTRAINT "FortnoxReadPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_publication_shape" CHECK ((
    "formatVersion" = 1
    AND "publicationDigest" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("binding") = 'object'
    AND jsonb_typeof("proof") = 'object'
    AND (
      ("status" IN ('COMPLETE', 'COMPLETE_WITH_UNCERTAINTY')
        AND "failureCode" IS NULL AND "reason" IS NULL
        AND "resultDigest" IS NOT NULL AND "resultDigest" ~ '^[a-f0-9]{64}$'
        AND "canonicalBytes" IS NOT NULL AND "canonicalBytes" BETWEEN 0 AND 9007199254740991
        AND "financialYear" IS NOT NULL AND jsonb_typeof("financialYear") = 'object'
        AND "summary" IS NOT NULL AND jsonb_typeof("summary") = 'object'
        AND "rows" IS NOT NULL AND jsonb_typeof("rows") = 'object'
        AND "coverage" IS NOT NULL AND jsonb_typeof("coverage") = 'object'
        AND "uncertainties" IS NOT NULL AND jsonb_typeof("uncertainties") = 'array')
      OR ("status" = 'FAILED' AND "failureCode" = 'AMOUNT_OVERFLOW'
        AND "reason" = 'Beloppssumman ligger utanför säkert talområde'
        AND "resultDigest" IS NULL AND "canonicalBytes" IS NULL
        AND "financialYear" IS NULL AND "summary" IS NULL AND "rows" IS NULL
        AND "coverage" IS NULL AND "uncertainties" IS NULL)
    )
  ) IS TRUE)
);

CREATE UNIQUE INDEX "FortnoxReadPublication_runId_key" ON "FortnoxReadPublication"("runId");
CREATE UNIQUE INDEX "FortnoxReadPublication_id_organizationId_key" ON "FortnoxReadPublication"("id", "organizationId");
CREATE UNIQUE INDEX "FortnoxReadPublication_runId_organizationId_key" ON "FortnoxReadPublication"("runId", "organizationId");
CREATE INDEX "FortnoxReadPublication_organizationId_idx" ON "FortnoxReadPublication"("organizationId");
ALTER TABLE "FortnoxReadPublication" ADD CONSTRAINT "FortnoxReadPublication_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "FortnoxReadPublication" ADD CONSTRAINT "FortnoxReadPublication_runId_organizationId_fkey"
  FOREIGN KEY ("runId", "organizationId") REFERENCES "FortnoxReadRun"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE FUNCTION fortnox_publication_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run "FortnoxReadRun"%ROWTYPE;
  connection "FortnoxConnection"%ROWTYPE;
  source "FortnoxReadSourceCapture"%ROWTYPE;
  stage "FortnoxReadNormalizationStage"%ROWTYPE;
  snapshot "FortnoxReadContextSnapshot"%ROWTYPE;
  last_manifest "FortnoxReadManifestPage"%ROWTYPE;
  page_count BIGINT;
  first_page INTEGER;
  last_page INTEGER;
  items_seen BIGINT;
  totals_match BOOLEAN;
  voucher_count BIGINT;
  details_complete BOOLEAN;
  digest_field TEXT;
  observed TIMESTAMPTZ;
BEGIN
  -- No publication tuple lock yet. Direct writers and the service use this order.
  SELECT * INTO connection FROM "FortnoxConnection"
    WHERE "organizationId" = NEW."organizationId" FOR UPDATE;
  SELECT * INTO run FROM "FortnoxReadRun"
    WHERE "id" = NEW."runId" AND "organizationId" = NEW."organizationId" FOR UPDATE;
  IF run."id" IS NULL THEN
    RAISE EXCEPTION 'Publication has no scoped run' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO stage FROM "FortnoxReadNormalizationStage"
    WHERE "id" = run."id" AND "runId" = run."id" AND "organizationId" = run."organizationId" FOR UPDATE;
  SELECT * INTO source FROM "FortnoxReadSourceCapture"
    WHERE "id" = run."sourceCaptureId" AND "organizationId" = run."organizationId";
  SELECT * INTO snapshot FROM "FortnoxReadContextSnapshot"
    WHERE "runId" = run."id" AND "organizationId" = run."organizationId";

  IF run."workVersion" IS DISTINCT FROM 2
     OR run."status" IS DISTINCT FROM 'RUNNING'::"FortnoxReadStatus"
     OR run."phase" IS DISTINCT FROM 'READY_TO_REDUCE'::"FortnoxReadPhase"
     OR run."sourceCaptureId" IS DISTINCT FROM run."id"
     OR connection."id" IS DISTINCT FROM run."connectionId"
     OR connection."status" IS DISTINCT FROM 'ACTIVE'::"FortnoxConnectionStatus"
     OR connection."generation" IS DISTINCT FROM run."connectionGeneration"
     OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM run."fortnoxDatabaseNumber"
     OR connection."fortnoxOrgNumber" IS DISTINCT FROM run."fortnoxOrgNumber" THEN
    RAISE EXCEPTION 'Publication requires a ready bound source run' USING ERRCODE = '23514';
  END IF;
  IF source."id" IS DISTINCT FROM run."id" OR source."formatVersion" IS DISTINCT FROM 1
     OR source."sealedAt" IS NULL OR source."requestHash" IS DISTINCT FROM run."requestHash"
     OR source."connectionId" IS DISTINCT FROM run."connectionId"
     OR source."connectionGeneration" IS DISTINCT FROM run."connectionGeneration"
     OR source."fortnoxDatabaseNumber" IS DISTINCT FROM run."fortnoxDatabaseNumber"
     OR source."fortnoxOrgNumber" IS DISTINCT FROM run."fortnoxOrgNumber"
     OR source."input"->'financialYearId' IS DISTINCT FROM to_jsonb(run."financialYearId")
     OR source."input"->'periodFrom' IS DISTINCT FROM to_jsonb(to_char(run."periodFrom", 'YYYY-MM-DD'))
     OR source."input"->'periodTo' IS DISTINCT FROM to_jsonb(to_char(run."periodTo", 'YYYY-MM-DD'))
     OR source."input"->'costAccounts' IS DISTINCT FROM to_jsonb(run."costAccounts")
     OR stage."id" IS NULL OR stage."formatVersion" IS DISTINCT FROM 1
     OR stage."sourceCaptureId" IS DISTINCT FROM source."id"
     OR stage."requestHash" IS DISTINCT FROM source."requestHash"
     OR stage."status" IS DISTINCT FROM 'NORMALIZED' OR stage."normalizedAt" IS NULL
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
     OR snapshot."manifest"#>'{collections,MAPPINGS,pageCount}' IS DISTINCT FROM to_jsonb((source."mappingCount"::bigint + 99) / 100)
     OR snapshot."manifest"#>'{collections,OWN_EXPORTS,pageCount}' IS DISTINCT FROM to_jsonb((source."exportCount"::bigint + 99) / 100)
     OR run."financialYearStart" IS NULL OR run."financialYearEnd" IS NULL
     OR jsonb_typeof(run."catalog") IS DISTINCT FROM 'object'
     OR run."catalog"->'version' IS DISTINCT FROM '1'::jsonb
     OR run."catalog"->'companyDatabaseNumber' IS DISTINCT FROM to_jsonb(run."fortnoxDatabaseNumber")
     OR run."catalog"#>'{financialYear,id}' IS DISTINCT FROM to_jsonb(run."financialYearId")
     OR run."catalog"#>'{financialYear,fromDate}' IS DISTINCT FROM to_jsonb(to_char(run."financialYearStart", 'YYYY-MM-DD'))
     OR run."catalog"#>'{financialYear,toDate}' IS DISTINCT FROM to_jsonb(to_char(run."financialYearEnd", 'YYYY-MM-DD')) THEN
    RAISE EXCEPTION 'Publication frozen context binding is incomplete' USING ERRCODE = '23514';
  END IF;
  -- Exact object equality also rejects missing/extra keys, JSON null and wrong types.
  IF NEW."binding" IS DISTINCT FROM jsonb_build_object(
       'organizationId', run."organizationId", 'runId', run."id",
       'sourceCaptureId', source."id", 'stageId', stage."id", 'requestHash', source."requestHash",
       'input', source."input", 'connection', jsonb_build_object(
         'id', source."connectionId", 'generation', source."connectionGeneration",
         'databaseNumber', source."fortnoxDatabaseNumber", 'orgNumber', source."fortnoxOrgNumber"),
       'counts', jsonb_build_object('MAPPINGS', source."mappingCount", 'OWN_EXPORTS', source."exportCount"))
     OR jsonb_typeof(NEW."proof") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Publication binding or proof has wrong shape' USING ERRCODE = '23514';
  END IF;
  FOREACH digest_field IN ARRAY ARRAY['snapshotDigest', 'sourceDigest', 'catalogDigest', 'manifestDigest', 'detailDigest'] LOOP
    IF jsonb_typeof(NEW."proof"->digest_field) IS DISTINCT FROM 'string'
       OR (NEW."proof"->>digest_field) !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'Publication proof digest has wrong shape' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- Once per publication, not per detail/page. Duplicate manifest appearances
  -- contribute to items_seen; totalResources counts distinct checkpoint keys.
  SELECT * INTO last_manifest FROM "FortnoxReadManifestPage"
    WHERE "runId" = run."id" AND "organizationId" = run."organizationId"
      AND "page" = run."nextManifestPage" - 1;
  SELECT count(*), min("page"), max("page"), coalesce(sum("itemCount"), 0),
    bool_and("totalPages" = last_manifest."totalPages" AND "totalResources" = last_manifest."totalResources")
    INTO page_count, first_page, last_page, items_seen, totals_match
    FROM "FortnoxReadManifestPage" WHERE "runId" = run."id" AND "organizationId" = run."organizationId";
  SELECT count(*), bool_and("detailDigest" IS NOT NULL AND "validated" IS NOT NULL AND "observedAt" IS NOT NULL)
    INTO voucher_count, details_complete FROM "FortnoxReadVoucherCheckpoint"
    WHERE "runId" = run."id" AND "organizationId" = run."organizationId";
  IF last_manifest."id" IS NULL
     OR page_count IS DISTINCT FROM greatest(1, last_manifest."totalPages")::bigint
     OR first_page IS DISTINCT FROM 1 OR last_page IS DISTINCT FROM greatest(1, last_manifest."totalPages")
     OR totals_match IS DISTINCT FROM true
     OR voucher_count IS DISTINCT FROM last_manifest."totalResources"::bigint
     OR (voucher_count > 0 AND details_complete IS DISTINCT FROM true)
     OR NEW."proof" IS DISTINCT FROM jsonb_build_object(
       'version', 1, 'organizationId', run."organizationId", 'runId', run."id",
       'sourceCaptureId', source."id", 'snapshotId', snapshot."id",
       'snapshotDigest', snapshot."digest", 'sourceDigest', snapshot."manifest"->'sourceDigest',
       'catalogDigest', NEW."proof"->'catalogDigest', 'manifestDigest', NEW."proof"->'manifestDigest',
       'detailDigest', NEW."proof"->'detailDigest', 'manifestPageCount', page_count,
       'manifestItemsSeen', items_seen, 'voucherCount', voucher_count, 'claimVersion', run."claimVersion") THEN
    RAISE EXCEPTION 'Publication proof does not match complete stored coverage' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('COMPLETE', 'COMPLETE_WITH_UNCERTAINTY') THEN
    IF jsonb_typeof(NEW."rows") IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Publication rows must be an envelope' USING ERRCODE = '23514';
    END IF;
    IF (NEW."rows" - ARRAY['rows', 'references']) IS DISTINCT FROM '{}'::jsonb
       OR jsonb_typeof(NEW."rows"->'rows') IS DISTINCT FROM 'array'
       OR jsonb_typeof(NEW."rows"->'references') IS DISTINCT FROM 'array'
       OR NEW."financialYear" IS DISTINCT FROM jsonb_build_object(
         'id', run."financialYearId", 'fromDate', to_char(run."financialYearStart", 'YYYY-MM-DD'),
         'toDate', to_char(run."financialYearEnd", 'YYYY-MM-DD')) THEN
      RAISE EXCEPTION 'Publication result envelope or year is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- The table CHECK owns status/null/top-shape. JSONB operators can still
  -- detoast/materialize large values: include that cost in the product probe.
  -- No per-row economic loop/hash or result-payload SELECT/RETURNING is added.
  observed := clock_timestamp();
  IF run."claimVersion" < 1 OR run."claimToken" IS NULL OR run."leaseUntil" IS NULL
     OR run."leaseUntil" <= timezone('UTC', observed) THEN
    RAISE EXCEPTION 'Publication requires the current source run lease' USING ERRCODE = '23514';
  END IF;
  NEW."publishedAt" := observed;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fortnox_publication_insert_guard BEFORE INSERT ON "FortnoxReadPublication"
  FOR EACH ROW EXECUTE FUNCTION fortnox_publication_insert_guard();

CREATE FUNCTION fortnox_publication_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FortnoxReadPublication is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER append_only_fortnox_read_publication BEFORE UPDATE ON "FortnoxReadPublication"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_publication_append_only();
CREATE TRIGGER fortnox_publication_no_truncate BEFORE TRUNCATE ON "FortnoxReadPublication"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_publication_append_only();
CREATE FUNCTION fortnox_publication_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
    RAISE EXCEPTION 'Publication deletion requires actual organization cascade' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER fortnox_publication_delete_guard BEFORE DELETE ON "FortnoxReadPublication"
  FOR EACH ROW EXECUTE FUNCTION fortnox_publication_delete_guard();

CREATE FUNCTION fortnox_assert_publication_pair(run_id TEXT, org_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  run RECORD;
  publication RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = org_id) THEN RETURN; END IF;
  -- Small metadata only, no parent locks and no second result-payload transfer.
  SELECT "id", "workVersion", "phase", "status", "reason", "completedAt", "checkpointUpdatedAt",
         "claimVersion", "claimToken", "leaseUntil" INTO run FROM "FortnoxReadRun"
    WHERE "id" = run_id AND "organizationId" = org_id;
  SELECT "id", "status", "reason", "publishedAt", "proof"->'claimVersion' AS claim_version
    INTO publication FROM "FortnoxReadPublication" WHERE "runId" = run_id AND "organizationId" = org_id;
  IF publication."id" IS NULL THEN
    IF run."id" IS NOT NULL AND run."workVersion" = 2
       AND (run."status" IN ('COMPLETE', 'COMPLETE_WITH_UNCERTAINTY')
         OR run."reason" = 'Beloppssumman ligger utanför säkert talområde') THEN
      RAISE EXCEPTION 'Terminal publication run has no immutable outcome' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  IF run."id" IS NULL OR run."workVersion" IS DISTINCT FROM 2
     OR run."phase" IS DISTINCT FROM 'READY_TO_REDUCE'::"FortnoxReadPhase"
     OR run."status" IS DISTINCT FROM publication."status"
     OR run."reason" IS DISTINCT FROM publication."reason"
     OR run."completedAt" IS DISTINCT FROM timezone('UTC', publication."publishedAt")
     OR run."checkpointUpdatedAt" IS NULL OR run."checkpointUpdatedAt" < run."completedAt"
     OR publication.claim_version IS DISTINCT FROM to_jsonb(run."claimVersion")
     OR run."claimToken" IS NOT NULL OR run."leaseUntil" IS NOT NULL THEN
    RAISE EXCEPTION 'Publication and terminal run must commit as one exact pair' USING ERRCODE = '23514';
  END IF;
END;
$$;
CREATE FUNCTION fortnox_publication_must_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fortnox_assert_publication_pair(NEW."runId", NEW."organizationId");
  RETURN NULL;
END;
$$;
CREATE FUNCTION fortnox_run_publication_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fortnox_assert_publication_pair(NEW."id", NEW."organizationId");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER fortnox_publication_must_finish
  AFTER INSERT ON "FortnoxReadPublication" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fortnox_publication_must_finish();
CREATE CONSTRAINT TRIGGER fortnox_run_publication_required
  AFTER UPDATE ON "FortnoxReadRun" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN ((OLD."workVersion" IS NOT DISTINCT FROM 2 OR NEW."workVersion" IS NOT DISTINCT FROM 2)
    AND (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."reason" IS DISTINCT FROM NEW."reason"))
  EXECUTE FUNCTION fortnox_run_publication_required();


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
        OR ("status" IN ('COMPLETE', 'COMPLETE_WITH_UNCERTAINTY')
          AND "phase" = 'READY_TO_REDUCE' AND "completedAt" IS NOT NULL AND "reason" IS NULL)
      )
    )
  )
);

CREATE OR REPLACE FUNCTION fortnox_source_run_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  publication RECORD;
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
      -- New v2-only dispatch before unchanged 52000 branches. UPDATE already
      -- holds the run tuple. Publication INSERT took connection→run→stage in
      -- this transaction; deferred pair rules forbid a durable orphan row.
      -- Do not acquire parent locks here and do not read the large result JSON.
      IF NEW."status" IN ('COMPLETE', 'COMPLETE_WITH_UNCERTAINTY')
         OR (NEW."status" = 'FAILED'
           AND NEW."reason" = 'Beloppssumman ligger utanför säkert talområde') THEN
        SELECT "id", "status", "reason", "publishedAt", "proof"->'claimVersion' AS claim_version
          INTO publication FROM "FortnoxReadPublication"
          WHERE "runId" = OLD."id" AND "organizationId" = OLD."organizationId";
        IF OLD."status" IS DISTINCT FROM 'RUNNING'::"FortnoxReadStatus"
           OR OLD."phase" IS DISTINCT FROM 'READY_TO_REDUCE'::"FortnoxReadPhase"
           OR NEW."workVersion" IS DISTINCT FROM 2
           OR (to_jsonb(NEW) - ARRAY['status', 'reason', 'completedAt', 'checkpointUpdatedAt', 'claimToken', 'leaseUntil'])
              IS DISTINCT FROM
              (to_jsonb(OLD) - ARRAY['status', 'reason', 'completedAt', 'checkpointUpdatedAt', 'claimToken', 'leaseUntil'])
           OR publication."id" IS NULL
           OR NEW."status" IS DISTINCT FROM publication."status"
           OR NEW."reason" IS DISTINCT FROM publication."reason"
           OR publication.claim_version IS DISTINCT FROM to_jsonb(OLD."claimVersion")
           OR NEW."completedAt" IS DISTINCT FROM timezone('UTC', publication."publishedAt")
           OR NEW."checkpointUpdatedAt" IS NULL OR NEW."checkpointUpdatedAt" < OLD."checkpointUpdatedAt"
           OR NEW."checkpointUpdatedAt" < NEW."completedAt"
           OR NEW."claimToken" IS NOT NULL OR NEW."leaseUntil" IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid v2 publication terminal transition' USING ERRCODE = '23514';
        END IF;
        now_utc := timezone('UTC', clock_timestamp());
        IF OLD."claimVersion" < 1 OR OLD."claimToken" IS NULL OR OLD."leaseUntil" IS NULL
           OR OLD."leaseUntil" <= now_utc
           OR NEW."checkpointUpdatedAt" > now_utc::timestamp(3) THEN
          RAISE EXCEPTION 'Publication terminal transition requires current lease' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
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

COMMIT;
