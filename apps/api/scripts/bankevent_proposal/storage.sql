-- PROPOSED storage, NOT installed in the application. Executed only in an
-- empty exp_* test schema with a synthetic BankTransaction boundary table.
-- Registry rows represent separately supplied synthetic administrative proof;
-- these constraints cannot verify a bank's actual contractual guarantees.
CREATE UNIQUE INDEX "BankTransaction_id_org_identity_key" ON "BankTransaction"(id,"organizationId");
CREATE TABLE "BankIdentityScope" (
 id text PRIMARY KEY, "organizationId" text NOT NULL REFERENCES "Organization"(id) ON DELETE RESTRICT,
 "bankAccountAnchor" text NOT NULL, "idContract" text NOT NULL,
 "proofRef" text NOT NULL CHECK(length("proofRef")>0),
 "legacyThrough" date, "transitionProof" text,
 UNIQUE(id,"organizationId"), UNIQUE("organizationId","bankAccountAnchor"),
 CHECK (("legacyThrough" IS NULL)=("transitionProof" IS NULL))
);
CREATE TABLE "BankIdentityBinding" (
 "organizationId" text NOT NULL, provider text NOT NULL, consent text NOT NULL,
 account text NOT NULL, kind text NOT NULL CHECK(kind IN ('api','file')),
 "scopeId" text NOT NULL, "proofRef" text NOT NULL CHECK(length("proofRef")>0),
 PRIMARY KEY("organizationId",provider,consent,account,kind),
 FOREIGN KEY("scopeId","organizationId") REFERENCES "BankIdentityScope"(id,"organizationId") ON DELETE RESTRICT
);
CREATE TABLE "BankIdentityBridge" (
 "organizationId" text NOT NULL, "scopeId" text NOT NULL, "externalId" text NOT NULL,
 "bankTransactionId" text NOT NULL UNIQUE, "proofRef" text NOT NULL CHECK(length("proofRef")>0),
 PRIMARY KEY("scopeId","externalId"),
 FOREIGN KEY("scopeId","organizationId") REFERENCES "BankIdentityScope"(id,"organizationId") ON DELETE RESTRICT,
 FOREIGN KEY("bankTransactionId","organizationId") REFERENCES "BankTransaction"(id,"organizationId") ON DELETE RESTRICT
);
CREATE TABLE "BankImportGuard" ("organizationId" text PRIMARY KEY REFERENCES "Organization"(id) ON DELETE RESTRICT);
CREATE TABLE "BankEvent" (
 id text PRIMARY KEY, "organizationId" text NOT NULL, "scopeId" text NOT NULL,
 "externalId" text NOT NULL CHECK(length("externalId")>0), body jsonb NOT NULL,
 "bankTransactionId" text UNIQUE,
 state text NOT NULL CHECK(state IN ('PENDING','STARTED','DONE','UNCERTAIN','LEGACY')),
 conflict boolean NOT NULL DEFAULT false,
 "attemptToken" text, "startedAt" timestamptz, "finishedAt" timestamptz,
 UNIQUE("scopeId","externalId"), UNIQUE(id,"organizationId"),
 FOREIGN KEY("scopeId","organizationId") REFERENCES "BankIdentityScope"(id,"organizationId") ON DELETE RESTRICT,
 FOREIGN KEY("bankTransactionId","organizationId") REFERENCES "BankTransaction"(id,"organizationId") ON DELETE RESTRICT
);
CREATE TABLE "BankObservation" (
 id text PRIMARY KEY, "organizationId" text NOT NULL REFERENCES "Organization"(id) ON DELETE RESTRICT, origin jsonb NOT NULL,
 "externalId" text, body jsonb NOT NULL, "eventId" text,
 outcome text NOT NULL, reason text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY("eventId","organizationId") REFERENCES "BankEvent"(id,"organizationId") ON DELETE RESTRICT
);
CREATE INDEX "BankObservation_org_outcome" ON "BankObservation"("organizationId",outcome);
CREATE FUNCTION bank_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BANK_OBSERVATION_APPEND_ONLY'; END $$;
CREATE TRIGGER bank_observation_append_only BEFORE UPDATE OR DELETE ON "BankObservation"
 FOR EACH ROW EXECUTE FUNCTION bank_observation_immutable();

