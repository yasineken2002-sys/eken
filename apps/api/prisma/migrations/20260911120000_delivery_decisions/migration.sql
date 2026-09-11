BEGIN;

CREATE UNIQUE INDEX "Invoice_delivery_org_key" ON "Invoice"("organizationId", "id");
CREATE UNIQUE INDEX "RentNotice_delivery_org_key" ON "RentNotice"("organizationId", "id");
CREATE UNIQUE INDEX "ConsumptionChargeCheck_delivery_org_key" ON "ConsumptionChargeCheck"("organizationId", "chargeId", "id");
CREATE TABLE "DeliveryDocument" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "noticeId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("invoiceId" IS NOT NULL AND "invoiceId" = "id" AND "noticeId" IS NULL)
    OR ("noticeId" IS NOT NULL AND "noticeId" = "id" AND "invoiceId" IS NULL)),
  FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY ("organizationId", "noticeId") REFERENCES "RentNotice"("organizationId", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX "DeliveryDocument_organizationId_id_key" ON "DeliveryDocument"("organizationId", "id");
CREATE TABLE "DeliveryDecision" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "operation" TEXT NOT NULL CHECK ("operation" IN ('ORIGINAL', 'INVOICE_RESEND')),
  "originalId" TEXT,
  "previousId" TEXT,
  "fingerprint" VARCHAR(64) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "documentId") REFERENCES "DeliveryDocument"("organizationId", "id") ON DELETE RESTRICT,
  UNIQUE ("organizationId", "documentId", "id"),
  UNIQUE ("organizationId", "documentId", "sequence"),
  FOREIGN KEY ("organizationId", "documentId", "originalId") REFERENCES "DeliveryDecision"("organizationId", "documentId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "documentId", "previousId") REFERENCES "DeliveryDecision"("organizationId", "documentId", "id") ON DELETE RESTRICT
);
CREATE TABLE "DeliveryMember" (
  "organizationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "chargeId" TEXT NOT NULL,
  "checkId" TEXT NOT NULL,
  PRIMARY KEY ("organizationId", "documentId", "decisionId", "chargeId"),
  FOREIGN KEY ("organizationId", "documentId", "decisionId") REFERENCES "DeliveryDecision"("organizationId", "documentId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "chargeId", "checkId") REFERENCES "ConsumptionChargeCheck"("organizationId", "chargeId", "id") ON DELETE RESTRICT
);
CREATE TABLE "DeliveryEvent" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "commandKey" TEXT NOT NULL CHECK (length(btrim("commandKey")) > 0),
  "request" JSONB NOT NULL,
  "state" TEXT NOT NULL,
  "attemptId" TEXT,
  "evidence" JSONB NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "documentId", "decisionId") REFERENCES "DeliveryDecision"("organizationId", "documentId", "id") ON DELETE RESTRICT,
  UNIQUE ("organizationId", "commandKey"),
  UNIQUE ("decisionId", "revision")
);

