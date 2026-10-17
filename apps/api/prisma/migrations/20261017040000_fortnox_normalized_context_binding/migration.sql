-- V2 får lagra samma sidformat som v1 först när dess egen råkälla har
-- normaliserats färdigt. Ingen run-fas, ekonomisk effekt eller aktivering ändras.
-- Hashinnehåll och callerens exakta token/version verifieras i tjänsten; SQL
-- binder skrivningen till den aktuella DB-leasen och frysta källidentiteten.
BEGIN;

CREATE FUNCTION fortnox_context_v2_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run "FortnoxReadRun"%ROWTYPE;
  source "FortnoxReadSourceCapture"%ROWTYPE;
  stage "FortnoxReadNormalizationStage"%ROWTYPE;
  connection "FortnoxConnection"%ROWTYPE;
BEGIN
  -- Den gamla skrivgrinden kör först och nekar andra UPDATE än första seal.
  -- Behåll även dess v1/null- och organisationscascade-beteende oförändrat.
  SELECT * INTO run FROM "FortnoxReadRun"
    WHERE "id" = NEW."runId" AND "organizationId" = NEW."organizationId";
  IF NOT FOUND OR run."workVersion" IS DISTINCT FROM 2 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Samma ordning som start/claim/normalisering. Funktionen låser connection
    -- och run; stage tas sist. Färsk tid kontrolleras igen EFTER alla låsen.
    run := fortnox_normalization_lock_run(NEW."organizationId", NEW."runId");
    SELECT * INTO stage FROM "FortnoxReadNormalizationStage"
      WHERE "id" = run."id" AND "organizationId" = run."organizationId" FOR UPDATE;
  ELSE
    -- En oförseglad header kan inte committas (must_be_sealed). Första seal
    -- sker därför i INSERT-transaktionen, som redan håller parentlåsen ovan.
    -- Ta INTE connection/run/stage-lås efter UPDATE:s headerlås: det skulle
    -- invertera låsordningen. Förseglade headers stoppas av gamla grinden.
    SELECT * INTO stage FROM "FortnoxReadNormalizationStage"
      WHERE "id" = run."id" AND "organizationId" = run."organizationId";
  END IF;

  SELECT * INTO source FROM "FortnoxReadSourceCapture"
    WHERE "id" = run."sourceCaptureId" AND "organizationId" = run."organizationId";
  SELECT * INTO connection FROM "FortnoxConnection"
    WHERE "organizationId" = run."organizationId";

  IF run."status" <> 'RUNNING'
     OR run."phase" IS DISTINCT FROM 'SOURCE_CAPTURED'::"FortnoxReadPhase"
     OR run."sourceCaptureId" IS DISTINCT FROM run."id"
     OR run."claimVersion" < 1 OR run."claimToken" IS NULL
     OR run."leaseUntil" IS NULL OR run."leaseUntil" <= timezone('UTC', clock_timestamp())
     OR connection."id" IS NULL OR connection."status" <> 'ACTIVE'
     OR connection."id" IS DISTINCT FROM run."connectionId"
     OR connection."generation" IS DISTINCT FROM run."connectionGeneration"
     OR connection."fortnoxDatabaseNumber" IS DISTINCT FROM run."fortnoxDatabaseNumber"
     OR connection."fortnoxOrgNumber" IS DISTINCT FROM run."fortnoxOrgNumber" THEN
    RAISE EXCEPTION 'Frozen normalized context requires the current source run lease' USING ERRCODE = '23514';
  END IF;

  IF source."id" IS NULL OR source."formatVersion" IS DISTINCT FROM 1
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
     OR stage."runId" IS DISTINCT FROM run."id"
     OR stage."sourceCaptureId" IS DISTINCT FROM source."id"
     OR stage."requestHash" IS DISTINCT FROM source."requestHash"
     OR stage."status" IS DISTINCT FROM 'NORMALIZED' OR stage."normalizedAt" IS NULL
     OR stage."mappingCount" IS DISTINCT FROM source."mappingCount"
     OR stage."exportCount" IS DISTINCT FROM source."exportCount"
     OR stage."mappingsDone" IS DISTINCT FROM source."mappingCount"
     OR stage."exportsDone" IS DISTINCT FROM source."exportCount"
     OR NEW."manifest"->'version' IS DISTINCT FROM '1'::jsonb
     OR NEW."manifest"->'input' IS DISTINCT FROM source."input"
     OR NEW."manifest"->'connection' IS DISTINCT FROM jsonb_build_object(
       'id', source."connectionId", 'generation', source."connectionGeneration",
       'databaseNumber', source."fortnoxDatabaseNumber", 'orgNumber', source."fortnoxOrgNumber")
     OR NEW."manifest"#>'{collections,MAPPINGS,itemCount}' IS DISTINCT FROM to_jsonb(source."mappingCount")
     OR NEW."manifest"#>'{collections,OWN_EXPORTS,itemCount}' IS DISTINCT FROM to_jsonb(source."exportCount")
     OR NEW."manifest"#>'{collections,MAPPINGS,pageCount}' IS DISTINCT FROM to_jsonb((source."mappingCount"::bigint + 99) / 100)
     OR NEW."manifest"#>'{collections,OWN_EXPORTS,pageCount}' IS DISTINCT FROM to_jsonb((source."exportCount"::bigint + 99) / 100) THEN
    RAISE EXCEPTION 'Frozen normalized context does not match its completed source stage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- PostgreSQL kör samma sorts triggers i namnordning. Denna ligger EFTER
-- fortnox_context_snapshot_write_guard: sealens sidcoverage kontrolleras före
-- vår färska DB-tid. Inga DELETE/TRUNCATE-regler eller gamla triggers ersätts.
CREATE TRIGGER fortnox_context_v2_write_guard
  BEFORE INSERT OR UPDATE ON "FortnoxReadContextSnapshot"
  FOR EACH ROW EXECUTE FUNCTION fortnox_context_v2_write_guard();

COMMIT;
