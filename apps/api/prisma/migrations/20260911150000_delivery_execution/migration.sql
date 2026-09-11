BEGIN;

CREATE TABLE "DeliveryPrincipal" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE ("organizationId", "id")
);
CREATE FUNCTION delivery_principal_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."organizationId") IS DISTINCT FROM (OLD."id", OLD."organizationId") THEN
    RAISE EXCEPTION 'DELIVERY_PRINCIPAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_principal_update BEFORE UPDATE ON "DeliveryPrincipal" FOR EACH ROW EXECUTE FUNCTION delivery_principal_update();
CREATE TRIGGER delivery_principal_preserve BEFORE DELETE OR TRUNCATE ON "DeliveryPrincipal" FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
ALTER TABLE "DeliveryEvent" ADD COLUMN "actorKind" TEXT NOT NULL DEFAULT 'HUMAN';
CREATE TABLE "DeliveryDispatch" (
  "decisionId" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL UNIQUE CHECK ("attemptId"::uuid::text = "attemptId"),
  "team" TEXT NOT NULL CHECK (length(btrim("team")) > 0),
  "method" TEXT NOT NULL CHECK ("method" = 'POST'),
  "endpoint" TEXT NOT NULL CHECK ("endpoint" = 'https://api.resend.com/emails'),
  "resources" JSONB NOT NULL,
  "body" TEXT NOT NULL,
  "digest" VARCHAR(64) NOT NULL CHECK ("digest" = encode(sha256(convert_to("body", 'UTF8')), 'hex')),
  FOREIGN KEY ("organizationId", "documentId", "decisionId") REFERENCES "DeliveryDecision"("organizationId", "documentId", "id") ON DELETE RESTRICT,
  UNIQUE ("organizationId", "decisionId"),
  UNIQUE ("organizationId", "documentId", "decisionId")
);
CREATE TABLE "DeliveryObservation" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('FIRST','RETRY','RECEIPT','CLOSED','CONFLICT','PUBLISHED')),
  "grantId" TEXT,
  "evidence" JSONB NOT NULL,
  "principalId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "decisionId") REFERENCES "DeliveryDispatch"("organizationId", "decisionId") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "principalId") REFERENCES "DeliveryPrincipal"("organizationId", "id") ON DELETE RESTRICT,
  UNIQUE ("organizationId", "decisionId", "id"),
  UNIQUE ("decisionId", "sequence"),
  FOREIGN KEY ("organizationId", "decisionId", "grantId") REFERENCES "DeliveryObservation"("organizationId", "decisionId", "id") ON DELETE RESTRICT,
  CHECK (("kind" = 'RECEIPT') = ("grantId" IS NOT NULL))
);
CREATE UNIQUE INDEX delivery_first_once ON "DeliveryObservation"("decisionId") WHERE "kind" = 'FIRST';
-- Explicit tidsport: endast isolerade kontraktsprov ersätter klockan.
CREATE FUNCTION delivery_now() RETURNS TIMESTAMP LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() AT TIME ZONE 'UTC' $$;
CREATE FUNCTION delivery_dispatch_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM delivery_lock(NEW."organizationId");
  IF NOT EXISTS (SELECT FROM "DeliveryDecision" d JOIN "DeliveryEvent" e ON e."decisionId" = d."id" AND e."revision" = 1
    WHERE d."id" = NEW."decisionId" AND d.xmin::text::bigint = txid_current() % 4294967296
    AND e."request"->'resources' = NEW."resources" AND e."request"->>'team' = NEW."team"
    AND NEW."body"::jsonb->'to' = jsonb_build_array(d."snapshot"->'recipient'->>'email')) THEN
    RAISE EXCEPTION 'DELIVERY_DISPATCH_BINDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_dispatch_insert BEFORE INSERT ON "DeliveryDispatch" FOR EACH ROW EXECUTE FUNCTION delivery_dispatch_insert();