CREATE FUNCTION delivery_lock(org TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'DELIVERY_REQUIRES_READ_COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('consumption-gate:' || org, 0));
END;
$$;
CREATE FUNCTION delivery_register() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Frånvarofrågan får sin snapshot EFTER väntan på äldre dokumentinsättningar.
  LOCK TABLE "Invoice", "RentNotice" IN SHARE ROW EXCLUSIVE MODE;
  PERFORM delivery_lock(NEW."organizationId");
  IF EXISTS (SELECT FROM "Invoice" WHERE "id" = NEW."id")
    OR EXISTS (SELECT FROM "RentNotice" WHERE "id" = NEW."id") THEN
    RAISE EXCEPTION 'HISTORY_UNVERIFIED';
  END IF;
  IF NOT EXISTS (SELECT FROM "User" WHERE "id" = NEW."createdById"
    AND "organizationId" = NEW."organizationId" AND "isActive" AND "role" IN ('OWNER', 'ADMIN', 'MANAGER')) THEN
    RAISE EXCEPTION 'DELIVERY_ACTOR_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_register BEFORE INSERT ON "DeliveryDocument" FOR EACH ROW EXECUTE FUNCTION delivery_register();

CREATE FUNCTION delivery_charge_ids(doc TEXT) RETURNS SETOF TEXT LANGUAGE sql STABLE AS $$
  SELECT c."id" FROM "ConsumptionCharge" c JOIN "DeliveryDocument" d ON c."invoiceId" = d."invoiceId" WHERE d."id" = doc
  UNION SELECT l."consumptionChargeId" FROM "RentNoticeLine" l JOIN "DeliveryDocument" d ON l."rentNoticeId" = d."noticeId"
    WHERE d."id" = doc AND l."consumptionChargeId" IS NOT NULL;
$$;
-- Numeriska SQL-värden blir exakta strängar innan JavaScript kan avrunda dem.
CREATE FUNCTION delivery_json(v JSONB) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  CASE jsonb_typeof(v)
    WHEN 'number' THEN RETURN to_jsonb(v::text);
    WHEN 'object' THEN RETURN COALESCE((SELECT jsonb_object_agg(key, delivery_json(value)) FROM jsonb_each(v)), '{}'::jsonb);
    WHEN 'array' THEN RETURN COALESCE((SELECT jsonb_agg(delivery_json(value) ORDER BY ord) FROM jsonb_array_elements(v) WITH ORDINALITY a(value, ord)), '[]'::jsonb);
    ELSE RETURN v;
  END CASE;
END;
$$;
CREATE FUNCTION delivery_snapshot(org TEXT, doc TEXT) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT delivery_json(jsonb_build_object('contract', 'delivery-domain/v1', 'artifactEvidence', 'UNVERIFIED',
    'document', COALESCE(to_jsonb(i), to_jsonb(n)),
    'lines', CASE WHEN d."invoiceId" IS NOT NULL
      THEN (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l."id"), '[]') FROM "InvoiceLine" l WHERE l."invoiceId" = doc)
      ELSE (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l."id"), '[]') FROM "RentNoticeLine" l WHERE l."rentNoticeId" = doc) END,
    'credits', CASE WHEN d."invoiceId" IS NOT NULL
      THEN (SELECT COALESCE(jsonb_agg(to_jsonb(c) || jsonb_build_object('lines',
        (SELECT jsonb_agg(to_jsonb(l) ORDER BY l."id") FROM "InvoiceLine" l WHERE l."invoiceId" = c."id")) ORDER BY c."id"), '[]') FROM "Invoice" c WHERE c."creditedInvoiceId" = doc)
      ELSE (SELECT COALESCE(jsonb_agg(to_jsonb(c) || jsonb_build_object('lines',
        (SELECT jsonb_agg(to_jsonb(l) ORDER BY l."id") FROM "RentNoticeCreditLine" l WHERE l."rentNoticeCreditId" = c."id")) ORDER BY c."id"), '[]') FROM "RentNoticeCredit" c WHERE c."rentNoticeId" = doc) END,
    'recipient', (SELECT jsonb_object_agg(key, value) FROM jsonb_each(COALESCE(to_jsonb(t), to_jsonb(c)))
      WHERE key = ANY(ARRAY['id','organizationId','type','firstName','lastName','companyName','email','phone','street','city','postalCode'])),
    'sender', (SELECT jsonb_object_agg(key, value) FROM jsonb_each(to_jsonb(o))
      WHERE key = ANY(ARRAY['id','name','orgNumber','email','street','city','postalCode','bankgiro','hasFSkatt','fSkattApprovedDate','vatNumber','companyForm','invoiceColor','invoiceTemplate','brandSecondaryColor','brandFont','logoStorageKey'])),
    'lease', to_jsonb(le), 'unit', to_jsonb(u), 'property', to_jsonb(p),
    'charges', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x."id") FROM "ConsumptionCharge" x WHERE x."id" IN (SELECT delivery_charge_ids(doc))),
    'meters', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m."id") FROM "Meter" m JOIN "MeterReading" r ON r."meterId" = m."id"
      WHERE r."id" IN (SELECT x."meterReadingId" FROM "ConsumptionCharge" x WHERE x."id" IN (SELECT delivery_charge_ids(doc)))),
    'readings', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r."id") FROM "MeterReading" r WHERE r."organizationId" = org AND r."meterId" IN
      (SELECT m."meterId" FROM "MeterReading" m JOIN "ConsumptionCharge" x ON x."meterReadingId" = m."id" WHERE x."id" IN (SELECT delivery_charge_ids(doc)))),
    'reviews', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v."id") FROM "MeterReadingReview" v JOIN "MeterReading" r ON r."id" = v."readingId"
      WHERE v."organizationId" = org AND r."meterId" IN
      (SELECT m."meterId" FROM "MeterReading" m JOIN "ConsumptionCharge" x ON x."meterReadingId" = m."id" WHERE x."id" IN (SELECT delivery_charge_ids(doc)))),
    'checks', (SELECT COALESCE(jsonb_agg(to_jsonb(ch) ORDER BY ch."chargeId"), '[]') FROM "ConsumptionChargeCheck" ch
      WHERE ch."organizationId" = org AND ch."chargeId" IN (SELECT delivery_charge_ids(doc))
      AND ch."revision" = (SELECT max(x."revision") FROM "ConsumptionChargeCheck" x WHERE x."chargeId" = ch."chargeId" AND x."organizationId" = org))))
  FROM "DeliveryDocument" d
  LEFT JOIN "Invoice" i ON i."id" = d."invoiceId" AND i."organizationId" = org
  LEFT JOIN "RentNotice" n ON n."id" = d."noticeId" AND n."organizationId" = org
  LEFT JOIN "Tenant" t ON t."id" = COALESCE(i."tenantId", n."tenantId") AND t."organizationId" = org
  LEFT JOIN "Customer" c ON c."id" = i."customerId" AND c."organizationId" = org
  JOIN "Organization" o ON o."id" = org
  LEFT JOIN "Lease" le ON le."id" = COALESCE(i."leaseId", n."leaseId") AND le."organizationId" = org
  LEFT JOIN "Unit" u ON u."id" = le."unitId"
  LEFT JOIN "Property" p ON p."id" = u."propertyId" AND p."organizationId" = org
  WHERE d."id" = doc AND d."organizationId" = org;
