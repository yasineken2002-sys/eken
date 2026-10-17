-- Inert sidvis normalisering av en förseglad v2-källa. Ingen driver, HTTP,
-- sourceDigest eller ekonomisk publicering. Befintliga seals ändras inte.
-- Ett sid-INSERT och dess räknarsteg är en enda atomisk SQL-operation.
BEGIN;

CREATE TABLE "FortnoxReadNormalizationStage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "sourceCaptureId" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "requestHash" TEXT NOT NULL,
  "mappingCount" INTEGER NOT NULL,
  "exportCount" INTEGER NOT NULL,
  "mappingsDone" INTEGER NOT NULL DEFAULT 0,
  "exportsDone" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "normalizedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FortnoxReadNormalizationStage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_normalization_stage_shape" CHECK (
    "id" = "runId" AND "runId" = "sourceCaptureId" AND "formatVersion" = 1
    AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND "mappingCount" >= 0 AND "exportCount" >= 0
    AND "mappingsDone" BETWEEN 0 AND "mappingCount"
    AND "exportsDone" BETWEEN 0 AND "exportCount"
    AND ("exportsDone" = 0 OR "mappingsDone" = "mappingCount")
    AND (
      ("status" = 'NORMALIZING' AND "normalizedAt" IS NULL
       AND ("mappingsDone" < "mappingCount" OR "exportsDone" < "exportCount"))
      OR ("status" = 'NORMALIZED' AND "normalizedAt" IS NOT NULL
          AND "mappingsDone" = "mappingCount" AND "exportsDone" = "exportCount")
    )
  )
);
CREATE UNIQUE INDEX "FortnoxReadNormalizationStage_runId_key"
  ON "FortnoxReadNormalizationStage"("runId");
CREATE UNIQUE INDEX "FortnoxReadNormalizationStage_sourceCaptureId_key"
  ON "FortnoxReadNormalizationStage"("sourceCaptureId");
CREATE UNIQUE INDEX "FortnoxReadNormalizationStage_id_organizationId_key"
  ON "FortnoxReadNormalizationStage"("id", "organizationId");
CREATE UNIQUE INDEX "FortnoxReadNormalizationStage_runId_organizationId_key"
  ON "FortnoxReadNormalizationStage"("runId", "organizationId");
CREATE UNIQUE INDEX "FortnoxReadNormalizationStage_sourceCaptureId_organizationI_key"
  ON "FortnoxReadNormalizationStage"("sourceCaptureId", "organizationId");
CREATE INDEX "FortnoxReadNormalizationStage_organizationId_idx"
  ON "FortnoxReadNormalizationStage"("organizationId");
ALTER TABLE "FortnoxReadNormalizationStage" ADD CONSTRAINT "FortnoxReadNormalizationStage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadNormalizationStage" ADD CONSTRAINT "FortnoxReadNormalizationStage_runId_organizationId_fkey"
  FOREIGN KEY ("runId", "organizationId") REFERENCES "FortnoxReadRun"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadNormalizationStage" ADD CONSTRAINT "FortnoxReadNormalizationStage_sourceCaptureId_organization_fkey"
  FOREIGN KEY ("sourceCaptureId", "organizationId") REFERENCES "FortnoxReadSourceCapture"("id", "organizationId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "FortnoxReadNormalizationPage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "stageId" TEXT NOT NULL,
  "kind" "FortnoxReadContextKind" NOT NULL,
  "afterOrdinal" BIGINT NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  "items" JSONB NOT NULL,
  CONSTRAINT "FortnoxReadNormalizationPage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_normalization_page_shape" CHECK (
    "afterOrdinal" >= 0 AND "afterOrdinal" % 100 = 0
    AND "itemCount" BETWEEN 1 AND 100 AND "digest" ~ '^[a-f0-9]{64}$'
    AND CASE WHEN jsonb_typeof("items") = 'array'
      THEN jsonb_array_length("items") = "itemCount" ELSE FALSE END
  )
);
CREATE UNIQUE INDEX "FortnoxReadNormalizationPage_stageId_kind_afterOrdinal_key"
  ON "FortnoxReadNormalizationPage"("stageId", "kind", "afterOrdinal");
CREATE INDEX "FortnoxReadNormalizationPage_organizationId_idx"
  ON "FortnoxReadNormalizationPage"("organizationId");
