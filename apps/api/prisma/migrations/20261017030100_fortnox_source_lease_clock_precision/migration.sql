-- timestamp(3) avrundar rå SQL-klocktid till närmaste millisekund.
-- Jämför lagrade övre tidsgränser med samma precision, annars kan en legitim
-- UPDATE nekas när t.ex. .1238 lagras som .124 innan triggern körs.
-- Faktisk utgång och krav på framtida lease använder fortsatt full DB-klocka.
-- Tidigare migration förblir oförändrad; ingen generell tidsmarginal införs.
BEGIN;

CREATE OR REPLACE FUNCTION fortnox_source_run_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source "FortnoxReadSourceCapture"%ROWTYPE;
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
  IF NEW."status" <> 'RUNNING' OR NEW."claimVersion" <> 0
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