CREATE FUNCTION delivery_observation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE started "DeliveryEvent"; latest "DeliveryEvent"; n INTEGER; last_call TIMESTAMP; delay_seconds INTEGER;
BEGIN
  PERFORM delivery_lock(NEW."organizationId");
  IF NOT EXISTS (SELECT FROM "DeliveryPrincipal" WHERE "id" = NEW."principalId" AND "organizationId" = NEW."organizationId" AND ("active" OR (NEW."kind" = 'RECEIPT' AND EXISTS (
      SELECT FROM "DeliveryObservation" g WHERE g."id" = NEW."grantId" AND g."principalId" = NEW."principalId"
      AND g."organizationId" = NEW."organizationId" AND g."decisionId" = NEW."decisionId" AND g."kind" IN ('FIRST','RETRY')))) FOR SHARE) THEN
    RAISE EXCEPTION 'DELIVERY_PRINCIPAL_FORBIDDEN';
  END IF;
  NEW."createdAt" := delivery_now();
  SELECT COALESCE(max("sequence"), 0) + 1 INTO NEW."sequence" FROM "DeliveryObservation" WHERE "decisionId" = NEW."decisionId";
  SELECT * INTO started FROM "DeliveryEvent" WHERE "decisionId" = NEW."decisionId" AND "state" = 'SENDING';
  SELECT * INTO latest FROM "DeliveryEvent" WHERE "decisionId" = NEW."decisionId" ORDER BY "revision" DESC LIMIT 1;
  IF NEW."kind" IN ('FIRST','RETRY') THEN
    IF latest."state" NOT IN ('SENDING','UNKNOWN') OR started."id" IS NULL THEN RAISE EXCEPTION 'DELIVERY_CALL_FORBIDDEN'; END IF;
    SELECT count(*) FILTER (WHERE "kind" = 'RETRY'), max("createdAt") INTO n, last_call
      FROM "DeliveryObservation" WHERE "decisionId" = NEW."decisionId" AND "kind" IN ('FIRST','RETRY');
    IF NEW."createdAt" >= started."createdAt" + interval '23 hours' THEN
      NEW."kind" := 'CLOSED'; NEW."evidence" := '{"reason":"EXPIRED"}';
    ELSIF EXISTS (SELECT FROM "DeliveryObservation" WHERE "decisionId" = NEW."decisionId" AND "kind" = 'CLOSED') OR n >= 3 THEN
      NEW."kind" := 'CLOSED'; NEW."evidence" := '{"reason":"CALL_LIMIT_OR_CLOSED"}';
    ELSIF NEW."kind" = 'FIRST' THEN
      IF NOT EXISTS (SELECT FROM "DeliveryEvent" WHERE "id" = started."id" AND xmin::text::bigint = txid_current() % 4294967296) THEN
        RAISE EXCEPTION 'DELIVERY_FIRST_REQUIRES_START_TRANSACTION';
      END IF;
    ELSE
      delay_seconds := (ARRAY[1,5,30])[n + 1];
      IF NEW."createdAt" < COALESCE(last_call, started."createdAt") + make_interval(secs => delay_seconds) THEN RAISE EXCEPTION 'DELIVERY_RETRY_LATER'; END IF;
    END IF;
  ELSIF NEW."kind" = 'RECEIPT' THEN
    IF NOT EXISTS (SELECT FROM "DeliveryObservation" WHERE "id" = NEW."grantId" AND "decisionId" = NEW."decisionId" AND "kind" IN ('FIRST','RETRY')) THEN
      RAISE EXCEPTION 'DELIVERY_RECEIPT_BINDING';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_observation_insert BEFORE INSERT ON "DeliveryObservation" FOR EACH ROW EXECUTE FUNCTION delivery_observation_insert();