$$;
CREATE FUNCTION delivery_fingerprint(v JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(v::text, 'UTF8')), 'hex');
$$;
CREATE FUNCTION delivery_ready(org TEXT, doc TEXT, op TEXT)
RETURNS TABLE(original TEXT, previous TEXT, sequence INTEGER) LANGUAGE plpgsql AS $$
DECLARE states TEXT[];
BEGIN
  PERFORM delivery_lock(org);
  IF NOT EXISTS (SELECT FROM "DeliveryDocument" WHERE "id" = doc AND "organizationId" = org) THEN RAISE EXCEPTION 'HISTORY_UNVERIFIED'; END IF;
  SELECT array_agg(e."state") INTO states FROM "DeliveryDecision" d
    CROSS JOIN LATERAL (SELECT "state" FROM "DeliveryEvent" WHERE "decisionId" = d."id" ORDER BY "revision" DESC LIMIT 1) e
    WHERE d."documentId" = doc AND d."organizationId" = org;
  IF 'UNKNOWN' = ANY(states) THEN RAISE EXCEPTION 'OUTCOME_UNKNOWN_REQUIRES_HUMAN'; END IF;
  IF states && ARRAY['DECIDED','SENDING'] THEN RAISE EXCEPTION 'DECISION_IN_PROGRESS'; END IF;
  SELECT d."id" INTO original FROM "DeliveryDecision" d JOIN "DeliveryEvent" e ON e."decisionId" = d."id"
    WHERE d."documentId" = doc AND d."organizationId" = org AND d."operation" = 'ORIGINAL' AND e."state" = 'PROVIDER_ACCEPTED';
  IF op = 'ORIGINAL' AND original IS NOT NULL THEN RAISE EXCEPTION 'ORIGINAL_ALREADY_ACCEPTED'; END IF;
  IF op = 'INVOICE_RESEND' AND (original IS NULL OR NOT EXISTS (SELECT FROM "DeliveryDocument" WHERE "id" = doc AND "invoiceId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'INVOICE_RESEND_REQUIRES_ACCEPTED_INVOICE';
  END IF;
  SELECT d."id", d."sequence" INTO previous, sequence FROM "DeliveryDecision" d WHERE d."documentId" = doc AND d."organizationId" = org ORDER BY d."sequence" DESC LIMIT 1;
  sequence := COALESCE(sequence, 0) + 1;
  RETURN NEXT;
END;
$$;
CREATE FUNCTION delivery_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected RECORD;
BEGIN
  SELECT * INTO expected FROM delivery_ready(NEW."organizationId", NEW."documentId", NEW."operation");
  IF (NEW."originalId", NEW."previousId", NEW."sequence") IS DISTINCT FROM (expected.original, expected.previous, expected.sequence)
    OR NEW."snapshot" IS DISTINCT FROM delivery_snapshot(NEW."organizationId", NEW."documentId")
    OR NEW."fingerprint" <> delivery_fingerprint(NEW."snapshot") THEN RAISE EXCEPTION 'DELIVERY_SNAPSHOT_CONFLICT'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_decision_insert BEFORE INSERT ON "DeliveryDecision" FOR EACH ROW EXECUTE FUNCTION delivery_decision_insert();
CREATE FUNCTION delivery_member_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM delivery_lock(NEW."organizationId");
  IF NOT EXISTS (SELECT FROM "DeliveryDecision" WHERE "id" = NEW."decisionId" AND xmin::text::bigint = txid_current() % 4294967296)
    OR EXISTS (SELECT FROM "DeliveryEvent" WHERE "decisionId" = NEW."decisionId") THEN RAISE EXCEPTION 'DELIVERY_MEMBERS_SEALED'; END IF;
  IF NOT EXISTS (SELECT FROM "ConsumptionCharge" c JOIN "DeliveryDecision" d ON d."id" = NEW."decisionId"
    WHERE c."id" = NEW."chargeId" AND c."organizationId" = NEW."organizationId"
    AND c."tenantId" = d."snapshot"->'recipient'->>'id'
    AND c."leaseId" = d."snapshot"->'document'->>'leaseId') THEN RAISE EXCEPTION 'DELIVERY_MEMBER_RELATION'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_member_insert BEFORE INSERT ON "DeliveryMember" FOR EACH ROW EXECUTE FUNCTION delivery_member_insert();
CREATE FUNCTION delivery_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior "DeliveryEvent"; decision "DeliveryDecision"; valid BOOLEAN;
BEGIN
  PERFORM delivery_lock(NEW."organizationId");
  SELECT * INTO decision FROM "DeliveryDecision" WHERE "id" = NEW."decisionId" AND "organizationId" = NEW."organizationId" AND "documentId" = NEW."documentId";
  SELECT * INTO prior FROM "DeliveryEvent" WHERE "decisionId" = NEW."decisionId" ORDER BY "revision" DESC LIMIT 1;
  SELECT btrim("firstName" || ' ' || "lastName") INTO NEW."actorName" FROM "User"
    WHERE "id" = NEW."actorId" AND "organizationId" = NEW."organizationId" AND "isActive" AND "role" IN ('OWNER','ADMIN','MANAGER') FOR SHARE;
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
      IF prior."state" = 'UNKNOWN' THEN
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
  valid := valid AND NEW."request"->>'actorId' = NEW."actorId" AND NEW."request"->>'documentId' = NEW."documentId"
    AND NEW."request"->>'organizationId' = NEW."organizationId" AND NEW."request"->>'commandKey' = NEW."commandKey";
  IF valid IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'DELIVERY_TRANSITION_FORBIDDEN'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_event_insert BEFORE INSERT ON "DeliveryEvent" FOR EACH ROW EXECUTE FUNCTION delivery_event_insert();
CREATE FUNCTION delivery_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM "DeliveryEvent" WHERE "decisionId" = NEW."id" AND "revision" = 1)
    OR NEW."snapshot" IS DISTINCT FROM delivery_snapshot(NEW."organizationId", NEW."documentId")
    OR EXISTS (SELECT delivery_charge_ids(NEW."documentId") EXCEPT SELECT "chargeId" FROM "DeliveryMember" WHERE "decisionId" = NEW."id")
    OR EXISTS (SELECT "chargeId" FROM "DeliveryMember" WHERE "decisionId" = NEW."id" EXCEPT SELECT delivery_charge_ids(NEW."documentId")) THEN
    RAISE EXCEPTION 'DELIVERY_UNSEALED';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER delivery_sealed AFTER INSERT ON "DeliveryDecision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION delivery_sealed();
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DeliveryDocument','DeliveryDecision','DeliveryMember','DeliveryEvent'] LOOP
    EXECUTE format('CREATE TRIGGER delivery_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard()', t);
  END LOOP;
END;
$$;

COMMIT;
