-- Inert, fryst råkälla. Ingen befintlig Run, v1-kontext, endpoint eller kö ändras.
-- Historiska anslutnings-/källidentiteter har avsiktligt inga live-FK.
-- SQL skyddar scope, ordinaler och försegling; kontokällan normaliseras först
-- senare av befintlig ekonomisk logik, aldrig av dessa lagringsspärrar.
CREATE TABLE "FortnoxReadSourceCapture" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "connectionId" TEXT NOT NULL,
  "connectionGeneration" INTEGER NOT NULL,
  "fortnoxDatabaseNumber" INTEGER NOT NULL,
  "fortnoxOrgNumber" TEXT,
  "input" JSONB NOT NULL,
  "requestHash" TEXT NOT NULL,
  "mappingCount" INTEGER NOT NULL DEFAULT 0,
  "exportCount" INTEGER NOT NULL DEFAULT 0,
  "sealedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FortnoxReadSourceCapture_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_source_capture_shape" CHECK (
    "formatVersion" = 1 AND jsonb_typeof("input") = 'object'
    AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND "mappingCount" >= 0 AND "exportCount" >= 0
  )
);
CREATE UNIQUE INDEX "FortnoxReadSourceCapture_id_organizationId_key"
  ON "FortnoxReadSourceCapture"("id", "organizationId");
CREATE INDEX "FortnoxReadSourceCapture_organizationId_idx"
  ON "FortnoxReadSourceCapture"("organizationId");
ALTER TABLE "FortnoxReadSourceCapture" ADD CONSTRAINT "FortnoxReadSourceCapture_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FortnoxReadSourceMapping" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "ordinal" BIGINT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "dimensionType" "FortnoxDimensionType" NOT NULL,
  "code" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "propertyName" TEXT NOT NULL,
  CONSTRAINT "FortnoxReadSourceMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_source_mapping_ordinal" CHECK ("ordinal" >= 1)
);
CREATE UNIQUE INDEX "FortnoxReadSourceMapping_captureId_ordinal_key"
  ON "FortnoxReadSourceMapping"("captureId", "ordinal");
CREATE UNIQUE INDEX "FortnoxReadSourceMapping_captureId_sourceId_key"
  ON "FortnoxReadSourceMapping"("captureId", "sourceId");
CREATE INDEX "FortnoxReadSourceMapping_organizationId_idx"
  ON "FortnoxReadSourceMapping"("organizationId");
ALTER TABLE "FortnoxReadSourceMapping" ADD CONSTRAINT "FortnoxReadSourceMapping_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadSourceMapping" ADD CONSTRAINT "FortnoxReadSourceMapping_captureId_organizationId_fkey"
  FOREIGN KEY ("captureId", "organizationId") REFERENCES "FortnoxReadSourceCapture"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FortnoxReadSourceExport" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "ordinal" BIGINT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "externalYear" INTEGER NOT NULL,
  "externalSeries" TEXT NOT NULL,
  "externalNumber" INTEGER NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "accountSource" JSONB NOT NULL,
  CONSTRAINT "FortnoxReadSourceExport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_source_export_ordinal" CHECK ("ordinal" >= 1)
);
CREATE UNIQUE INDEX "FortnoxReadSourceExport_captureId_ordinal_key"
  ON "FortnoxReadSourceExport"("captureId", "ordinal");
CREATE UNIQUE INDEX "FortnoxReadSourceExport_captureId_sourceId_key"
  ON "FortnoxReadSourceExport"("captureId", "sourceId");
CREATE INDEX "FortnoxReadSourceExport_organizationId_idx"
  ON "FortnoxReadSourceExport"("organizationId");