ALTER TABLE "FortnoxReadNormalizationPage" ADD CONSTRAINT "FortnoxReadNormalizationPage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadNormalizationPage" ADD CONSTRAINT "FortnoxReadNormalizationPage_stageId_organizationId_fkey"
  FOREIGN KEY ("stageId", "organizationId") REFERENCES "FortnoxReadNormalizationStage"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SQL skyddar den verkliga DB-leasens livscykel. Tjänsten måste dessutom
-- kontrollera callerens exakta token/version; den här funktionen är ingen auth.
CREATE FUNCTION fortnox_normalization_lock_run(org_id TEXT, run_id TEXT)
RETURNS "FortnoxReadRun" LANGUAGE plpgsql AS $$
DECLARE
  connection "FortnoxConnection"%ROWTYPE;
  run "FortnoxReadRun"%ROWTYPE;
BEGIN
  -- Samma ordning som start/claim: connection → run → stage hos anroparen.
  SELECT * INTO connection FROM "FortnoxConnection"
    WHERE "organizationId" = org_id FOR UPDATE;
  SELECT * INTO run FROM "FortnoxReadRun"
    WHERE "id" = run_id AND "organizationId" = org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Normalization has no scoped run' USING ERRCODE = '23503';
  END IF;
  IF run."workVersion" IS DISTINCT FROM 2 OR run."status" <> 'RUNNING'
     OR run."phase" IS DISTINCT FROM 'SOURCE_CAPTURED'::"FortnoxReadPhase"
     OR run."sourceCaptureId" IS DISTINCT FROM run."id"
     OR run."claimVersion" < 1 OR run."claimToken" IS NULL
     OR run."leaseUntil" IS NULL OR run."leaseUntil" <= timezone('UTC', clock_timestamp())
     OR connection."id" IS NULL OR connection."status" <> 'ACTIVE'
     OR connection."id" IS DISTINCT FROM run."connectionId"
     OR connection."generation" IS DISTINCT FROM run."connectionGeneration"
     OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM run."fortnoxDatabaseNumber"
     OR connection."fortnoxOrgNumber" IS DISTINCT FROM run."fortnoxOrgNumber" THEN
    RAISE EXCEPTION 'Normalization requires the current source run lease' USING ERRCODE = '23514';
  END IF;
  RETURN run;
END;
$$;