CREATE OR REPLACE FUNCTION delivery_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior "DeliveryEvent"; decision "DeliveryDecision"; valid BOOLEAN; dispatch "DeliveryDispatch"; receipt "DeliveryObservation"; grant_row "DeliveryObservation";
BEGIN
  PERFORM delivery_lock(NEW."organizationId");
  SELECT * INTO decision FROM "DeliveryDecision" WHERE "id" = NEW."decisionId" AND "organizationId" = NEW."organizationId" AND "documentId" = NEW."documentId";
  SELECT * INTO prior FROM "DeliveryEvent" WHERE "decisionId" = NEW."decisionId" ORDER BY "revision" DESC LIMIT 1;
  IF NEW."actorKind" = 'HUMAN' THEN
    IF NEW."state" = 'SENDING' AND EXISTS (SELECT FROM "DeliveryDispatch" WHERE "decisionId" = NEW."decisionId") THEN
      RAISE EXCEPTION 'DELIVERY_PRINCIPAL_REQUIRED';
    END IF;
    SELECT btrim("firstName" || ' ' || "lastName") INTO NEW."actorName" FROM "User"
      WHERE "id" = NEW."actorId" AND "organizationId" = NEW."organizationId" AND "isActive" AND "role" IN ('OWNER','ADMIN','MANAGER') FOR SHARE;
  ELSIF NEW."actorKind" = 'SERVICE' THEN
    SELECT "name" INTO NEW."actorName" FROM "DeliveryPrincipal"
      WHERE "id" = NEW."actorId" AND "organizationId" = NEW."organizationId" AND "active" FOR SHARE;
    SELECT * INTO dispatch FROM "DeliveryDispatch" WHERE "decisionId" = NEW."decisionId" AND "organizationId" = NEW."organizationId" AND "documentId" = NEW."documentId";
    IF dispatch."decisionId" IS NULL OR NEW."state" NOT IN ('SENDING','UNKNOWN','PROVIDER_ACCEPTED') THEN RAISE EXCEPTION 'DELIVERY_PRINCIPAL_FORBIDDEN'; END IF;
    IF NEW."state" = 'SENDING' THEN
      NEW."createdAt" := delivery_now();
      IF NEW."id" <> dispatch."attemptId" THEN RAISE EXCEPTION 'DELIVERY_ATTEMPT_BINDING'; END IF;
    END IF;
    IF NEW."state" = 'PROVIDER_ACCEPTED' THEN
      SELECT * INTO receipt FROM "DeliveryObservation" WHERE "id" = NEW."evidence"->>'observationId' AND "decisionId" = NEW."decisionId" AND "kind" = 'RECEIPT';
      SELECT * INTO grant_row FROM "DeliveryObservation" WHERE "id" = receipt."grantId";
      IF NEW."evidence"->>'provider' IS DISTINCT FROM 'resend' OR receipt."id" IS NULL OR receipt."evidence"->>'status' IS DISTINCT FROM '200' OR COALESCE(length(btrim(receipt."evidence"->>'id')), 0) = 0
        OR receipt."evidence"->>'id' IS DISTINCT FROM NEW."evidence"->>'reference'
        OR (prior."state" = 'UNKNOWN' AND grant_row."kind" IS DISTINCT FROM 'RETRY') THEN RAISE EXCEPTION 'DELIVERY_RECEIPT_BINDING'; END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'DELIVERY_ACTOR_FORBIDDEN';
  END IF;
  IF NEW."actorName" IS NULL THEN RAISE EXCEPTION 'DELIVERY_ACTOR_FORBIDDEN'; END IF;
  IF decision."id" IS NULL OR NEW."revision" <> COALESCE(prior."revision", 0) + 1 THEN RAISE EXCEPTION 'DELIVERY_REVISION_CONFLICT'; END IF;
  IF prior."id" IS NULL THEN
    PERFORM delivery_ready(NEW."organizationId", NEW."documentId", decision."operation");
    valid := NEW."state" = 'DECIDED' AND NEW."attemptId" IS NULL
      AND NEW."request"->>'expectedFingerprint' = decision."fingerprint"
      AND NEW."request"->>'operation' = decision."operation"
      AND (decision."operation" = 'ORIGINAL' OR length(btrim(NEW."request"->>'reason')) > 0);
    IF decision."snapshot" IS DISTINCT FROM delivery_snapshot(NEW."organizationId", NEW."documentId")
      OR EXISTS (SELECT delivery_charge_ids(NEW."documentId") EXCEPT SELECT "chargeId" FROM "DeliveryMember" WHERE "decisionId" = NEW."decisionId")
      OR EXISTS (SELECT "chargeId" FROM "DeliveryMember" WHERE "decisionId" = NEW."decisionId" EXCEPT SELECT delivery_charge_ids(NEW."documentId"))
      OR EXISTS (SELECT FROM "DeliveryMember" m WHERE m."decisionId" = NEW."decisionId" AND NOT EXISTS
        (SELECT FROM jsonb_array_elements(decision."snapshot"->'checks') ch WHERE ch->>'id' = m."checkId" AND ch->>'chargeId' = m."chargeId")) THEN
      RAISE EXCEPTION 'DELIVERY_MEMBER_CONFLICT';
    END IF;
  ELSE
    valid := (prior."state" = 'DECIDED' AND NEW."state" IN ('REVOKED','SENDING'))
      OR (prior."state" = 'SENDING' AND NEW."state" IN ('UNKNOWN','PROVIDER_ACCEPTED','FAILED_NO_ACCEPTANCE'))
      OR (prior."state" = 'UNKNOWN' AND NEW."state" IN ('PROVIDER_ACCEPTED','FAILED_NO_ACCEPTANCE'));
    IF NEW."state" = 'SENDING' THEN
      valid := valid AND NEW."attemptId" = NEW."id";
      IF decision."snapshot" IS DISTINCT FROM delivery_snapshot(NEW."organizationId", NEW."documentId") THEN RAISE EXCEPTION 'DELIVERY_SNAPSHOT_CONFLICT'; END IF;
    ELSE
      valid := valid AND NEW."attemptId" IS NOT DISTINCT FROM prior."attemptId";
    END IF;
    IF NEW."state" IN ('PROVIDER_ACCEPTED','FAILED_NO_ACCEPTANCE') THEN
      valid := valid AND NEW."evidence"->>'kind' = CASE NEW."state" WHEN 'PROVIDER_ACCEPTED' THEN 'ACCEPTANCE' ELSE 'FINAL_REJECTION' END
        AND NEW."evidence"->>'attemptId' = prior."attemptId"
        AND length(btrim(NEW."evidence"->>'provider')) > 0 AND length(btrim(NEW."evidence"->>'reference')) > 0
        AND NEW."evidence"->'receipt'->>'outcome' = CASE NEW."state" WHEN 'PROVIDER_ACCEPTED' THEN 'ACCEPTED' ELSE 'NOT_ACCEPTED_FINAL' END;
      IF NEW."state" = 'FAILED_NO_ACCEPTANCE' THEN
        valid := valid AND length(btrim(NEW."evidence"->'receipt'->>'finalityReference')) > 0;
      END IF;
      IF prior."state" = 'UNKNOWN' AND NEW."actorKind" = 'HUMAN' THEN
        valid := valid AND length(btrim(NEW."evidence"->'investigation'->>'caseId')) > 0
          AND length(btrim(NEW."evidence"->'investigation'->>'source')) > 0;
      END IF;
    END IF;
    valid := valid AND (NEW."request"->>'attemptId') IS NOT DISTINCT FROM CASE WHEN NEW."state" = 'SENDING' THEN NULL ELSE NEW."attemptId" END
      AND NEW."request"->>'to' = NEW."state" AND NEW."request"->>'decisionId' = NEW."decisionId"
      AND NEW."request"->'evidence' = NEW."evidence" AND length(btrim(NEW."evidence"->>'detail')) > 0;
  END IF;
  IF NEW."state" IN ('DECIDED','SENDING') THEN
    valid := valid AND decision."snapshot"->'recipient'->>'organizationId' = NEW."organizationId"
      AND length(btrim(decision."snapshot"->'recipient'->>'email')) > 0
      AND decision."snapshot"->'document'->>'status' NOT IN ('VOID','PAID','CANCELLED')
      AND (decision."snapshot"->'document'->>'leaseId' IS NULL OR
        (decision."snapshot"->'lease'->>'organizationId' = NEW."organizationId"
        AND decision."snapshot"->'lease'->>'tenantId' = decision."snapshot"->'recipient'->>'id'
        AND decision."snapshot"->'property'->>'organizationId' = NEW."organizationId"));
  END IF;
  valid := valid AND COALESCE(NEW."request"->>'actorKind', 'HUMAN') = NEW."actorKind"
    AND NEW."request"->>'actorId' = NEW."actorId" AND NEW."request"->>'documentId' = NEW."documentId"
    AND NEW."request"->>'organizationId' = NEW."organizationId" AND NEW."request"->>'commandKey' = NEW."commandKey";
  IF valid IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'DELIVERY_TRANSITION_FORBIDDEN'; END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DeliveryDispatch','DeliveryObservation'] LOOP
    EXECUTE format('CREATE TRIGGER delivery_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard()', t);
  END LOOP;
END;
$$;
COMMIT;
