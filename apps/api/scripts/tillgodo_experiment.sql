-- EXPERIMENT ONLY. Installed only in an empty experiment schema in isolated PG.
-- TEST_* are fictitious test roles, never BAS accounts or production tables.
CREATE TABLE scope (org text, tenant text, lease text, active boolean NOT NULL,
  consent boolean NOT NULL, refund boolean NOT NULL, PRIMARY KEY(org,tenant,lease));
CREATE TABLE notice (org text, id text, tenant text NOT NULL, lease text NOT NULL,
  period integer NOT NULL, issue_date date NOT NULL, gross bigint NOT NULL CHECK(gross>0),
  debt bigint NOT NULL CHECK(debt>=0 AND debt<=gross), issued boolean NOT NULL DEFAULT false,
  display_due bigint, amendment_required boolean NOT NULL DEFAULT false,
  PRIMARY KEY(org,id), UNIQUE(org,id,tenant,lease),
  FOREIGN KEY(org,tenant,lease) REFERENCES scope);
CREATE TABLE bank (org text, id text, payload jsonb NOT NULL, amount bigint NOT NULL CHECK(amount>0),
  status text NOT NULL, PRIMARY KEY(org,id));
CREATE TABLE credit (org text, id text, tenant text NOT NULL, lease text NOT NULL,
  bank_event text NOT NULL, source_notice text NOT NULL, target text, created_date date NOT NULL,
  total bigint NOT NULL CHECK(total>0), remaining bigint NOT NULL CHECK(remaining>=0 AND remaining<=total),
  held boolean NOT NULL DEFAULT false, reversed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(org,id), UNIQUE(org,bank_event),
  FOREIGN KEY(org,bank_event) REFERENCES bank,
  FOREIGN KEY(org,source_notice,tenant,lease) REFERENCES notice(org,id,tenant,lease),
  FOREIGN KEY(org,target,tenant,lease) REFERENCES notice(org,id,tenant,lease));
CREATE TABLE allocation (org text, bank_event text, notice text, amount bigint NOT NULL CHECK(amount>0),
  reversed boolean NOT NULL DEFAULT false, PRIMARY KEY(org,bank_event,notice),
  FOREIGN KEY(org,bank_event) REFERENCES bank, FOREIGN KEY(org,notice) REFERENCES notice);
CREATE TABLE credit_use (org text,id text,credit text NOT NULL,notice text NOT NULL,amount bigint NOT NULL CHECK(amount>0),
  reversed boolean NOT NULL DEFAULT false, PRIMARY KEY(org,id), UNIQUE(org,credit,notice),
  FOREIGN KEY(org,credit) REFERENCES credit, FOREIGN KEY(org,notice) REFERENCES notice);
CREATE TABLE voucher (org text,id text,lines jsonb NOT NULL,reversal_of text,
  PRIMARY KEY(org,id), UNIQUE(org,reversal_of), FOREIGN KEY(org,reversal_of) REFERENCES voucher(org,id));
CREATE TABLE operation (org text,id text,payload jsonb NOT NULL,PRIMARY KEY(org,id));

CREATE FUNCTION immutable_voucher() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_VOUCHER'; END $$;
CREATE TRIGGER voucher_immutable BEFORE UPDATE OR DELETE ON voucher FOR EACH ROW EXECUTE FUNCTION immutable_voucher();

