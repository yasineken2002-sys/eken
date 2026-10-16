-- Inert sidlagring av redan fryst v1-kontext. Ändrar ingen befintlig körningsrad,
-- workVersion-regel, lease eller endpoint. Hasharnas innehåll verifieras i TS;
-- SQL skyddar sidmängd, försegling, organisationsbindning och immutabilitet.
CREATE TYPE "FortnoxReadContextKind" AS ENUM ('MAPPINGS', 'OWN_EXPORTS');

CREATE TABLE "FortnoxReadContextSnapshot" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "digest" TEXT NOT NULL,
  "sealedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FortnoxReadContextSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_context_snapshot_shape" CHECK (
    jsonb_typeof("manifest") = 'object' AND "digest" ~ '^[a-f0-9]{64}$'
  )
);
CREATE UNIQUE INDEX "FortnoxReadContextSnapshot_runId_key" ON "FortnoxReadContextSnapshot"("runId");
CREATE UNIQUE INDEX "FortnoxReadContextSnapshot_id_organizationId_key" ON "FortnoxReadContextSnapshot"("id", "organizationId");
CREATE UNIQUE INDEX "FortnoxReadContextSnapshot_runId_organizationId_key" ON "FortnoxReadContextSnapshot"("runId", "organizationId");
CREATE INDEX "FortnoxReadContextSnapshot_organizationId_idx" ON "FortnoxReadContextSnapshot"("organizationId");
ALTER TABLE "FortnoxReadContextSnapshot" ADD CONSTRAINT "FortnoxReadContextSnapshot_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadContextSnapshot" ADD CONSTRAINT "FortnoxReadContextSnapshot_runId_organizationId_fkey"
  FOREIGN KEY ("runId", "organizationId") REFERENCES "FortnoxReadRun"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FortnoxReadContextPage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "kind" "FortnoxReadContextKind" NOT NULL,
  "page" INTEGER NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  "items" JSONB NOT NULL,
  CONSTRAINT "FortnoxReadContextPage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_context_page_shape" CHECK (
    "page" >= 1 AND "itemCount" BETWEEN 1 AND 100
    AND "digest" ~ '^[a-f0-9]{64}$'
    AND CASE WHEN jsonb_typeof("items") = 'array'
      THEN jsonb_array_length("items") = "itemCount" ELSE FALSE END
  )
);
CREATE UNIQUE INDEX "FortnoxReadContextPage_snapshotId_kind_page_key" ON "FortnoxReadContextPage"("snapshotId", "kind", "page");
CREATE INDEX "FortnoxReadContextPage_organizationId_idx" ON "FortnoxReadContextPage"("organizationId");
ALTER TABLE "FortnoxReadContextPage" ADD CONSTRAINT "FortnoxReadContextPage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadContextPage" ADD CONSTRAINT "FortnoxReadContextPage_snapshotId_organizationId_fkey"
  FOREIGN KEY ("snapshotId", "organizationId") REFERENCES "FortnoxReadContextSnapshot"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION fortnox_context_snapshot_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind_name TEXT;
  collection_manifest JSONB;
  declared_items NUMERIC;
  declared_pages NUMERIC;
  expected_items BIGINT;
  expected_pages BIGINT;
  stored_pages BIGINT;
  first_page INTEGER;
  last_page INTEGER;
  stored_items BIGINT;
  sizes_match BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sealedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Snapshot must be created unsealed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Riktig FK-cascade ser sin redan borttagna förälder i samma transaktion.
    -- Ingen trigger-depth-genväg till direkt radering av levande bevis.
    IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId")
       OR NOT EXISTS (SELECT 1 FROM "FortnoxReadRun"
                      WHERE "id" = OLD."runId" AND "organizationId" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Frozen context snapshot cannot be deleted directly' USING ERRCODE = '23514';
  END IF;

  -- Enda tillåtna UPDATE är den första förseglingen. Även den oförseglade
  -- headerns identitet, manifest och digest är redan bestämda.
  IF OLD."sealedAt" IS NOT NULL OR NEW."sealedAt" IS NULL
     OR (to_jsonb(NEW) - 'sealedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'sealedAt') THEN
    RAISE EXCEPTION 'Frozen context snapshot is immutable except for its first seal' USING ERRCODE = '23514';
  END IF;

  IF NEW."manifest"->'version' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(NEW."manifest"->'collections') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid frozen context collections' USING ERRCODE = '23514';
  END IF;

  FOREACH kind_name IN ARRAY ARRAY['MAPPINGS', 'OWN_EXPORTS'] LOOP
    collection_manifest := jsonb_extract_path(NEW."manifest", 'collections', kind_name);
    IF jsonb_typeof(collection_manifest) IS DISTINCT FROM 'object'
       OR jsonb_typeof(collection_manifest->'itemCount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(collection_manifest->'pageCount') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid frozen context collection counts' USING ERRCODE = '23514';
    END IF;
    declared_items := (collection_manifest->>'itemCount')::numeric;
    declared_pages := (collection_manifest->>'pageCount')::numeric;
    IF declared_items < 0 OR declared_items > 9007199254740991
       OR declared_pages < 0 OR declared_pages > 9007199254740991
       OR declared_items <> trunc(declared_items) OR declared_pages <> trunc(declared_pages) THEN
      RAISE EXCEPTION 'Invalid frozen context collection counts' USING ERRCODE = '23514';
    END IF;
    expected_items := declared_items::bigint;
    expected_pages := declared_pages::bigint;
    IF expected_pages <> (expected_items + 99) / 100 THEN
      RAISE EXCEPTION 'Frozen context page count does not match its items' USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(p."page"), max(p."page"), coalesce(sum(p."itemCount"), 0),
           coalesce(bool_and(p."itemCount" = CASE
             WHEN p."page" < expected_pages THEN 100
             WHEN p."page" = expected_pages THEN expected_items - 100 * (expected_pages - 1)
             ELSE -1 END), TRUE)
      INTO stored_pages, first_page, last_page, stored_items, sizes_match
      FROM "FortnoxReadContextPage" p
      WHERE p."snapshotId" = NEW."id" AND p."organizationId" = NEW."organizationId"
        AND p."kind" = kind_name::"FortnoxReadContextKind";
    IF stored_pages <> expected_pages OR stored_items <> expected_items OR NOT sizes_match
       OR (expected_pages > 0 AND (first_page <> 1 OR last_page <> expected_pages)) THEN
      RAISE EXCEPTION 'Frozen context pages are incomplete or inconsistent' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fortnox_context_page_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_sealed_at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId")
       OR NOT EXISTS (SELECT 1 FROM "FortnoxReadContextSnapshot"
                      WHERE "id" = OLD."snapshotId" AND "organizationId" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Frozen context page cannot be deleted directly' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Frozen context page is immutable' USING ERRCODE = '23514';
  END IF;

  -- Samma header-radlås som UPDATE/seal; ingen INSERT kan passera förseglingen.
  SELECT "sealedAt" INTO parent_sealed_at FROM "FortnoxReadContextSnapshot"
    WHERE "id" = NEW."snapshotId" AND "organizationId" = NEW."organizationId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Frozen context page has no scoped snapshot' USING ERRCODE = '23503';
  END IF;
  IF parent_sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Frozen context snapshot is already sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fortnox_context_snapshot_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadContextSnapshot"
  FOR EACH ROW EXECUTE FUNCTION fortnox_context_snapshot_write_guard();
CREATE TRIGGER fortnox_context_page_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadContextPage"
  FOR EACH ROW EXECUTE FUNCTION fortnox_context_page_write_guard();

-- Även om en caller fångar ett JS-fel måste hela frysningen ha förseglats vid
-- commit. Läs den aktuella raden, inte INSERT-eventets äldre NEW.sealedAt.
CREATE FUNCTION fortnox_context_snapshot_must_be_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FortnoxReadContextSnapshot"
             WHERE "id" = NEW."id" AND "organizationId" = NEW."organizationId"
               AND "sealedAt" IS NULL) THEN
    RAISE EXCEPTION 'Frozen context snapshot must be sealed before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fortnox_context_snapshot_must_be_sealed
  AFTER INSERT ON "FortnoxReadContextSnapshot"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fortnox_context_snapshot_must_be_sealed();