ALTER TABLE "FortnoxReadSourceExport" ADD CONSTRAINT "FortnoxReadSourceExport_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadSourceExport" ADD CONSTRAINT "FortnoxReadSourceExport_captureId_organizationId_fkey"
  FOREIGN KEY ("captureId", "organizationId") REFERENCES "FortnoxReadSourceCapture"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION fortnox_source_capture_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mappings BIGINT;
  first_mapping BIGINT;
  last_mapping BIGINT;
  exports BIGINT;
  first_export BIGINT;
  last_export BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sealedAt" IS NOT NULL OR NEW."mappingCount" <> 0 OR NEW."exportCount" <> 0 THEN
      RAISE EXCEPTION 'Source capture must start unsealed and empty' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Riktig FK-cascade ser den redan borttagna organisationen. Ingen generell
    -- trigger-depth-genväg till direkt radering av bevarat källunderlag.
    IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Source capture cannot be deleted directly' USING ERRCODE = '23514';
  END IF;

  -- Enda UPDATE: första seal och de slutliga mängderna. Identitet, urval,
  -- anslutningsbindning, version och skapandetid är redan oföränderliga.
  IF OLD."sealedAt" IS NOT NULL OR NEW."sealedAt" IS NULL
     OR (to_jsonb(NEW) - ARRAY['sealedAt', 'mappingCount', 'exportCount'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['sealedAt', 'mappingCount', 'exportCount']) THEN
    RAISE EXCEPTION 'Source capture can only be sealed once without rebinding' USING ERRCODE = '23514';
  END IF;

  SELECT count(*), min("ordinal"), max("ordinal") INTO mappings, first_mapping, last_mapping
    FROM "FortnoxReadSourceMapping"
    WHERE "captureId" = NEW."id" AND "organizationId" = NEW."organizationId";
  SELECT count(*), min("ordinal"), max("ordinal") INTO exports, first_export, last_export
    FROM "FortnoxReadSourceExport"
    WHERE "captureId" = NEW."id" AND "organizationId" = NEW."organizationId";
  -- Positiva, unika ordinaler + COUNT/MIN/MAX bevisar exakt den sammanhängande
  -- sekvensen 1..N. Noll betyder att samlingen verkligen saknar rader.
  IF mappings <> NEW."mappingCount" OR exports <> NEW."exportCount"
     OR (mappings > 0 AND (first_mapping <> 1 OR last_mapping <> mappings))
     OR (exports > 0 AND (first_export <> 1 OR last_export <> exports)) THEN
    RAISE EXCEPTION 'Source capture counts or ordinals are incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fortnox_source_child_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_sealed_at TIMESTAMPTZ(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = OLD."organizationId")
       OR NOT EXISTS (SELECT 1 FROM "FortnoxReadSourceCapture"
                      WHERE "id" = OLD."captureId" AND "organizationId" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Captured source cannot be deleted directly' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Captured source is immutable' USING ERRCODE = '23514';
  END IF;

  -- INSERT och seal delar samma header-radlås. Ingen senare INSERT får lägga
  -- till källor bakom en redan förseglad mängd.
  SELECT "sealedAt" INTO parent_sealed_at FROM "FortnoxReadSourceCapture"
    WHERE "id" = NEW."captureId" AND "organizationId" = NEW."organizationId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Captured source has no scoped parent' USING ERRCODE = '23503';
  END IF;
  IF parent_sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Source capture is already sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fortnox_source_must_be_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Läs den aktuella raden, inte INSERT-eventets äldre NEW.sealedAt. Ett
  -- fångat JS-fel får aldrig lämna oförseglade källor vid lyckad commit.
  IF EXISTS (SELECT 1 FROM "FortnoxReadSourceCapture"
             WHERE "id" = NEW."id" AND "organizationId" = NEW."organizationId"
               AND "sealedAt" IS NULL) THEN
    RAISE EXCEPTION 'Source capture must be sealed before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION fortnox_source_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Captured source cannot be truncated' USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION fortnox_source_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Captured source is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER fortnox_source_capture_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadSourceCapture"
  FOR EACH ROW EXECUTE FUNCTION fortnox_source_capture_write_guard();
CREATE TRIGGER fortnox_source_mapping_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadSourceMapping"
  FOR EACH ROW EXECUTE FUNCTION fortnox_source_child_write_guard();
CREATE TRIGGER fortnox_source_export_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "FortnoxReadSourceExport"
  FOR EACH ROW EXECUTE FUNCTION fortnox_source_child_write_guard();

-- Caller sätter just denna constraint IMMEDIATE efter seal för ett uttryckligt
-- klientfel även på Prisma-versioner som annars döljer deferred commit-fel.
CREATE CONSTRAINT TRIGGER fortnox_source_commit_seal
  AFTER INSERT OR UPDATE ON "FortnoxReadSourceCapture"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fortnox_source_must_be_sealed();

CREATE TRIGGER append_only_fortnox_source_mapping BEFORE UPDATE ON "FortnoxReadSourceMapping"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_source_reject_update();
CREATE TRIGGER append_only_fortnox_source_export BEFORE UPDATE ON "FortnoxReadSourceExport"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_source_reject_update();

CREATE TRIGGER fortnox_source_capture_no_truncate BEFORE TRUNCATE ON "FortnoxReadSourceCapture"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_source_reject_truncate();
CREATE TRIGGER fortnox_source_mapping_no_truncate BEFORE TRUNCATE ON "FortnoxReadSourceMapping"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_source_reject_truncate();
CREATE TRIGGER fortnox_source_export_no_truncate BEFORE TRUNCATE ON "FortnoxReadSourceExport"
  FOR EACH STATEMENT EXECUTE FUNCTION fortnox_source_reject_truncate();