-- All event decisions/claims use the SAME org guard. This deliberately coarse
-- lock protects both uniqueness and the absence-of-legacy-row predicate.
-- Rollout still requires stopping old writers: they do not take this new lock.
CREATE FUNCTION bank_event_guard(p_org text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO "BankImportGuard" VALUES(p_org) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM "BankImportGuard" WHERE "organizationId"=p_org FOR UPDATE;
END $$;

CREATE FUNCTION bank_event_observe(p_org text,p_origin jsonb,p_external text,p_body jsonb,p_actor text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
 s "BankIdentityScope"; e "BankEvent"; old "BankTransaction";
 bridge_id text; obs text:=gen_random_uuid()::text; eid text; bid text;
 decision text:='HELD'; why text:='UNVERIFIED_SOURCE'; money bigint; day date;
 valid boolean:=false; canonical jsonb;
BEGIN
 IF p_actor IS NOT NULL AND p_actor NOT IN ('HUMAN','SYSTEM','AGENT') THEN RAISE EXCEPTION 'INVALID_ACTOR'; END IF;
 PERFORM bank_event_guard(p_org);
 -- Keep ALL original fields in the observation. Canonical content only uses
 -- all matching-bearing payment fields, including description (F-/AVI refs).
 canonical:=jsonb_build_object('amountOre',p_body->'amountOre','day',p_body->'day',
   'booked',p_body->'booked','currency',p_body->'currency',
   'rawOcr',p_body->'rawOcr','reference',p_body->'reference','description',p_body->'description');
 BEGIN
   money:=(p_body->>'amountOre')::bigint; day:=(p_body->>'day')::date;
   valid:=money>0 AND money<=999999999999 AND jsonb_typeof(p_body->'amountOre')='number'
     AND (p_body->>'amountOre')::numeric=money AND p_body->>'booked'='true'
     AND p_body->>'currency'='SEK' AND day IS NOT NULL;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
   valid:=false;
 END;
 SELECT sc.* INTO s FROM "BankIdentityBinding" b JOIN "BankIdentityScope" sc
   ON sc.id=b."scopeId" AND sc."organizationId"=b."organizationId"
   WHERE b."organizationId"=p_org AND b.provider=p_origin->>'provider'
   AND b.consent=p_origin->>'consent' AND b.account=p_origin->>'account'
   AND b.kind=p_origin->>'kind';
 IF s.id IS NOT NULL AND coalesce(p_external,'')<>'' THEN
   SELECT * INTO e FROM "BankEvent" WHERE "scopeId"=s.id AND "externalId"=p_external FOR UPDATE;
   IF e.id IS NOT NULL THEN
     eid:=e.id;bid:=e."bankTransactionId";
     IF e.body<>canonical THEN
       UPDATE "BankEvent" SET conflict=true WHERE id=e.id;
       why:='CONTENT_CONFLICT';
     ELSIF e.conflict THEN why:='PRIOR_CONTENT_CONFLICT';
     ELSE decision:='REPLAY';why:=e.state;
     END IF;
   ELSE
     SELECT "bankTransactionId" INTO bridge_id FROM "BankIdentityBridge"
       WHERE "organizationId"=p_org AND "scopeId"=s.id AND "externalId"=p_external;
     IF bridge_id IS NOT NULL THEN
       SELECT * INTO old FROM "BankTransaction" WHERE id=bridge_id AND "organizationId"=p_org;
       -- The bridge verifies the bank-event link even when content conflicts.
       -- Persist that link as blocked; never rewrite the historical payment.
       eid:=gen_random_uuid()::text;bid:=bridge_id;
       INSERT INTO "BankEvent"(id,"organizationId","scopeId","externalId",body,"bankTransactionId",state)
         VALUES(eid,p_org,s.id,p_external,canonical,bid,'LEGACY');
       IF NOT coalesce(valid,false) OR old.amount*100<>money OR old.date::date<>day
         OR old."rawOcr" IS DISTINCT FROM p_body->>'rawOcr'
         OR old.reference IS DISTINCT FROM p_body->>'reference'
         OR old.description IS DISTINCT FROM p_body->>'description' THEN
         UPDATE "BankEvent" SET conflict=true WHERE id=eid;
         why:='LEGACY_CONTENT_CONFLICT';
       ELSE
         decision:='REPLAY';why:='VERIFIED_LEGACY_BRIDGE';
       END IF;
     ELSIF NOT coalesce(valid,false) THEN decision:='REJECTED';why:='NOT_ELIGIBLE_PAYMENT';
     ELSIF EXISTS(SELECT 1 FROM "BankTransaction" b WHERE b."organizationId"=p_org
           AND NOT EXISTS(SELECT 1 FROM "BankEvent" x WHERE x."bankTransactionId"=b.id))
           AND NOT (s."legacyThrough" IS NOT NULL AND day>s."legacyThrough" AND length(s."transitionProof")>0
             AND NOT EXISTS(SELECT 1 FROM "BankTransaction" later WHERE later."organizationId"=p_org
               AND later.date::date>s."legacyThrough"
               AND NOT EXISTS(SELECT 1 FROM "BankEvent" le WHERE le."bankTransactionId"=later.id))) THEN
       why:='LEGACY_CONTINUITY_UNPROVEN';
     ELSE
       eid:=gen_random_uuid()::text;bid:=gen_random_uuid()::text;
       INSERT INTO "BankTransaction"(id,"organizationId",date,description,amount,"rawOcr",reference,balance,"actorKind")
         VALUES(bid,p_org,day,coalesce(p_body->>'description',''),money::numeric/100,
           p_body->>'rawOcr',p_body->>'reference',(p_body->>'balance')::numeric,p_actor::"ActorKind");
       INSERT INTO "BankEvent"(id,"organizationId","scopeId","externalId",body,"bankTransactionId",state)
         VALUES(eid,p_org,s.id,p_external,canonical,bid,'PENDING');
       decision:='READY';why:='VERIFIED_NEW_EVENT';
     END IF;
   END IF;
 ELSIF NOT coalesce(valid,false) THEN decision:='REJECTED';why:='NOT_ELIGIBLE_PAYMENT';
 END IF;
 INSERT INTO "BankObservation"(id,"organizationId",origin,"externalId",body,"eventId",outcome,reason)
   VALUES(obs,p_org,p_origin,p_external,p_body,eid,decision,why);
 RETURN jsonb_build_object('observationId',obs,'eventId',eid,'bankTransactionId',bid,'outcome',decision,'reason',why);
END $$;

CREATE FUNCTION bank_event_claim(p_org text,p_event text,p_token text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e "BankEvent";
BEGIN
 PERFORM bank_event_guard(p_org);
 SELECT * INTO e FROM "BankEvent" WHERE id=p_event AND "organizationId"=p_org FOR UPDATE;
 IF e.id IS NULL THEN RETURN jsonb_build_object('claimed',false,'reason','NOT_FOUND'); END IF;
 IF e.state<>'PENDING' OR e.conflict THEN RETURN jsonb_build_object('claimed',false,'reason',CASE WHEN e.conflict THEN 'CONFLICT' ELSE e.state END); END IF;
 IF coalesce(p_token,'')='' THEN RAISE EXCEPTION 'ATTEMPT_TOKEN_REQUIRED'; END IF;
 UPDATE "BankEvent" SET state='STARTED',"attemptToken"=p_token,"startedAt"=clock_timestamp() WHERE id=e.id;
 RETURN jsonb_build_object('claimed',true,'bankTransactionId',e."bankTransactionId",'token',p_token);
END $$;

CREATE FUNCTION bank_event_finish(p_org text,p_event text,p_token text,p_success boolean) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 PERFORM bank_event_guard(p_org);
 UPDATE "BankEvent" SET state=CASE WHEN p_success THEN 'DONE' ELSE 'UNCERTAIN' END,"finishedAt"=clock_timestamp()
   WHERE id=p_event AND "organizationId"=p_org AND state='STARTED' AND "attemptToken"=p_token;
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END $$;

-- Read gates for automatic rematching, shadow work and collection/period checks.
CREATE FUNCTION bank_identity_open(p_org text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM "BankObservation" WHERE "organizationId"=p_org AND outcome='HELD')
 OR EXISTS(SELECT 1 FROM "BankEvent" WHERE "organizationId"=p_org AND (state IN ('PENDING','STARTED','UNCERTAIN') OR conflict))
$$;
CREATE FUNCTION bank_event_allows_automatic(p_org text,p_bank text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM "BankTransaction" WHERE "organizationId"=p_org AND id=p_bank)
 AND NOT EXISTS(SELECT 1 FROM "BankEvent" WHERE "organizationId"=p_org AND "bankTransactionId"=p_bank
   AND (state IN ('PENDING','STARTED','UNCERTAIN') OR conflict))
$$;

CREATE FUNCTION bank_event_authorized_attempt(p_org text,p_bank text,p_token text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT bank_event_allows_automatic(p_org,p_bank) OR EXISTS(
  SELECT 1 FROM "BankEvent" WHERE "organizationId"=p_org AND "bankTransactionId"=p_bank
  AND state='STARTED' AND NOT conflict AND "attemptToken"=p_token AND p_token IS NOT NULL)
$$;