CREATE FUNCTION fortnox_normalization_stage_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run "FortnoxReadRun"%ROWTYPE;
  source "FortnoxReadSourceCapture"%ROWTYPE;
  next_kind "FortnoxReadContextKind";
  next_after BIGINT;
  next_size INTEGER;
  stored_size INTEGER;
  kind_name "FortnoxReadContextKind";
  expected_items BIGINT;
  expected_pages BIGINT;
  stored_pages BIGINT;
  first_after BIGINT;
  last_after BIGINT;
  stored_items BIGINT;
  sizes_match BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Normalization stage cannot be deleted directly' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Gäller även tom källa: 0/0 är ingen genväg för en utgången lease.
    run := fortnox_normalization_lock_run(NEW."organizationId", NEW."runId");
    SELECT * INTO source FROM "FortnoxReadSourceCapture"
      WHERE "id" = NEW."sourceCaptureId" AND "organizationId" = NEW."organizationId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Normalization has no scoped source' USING ERRCODE = '23503';
    END IF;
    IF NEW."id" IS DISTINCT FROM run."id" OR NEW."sourceCaptureId" IS DISTINCT FROM run."sourceCaptureId"
       OR source."formatVersion" <> 1 OR source."sealedAt" IS NULL
       OR source."requestHash" IS DISTINCT FROM run."requestHash"
       OR NEW."requestHash" IS DISTINCT FROM source."requestHash"
       OR NEW."mappingCount" IS DISTINCT FROM source."mappingCount"
       OR NEW."exportCount" IS DISTINCT FROM source."exportCount"
       OR NEW."mappingsDone" IS DISTINCT FROM 0 OR NEW."exportsDone" IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Normalization stage does not match its frozen source' USING ERRCODE = '23514';
    END IF;
    IF NEW."mappingCount" = 0 AND NEW."exportCount" = 0 THEN
      IF NEW."status" IS DISTINCT FROM 'NORMALIZED' OR NEW."normalizedAt" IS NULL THEN
        RAISE EXCEPTION 'Empty normalization must start normalized' USING ERRCODE = '23514';
      END IF;
      NEW."normalizedAt" := clock_timestamp();
    ELSIF NEW."status" IS DISTINCT FROM 'NORMALIZING' OR NEW."normalizedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Normalization must start without progress' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Inget connection/run-lås här: headern är redan låst. Nästa sidrad är
  -- beviset för exakt ett räknarsteg; en äldre sida kan aldrig återanvändas.
  IF OLD."status" <> 'NORMALIZING'
     OR (to_jsonb(NEW) - ARRAY['mappingsDone', 'exportsDone', 'status', 'normalizedAt'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['mappingsDone', 'exportsDone', 'status', 'normalizedAt']) THEN
    RAISE EXCEPTION 'Normalization identity and completed progress are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."mappingsDone" < OLD."mappingCount" THEN
    next_kind := 'MAPPINGS';
    next_after := OLD."mappingsDone";
    next_size := least(100, OLD."mappingCount" - OLD."mappingsDone");
    IF NEW."mappingsDone" IS DISTINCT FROM OLD."mappingsDone" + next_size
       OR NEW."exportsDone" IS DISTINCT FROM OLD."exportsDone" THEN
      RAISE EXCEPTION 'Normalization mapping progress must advance exactly one page' USING ERRCODE = '23514';
    END IF;
  ELSE
    next_kind := 'OWN_EXPORTS';
    next_after := OLD."exportsDone";
    next_size := least(100, OLD."exportCount" - OLD."exportsDone");
    IF next_size <= 0 OR NEW."exportsDone" IS DISTINCT FROM OLD."exportsDone" + next_size
       OR NEW."mappingsDone" IS DISTINCT FROM OLD."mappingsDone" THEN
      RAISE EXCEPTION 'Normalization export progress must advance exactly one page' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "itemCount" INTO stored_size FROM "FortnoxReadNormalizationPage"
    WHERE "stageId" = OLD."id" AND "organizationId" = OLD."organizationId"
      AND "kind" = next_kind AND "afterOrdinal" = next_after;
  IF NOT FOUND OR stored_size <> next_size THEN
    RAISE EXCEPTION 'Normalization progress has no matching new page' USING ERRCODE = '23514';
  END IF;

  IF NEW."mappingsDone" < NEW."mappingCount" OR NEW."exportsDone" < NEW."exportCount" THEN
    IF NEW."status" IS DISTINCT FROM 'NORMALIZING' OR NEW."normalizedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Normalization cannot finish with incomplete counts' USING ERRCODE = '23514';
    END IF;
    RETURN NEW; -- Ingen fullsvepning för vanliga sidor.
  END IF;
  IF NEW."status" IS DISTINCT FROM 'NORMALIZED' OR NEW."normalizedAt" IS NULL THEN
    RAISE EXCEPTION 'Final normalization page must complete the stage' USING ERRCODE = '23514';
  END IF;

  -- En enda slutlig metadata-svepning. BIGINT före +99 och multiplikation:
  -- antalet får vara INT_MAX utan att giltig mängd överflödar INTEGER.
  FOREACH kind_name IN ARRAY ARRAY['MAPPINGS', 'OWN_EXPORTS']::"FortnoxReadContextKind"[] LOOP
    expected_items := CASE WHEN kind_name = 'MAPPINGS' THEN NEW."mappingCount" ELSE NEW."exportCount" END;
    expected_pages := (expected_items + 99) / 100;
    SELECT count(*), min("afterOrdinal"), max("afterOrdinal"), coalesce(sum("itemCount"), 0),
           coalesce(bool_and("itemCount" = least(100::bigint, expected_items - "afterOrdinal")), TRUE)
      INTO stored_pages, first_after, last_after, stored_items, sizes_match
      FROM "FortnoxReadNormalizationPage"
      WHERE "stageId" = NEW."id" AND "organizationId" = NEW."organizationId" AND "kind" = kind_name;
    -- Unika icke-negativa multiplar av100 + count/min/max ger precis 0,100,...
    IF stored_pages <> expected_pages OR stored_items <> expected_items OR NOT sizes_match
       OR (expected_pages > 0 AND (first_after <> 0 OR last_after <> (expected_pages - 1) * 100)) THEN
      RAISE EXCEPTION 'Normalization pages are incomplete or inconsistent' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  NEW."normalizedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION fortnox_normalization_page_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent "FortnoxReadNormalizationStage"%ROWTYPE;
  run "FortnoxReadRun"%ROWTYPE;
  next_kind "FortnoxReadContextKind";
  next_after BIGINT;
  next_size INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Normalization page cannot be deleted directly' USING ERRCODE = '23514';
  END IF;
  -- Identiteten kan läsas olåst: den är oföränderlig. Lås aldrig stage före run.
  SELECT * INTO parent FROM "FortnoxReadNormalizationStage"
    WHERE "id" = NEW."stageId" AND "organizationId" = NEW."organizationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Normalization page has no scoped stage' USING ERRCODE = '23503';
  END IF;
  run := fortnox_normalization_lock_run(NEW."organizationId", parent."runId");
  SELECT * INTO parent FROM "FortnoxReadNormalizationStage"
    WHERE "id" = NEW."stageId" AND "organizationId" = NEW."organizationId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Normalization page lost its scoped stage' USING ERRCODE = '23503';
  END IF;
  -- DB-tiden tas igen EFTER alla lås, även om headerlåset fick vänta.
  IF run."leaseUntil" <= timezone('UTC', clock_timestamp()) OR parent."status" <> 'NORMALIZING' THEN
    RAISE EXCEPTION 'Normalization page requires an unfinished stage and current lease' USING ERRCODE = '23514';
  END IF;
  IF parent."mappingsDone" < parent."mappingCount" THEN
    next_kind := 'MAPPINGS';
    next_after := parent."mappingsDone";
    next_size := least(100, parent."mappingCount" - parent."mappingsDone");
  ELSE
    next_kind := 'OWN_EXPORTS';
    next_after := parent."exportsDone";
    next_size := least(100, parent."exportCount" - parent."exportsDone");
  END IF;
  IF NEW."kind" IS DISTINCT FROM next_kind OR NEW."afterOrdinal" IS DISTINCT FROM next_after
     OR NEW."itemCount" IS DISTINCT FROM next_size OR next_size <= 0 THEN
    RAISE EXCEPTION 'Normalization page must be exactly the next frozen slice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fortnox_normalization_advance_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Ovillkorligt steg. En manuell header-UPDATE i en data-modifying CTE får
  -- inte ersätta detta steg: den skulle göra steget till en otillåten no-op.
  UPDATE "FortnoxReadNormalizationStage"
    SET "mappingsDone" = "mappingsDone" + CASE WHEN NEW."kind" = 'MAPPINGS' THEN NEW."itemCount" ELSE 0 END,
        "exportsDone" = "exportsDone" + CASE WHEN NEW."kind" = 'OWN_EXPORTS' THEN NEW."itemCount" ELSE 0 END,
        "status" = CASE
          WHEN "mappingsDone" + CASE WHEN NEW."kind" = 'MAPPINGS' THEN NEW."itemCount" ELSE 0 END = "mappingCount"
           AND "exportsDone" + CASE WHEN NEW."kind" = 'OWN_EXPORTS' THEN NEW."itemCount" ELSE 0 END = "exportCount"
          THEN 'NORMALIZED' ELSE 'NORMALIZING' END,
        "normalizedAt" = CASE
          WHEN "mappingsDone" + CASE WHEN NEW."kind" = 'MAPPINGS' THEN NEW."itemCount" ELSE 0 END = "mappingCount"
           AND "exportsDone" + CASE WHEN NEW."kind" = 'OWN_EXPORTS' THEN NEW."itemCount" ELSE 0 END = "exportCount"
          THEN clock_timestamp() ELSE NULL END
    WHERE "id" = NEW."stageId" AND "organizationId" = NEW."organizationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Normalization page cannot lose its progress step' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION fortnox_normalization_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Normalization pages are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE FUNCTION fortnox_normalization_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Normalization history cannot be truncated' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER fortnox_normalization_stage_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadNormalizationStage"
  FOR EACH ROW EXECUTE FUNCTION fortnox_normalization_stage_write_guard();
CREATE TRIGGER fortnox_normalization_page_write_guard
  BEFORE INSERT OR DELETE ON "FortnoxReadNormalizationPage"
  FOR EACH ROW EXECUTE FUNCTION fortnox_normalization_page_write_guard();
CREATE TRIGGER fortnox_normalization_page_advance
  AFTER INSERT ON "FortnoxReadNormalizationPage"
  FOR EACH ROW EXECUTE FUNCTION fortnox_normalization_advance_page();
CREATE TRIGGER append_only_fortnox_read_normalization_page
  BEFORE UPDATE ON "FortnoxReadNormalizationPage"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_normalization_reject_update();
CREATE TRIGGER fortnox_normalization_stage_no_truncate BEFORE TRUNCATE ON "FortnoxReadNormalizationStage"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_normalization_reject_truncate();
CREATE TRIGGER fortnox_normalization_page_no_truncate BEFORE TRUNCATE ON "FortnoxReadNormalizationPage"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_normalization_reject_truncate();

COMMIT;