CREATE FUNCTION book(o text,k text,ls jsonb,rev text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l jsonb; d bigint; c bigint; balance bigint:=0;
BEGIN
 IF jsonb_array_length(ls)<2 THEN RAISE EXCEPTION 'EMPTY_VOUCHER'; END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(ls) LOOP
   IF l->>0 NOT IN ('TEST_BANK','TEST_RECEIVABLE','TEST_CREDIT','TEST_RENT','TEST_UNALLOCATED') THEN RAISE EXCEPTION 'NOT_TEST_ACCOUNT'; END IF;
   IF (l->>1)!~'^[0-9]+$' OR (l->>2)!~'^[0-9]+$' THEN RAISE EXCEPTION 'INTEGER_ORE_REQUIRED'; END IF;
   d:=(l->>1)::bigint; c:=(l->>2)::bigint;
   IF NOT ((d>0 AND c=0) OR (c>0 AND d=0)) THEN RAISE EXCEPTION 'INVALID_VOUCHER_LINE'; END IF;
   balance:=balance+d-c;
 END LOOP;
 IF balance<>0 THEN RAISE EXCEPTION 'UNBALANCED_VOUCHER'; END IF;
 INSERT INTO voucher VALUES(o,k,ls,rev);
END $$;
CREATE FUNCTION reverse_book(o text,k text,original text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ls jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_array(x->>0,(x->>2)::bigint,(x->>1)::bigint)) INTO ls
 FROM voucher v, jsonb_array_elements(v.lines) x WHERE v.org=o AND v.id=original;
 IF ls IS NULL THEN RAISE EXCEPTION 'MISSING_ORIGINAL_VOUCHER'; END IF;
 PERFORM book(o,k,ls,original);
END $$;

CREATE FUNCTION apply(p jsonb,failpoint text DEFAULT '',pause_ms integer DEFAULT 0) RETURNS text LANGUAGE plpgsql AS $$
DECLARE o text:=p->>'org'; k text:=p->>'id'; kind text:=p->>'kind'; prior jsonb;
 n notice%ROWTYPE; src notice%ROWTYPE; c credit%ROWTYPE; u credit_use%ROWTYPE; s scope%ROWTYPE;
 a record; item jsonb; amount bigint; total bigint:=0; extra bigint; ls jsonb; bankrow bank%ROWTYPE;
BEGIN
 -- Locks the absent operation key too; retries serialize before looking up prior effect.
 PERFORM pg_advisory_xact_lock(hashtextextended(o||':'||k,0));
 SELECT payload INTO prior FROM operation WHERE org=o AND id=k;
 IF FOUND THEN
   IF prior<>p THEN RAISE EXCEPTION 'OPERATION_PAYLOAD_CONFLICT'; END IF;
   RETURN 'DUPLICATE';
 END IF;
 IF kind='ISSUE' THEN
   SELECT * INTO STRICT n FROM notice WHERE org=o AND id=p->>'notice';
   SELECT * INTO STRICT s FROM scope WHERE org=o AND tenant=n.tenant AND lease=n.lease FOR UPDATE;
   SELECT * INTO STRICT n FROM notice WHERE org=o AND id=n.id FOR UPDATE;
   IF n.issued THEN RAISE EXCEPTION 'ALREADY_ISSUED'; END IF;
   IF (p->>'date')::date<>n.issue_date THEN RAISE EXCEPTION 'ISSUE_DATE_MISMATCH'; END IF;
   PERFORM book(o,k,jsonb_build_array(jsonb_build_array('TEST_RECEIVABLE',n.gross,0),jsonb_build_array('TEST_RENT',0,n.gross)));
   FOR item IN SELECT value FROM jsonb_array_elements(p->'uses') LOOP
     IF NOT s.active OR NOT s.consent OR s.refund THEN RAISE EXCEPTION 'NO_USE_PERMISSION'; END IF;
     SELECT * INTO STRICT c FROM credit WHERE org=o AND id=item->>'credit' FOR UPDATE;
     SELECT * INTO STRICT src FROM notice WHERE org=o AND id=c.source_notice;
     amount:=(item->>'amount')::bigint;
     IF c.tenant<>n.tenant OR c.lease<>n.lease OR c.target IS DISTINCT FROM n.id OR c.held OR c.reversed
        OR src.period+1<>n.period OR c.created_date>=n.issue_date THEN RAISE EXCEPTION 'WRONG_CREDIT_SCOPE_OR_TARGET'; END IF;
     IF amount<=0 OR amount>c.remaining OR amount>n.debt-total THEN RAISE EXCEPTION 'CREDIT_NOT_AVAILABLE'; END IF;
     UPDATE notice SET debt=debt-amount WHERE org=o AND id=n.id;
     IF failpoint='after_debt' THEN RAISE EXCEPTION 'INJECTED_after_debt'; END IF;
     UPDATE credit SET remaining=remaining-amount WHERE org=o AND id=c.id;
     IF failpoint='after_credit' THEN RAISE EXCEPTION 'INJECTED_after_credit'; END IF;
     INSERT INTO credit_use VALUES(o,k||':'||c.id,c.id,n.id,amount,false);
     PERFORM book(o,k||':'||c.id,jsonb_build_array(jsonb_build_array('TEST_CREDIT',amount,0),jsonb_build_array('TEST_RECEIVABLE',0,amount)));
     IF failpoint='after_use_voucher' THEN RAISE EXCEPTION 'INJECTED_after_use_voucher'; END IF;
     total:=total+amount;
   END LOOP;
   UPDATE notice SET issued=true,display_due=debt WHERE org=o AND id=n.id;
 ELSIF kind='PAYMENT' THEN
   amount:=(p->'bank'->>'amount')::bigint;
   IF p->'bank'->>'org'<>o THEN RAISE EXCEPTION 'BANK_ORG_MISMATCH'; END IF;
   INSERT INTO bank VALUES(o,p->>'event',p->'bank',amount,'REVIEW');
   -- Consistent scope lock before notice locks. The experiment permits allocations within one scope only.
   FOR a IN SELECT key,value FROM jsonb_each_text(p->'allocations') ORDER BY key LOOP
     SELECT * INTO STRICT n FROM notice WHERE org=o AND id=a.key;
     IF total=0 THEN
       SELECT * INTO STRICT s FROM scope WHERE org=o AND tenant=n.tenant AND lease=n.lease FOR UPDATE;
     ELSIF n.tenant<>s.tenant OR n.lease<>s.lease THEN RAISE EXCEPTION 'ALLOCATION_SCOPE_MISMATCH'; END IF;
     SELECT * INTO STRICT n FROM notice WHERE org=o AND id=a.key FOR UPDATE;
     IF NOT n.issued OR (a.value)::bigint<=0 OR (a.value)::bigint>n.debt THEN RAISE EXCEPTION 'ALLOCATION_EXCEEDS_DEBT'; END IF;
     UPDATE notice SET debt=debt-(a.value)::bigint WHERE org=o AND id=n.id;
     INSERT INTO allocation VALUES(o,p->>'event',n.id,(a.value)::bigint,false);
     total:=total+(a.value)::bigint;
   END LOOP;
   IF total>amount THEN RAISE EXCEPTION 'ALLOCATION_EXCEEDS_BANK'; END IF;
   IF failpoint='after_debt' THEN RAISE EXCEPTION 'INJECTED_after_debt'; END IF;
   ls:=jsonb_build_array(jsonb_build_array('TEST_BANK',amount,0));
   IF total>0 THEN ls:=ls||jsonb_build_array(jsonb_build_array('TEST_RECEIVABLE',0,total)); END IF;
   extra:=amount-total;
   IF p->'credit' IS NOT NULL AND p->'credit'<>'null'::jsonb THEN
     item:=p->'credit';
     IF (SELECT count(*) FROM jsonb_object_keys(p->'allocations'))<>1 OR extra<=0 OR (item->>'created')::bigint<>extra
       OR item->>'org'<>o OR item->>'tenant'<>n.tenant OR item->>'lease'<>n.lease
       OR item->>'bank_event'<>p->>'event' OR item->>'source_notice'<>n.id THEN RAISE EXCEPTION 'INVALID_CREDIT'; END IF;
     IF item->>'target' IS NOT NULL THEN
       SELECT * INTO STRICT src FROM notice WHERE org=o AND id=item->>'target';
       IF src.issued OR src.period<>n.period+1 OR (p->'bank'->>'date')::date>=src.issue_date THEN RAISE EXCEPTION 'TARGET_ALREADY_ISSUED_OR_WRONG_PERIOD'; END IF;
     END IF;
     INSERT INTO credit(org,id,tenant,lease,bank_event,source_notice,target,created_date,total,remaining)
       VALUES(o,item->>'id',n.tenant,n.lease,p->>'event',n.id,item->>'target',(p->'bank'->>'date')::date,extra,extra);
     ls:=ls||jsonb_build_array(jsonb_build_array('TEST_CREDIT',0,extra));
   ELSIF extra>0 THEN
     IF total>0 THEN RAISE EXCEPTION 'MISSING_CREDIT'; END IF;
     ls:=ls||jsonb_build_array(jsonb_build_array('TEST_UNALLOCATED',0,extra));
   END IF;
   IF failpoint='after_credit' THEN RAISE EXCEPTION 'INJECTED_after_credit'; END IF;
   PERFORM book(o,k,ls);
   IF failpoint='after_bank_voucher' THEN RAISE EXCEPTION 'INJECTED_after_bank_voucher'; END IF;
   UPDATE bank SET status=CASE WHEN total>0 THEN 'ALLOCATED' ELSE 'REVIEW' END WHERE org=o AND id=p->>'event';
 ELSIF kind='PLAN_NEXT' THEN
   IF p->>'authorization' IS DISTINCT FROM 'ASSUMED_STANDING_CONSENT' THEN RAISE EXCEPTION 'NO_USE_PERMISSION'; END IF;
   SELECT * INTO STRICT c FROM credit WHERE org=o AND id=p->>'credit';
   SELECT * INTO STRICT s FROM scope WHERE org=o AND tenant=c.tenant AND lease=c.lease FOR UPDATE;
   SELECT * INTO STRICT c FROM credit WHERE org=o AND id=c.id FOR UPDATE;
   SELECT * INTO STRICT n FROM notice WHERE org=o AND id=c.source_notice;
   SELECT * INTO STRICT src FROM notice WHERE org=o AND id=p->>'target';
   IF NOT s.active OR NOT s.consent OR s.refund OR c.held OR c.reversed OR c.remaining<=0 THEN RAISE EXCEPTION 'NO_USE_PERMISSION'; END IF;
   IF src.issued OR src.period<>n.period+1 OR src.tenant<>c.tenant OR src.lease<>c.lease
      OR c.created_date>=src.issue_date THEN RAISE EXCEPTION 'WRONG_CREDIT_SCOPE_OR_TARGET'; END IF;
   UPDATE credit SET target=src.id WHERE org=o AND id=c.id;
 ELSIF kind='REVERSE_USE' THEN
   SELECT * INTO STRICT u FROM credit_use WHERE org=o AND id=p->>'use';
   SELECT * INTO STRICT c FROM credit WHERE org=o AND id=u.credit;
   PERFORM 1 FROM scope WHERE org=o AND tenant=c.tenant AND lease=c.lease FOR UPDATE;
   SELECT * INTO STRICT u FROM credit_use WHERE org=o AND id=u.id FOR UPDATE;
   IF u.reversed THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
   IF EXISTS(SELECT 1 FROM allocation WHERE org=o AND notice=u.notice AND NOT reversed) THEN RAISE EXCEPTION 'TARGET_HAS_BANK_PAYMENT'; END IF;
   UPDATE notice SET debt=debt+u.amount,amendment_required=true WHERE org=o AND id=u.notice;
   IF failpoint='after_debt' THEN RAISE EXCEPTION 'INJECTED_after_debt'; END IF;
   UPDATE credit SET remaining=remaining+u.amount,held=true WHERE org=o AND id=u.credit;
   UPDATE credit_use SET reversed=true WHERE org=o AND id=u.id;
   PERFORM reverse_book(o,k,u.id);
 ELSIF kind='REVERSE_BANK' THEN
   SELECT * INTO STRICT bankrow FROM bank WHERE org=o AND id=p->>'event' FOR UPDATE;
   IF bankrow.status='REVERSED' THEN RAISE EXCEPTION 'ALREADY_REVERSED'; END IF;
   FOR c IN SELECT * FROM credit WHERE org=o AND bank_event=bankrow.id FOR UPDATE LOOP
     IF c.remaining<>c.total THEN RAISE EXCEPTION 'CREDIT_ALREADY_USED'; END IF;
     UPDATE credit SET remaining=0,reversed=true,held=true WHERE org=o AND id=c.id;
   END LOOP;
   FOR a IN SELECT * FROM allocation WHERE org=o AND bank_event=bankrow.id AND NOT reversed LOOP
     UPDATE notice SET debt=debt+a.amount,amendment_required=true WHERE org=o AND id=a.notice;
   END LOOP;
   IF failpoint='after_debt' THEN RAISE EXCEPTION 'INJECTED_after_debt'; END IF;
   UPDATE allocation SET reversed=true WHERE org=o AND bank_event=bankrow.id;
   UPDATE bank SET status='REVERSED' WHERE org=o AND id=bankrow.id;
   PERFORM reverse_book(o,k,'bank:'||bankrow.id);
 ELSE RAISE EXCEPTION 'UNKNOWN_OPERATION'; END IF;
 IF pause_ms>0 THEN PERFORM pg_sleep(pause_ms/1000.0); END IF;
 INSERT INTO operation VALUES(o,k,p);
 RETURN 'APPLIED';
END $$;
