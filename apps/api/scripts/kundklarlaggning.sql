-- Installed ONLY after #871's ledger in a new, isolated exp_* schema.
-- No production models/accounts. Attestations below are simulated trust roots.
CREATE TABLE cf_person(org text,id text,tenant text,role text NOT NULL,
  contact_verified boolean NOT NULL,active boolean NOT NULL,PRIMARY KEY(org,id));
CREATE TABLE cf_attestation(org text,id text,event text NOT NULL,bank jsonb NOT NULL,
  person text NOT NULL,tenant text NOT NULL,leases text[] NOT NULL,source text NOT NULL,
  authority boolean NOT NULL,verified_by text NOT NULL,verified_at timestamptz NOT NULL,
  expires timestamptz NOT NULL,revoked boolean NOT NULL DEFAULT false,
  PRIMARY KEY(org,id),FOREIGN KEY(org,person) REFERENCES cf_person);
CREATE TABLE cf_case(org text,id text,bank jsonb NOT NULL,attestation text,
  conflict boolean NOT NULL,status text NOT NULL DEFAULT 'IMPORTED',recipient text,
  PRIMARY KEY(org,id),FOREIGN KEY(org,attestation) REFERENCES cf_attestation);
CREATE TABLE cf_notice_version(org text,id text,revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(org,id),FOREIGN KEY(org,id) REFERENCES notice);
INSERT INTO cf_notice_version(org,id) SELECT org,id FROM notice;
CREATE FUNCTION cf_bump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.debt IS DISTINCT FROM NEW.debt THEN
 UPDATE cf_notice_version SET revision=revision+1 WHERE org=NEW.org AND id=NEW.id;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER cf_debt_revision AFTER UPDATE ON notice FOR EACH ROW EXECUTE FUNCTION cf_bump();
CREATE TABLE cf_invitation(org text,event text,person text NOT NULL,token_hash text NOT NULL,
  expires timestamptz NOT NULL,debts jsonb NOT NULL,binding jsonb NOT NULL,consumed boolean NOT NULL DEFAULT false,
  request_key text,payload jsonb,result jsonb,PRIMARY KEY(org,event),UNIQUE(token_hash),
  FOREIGN KEY(org,event) REFERENCES cf_case,FOREIGN KEY(org,person) REFERENCES cf_person);
CREATE TABLE cf_outbox(org text,event text,person text NOT NULL,body jsonb NOT NULL,
  PRIMARY KEY(org,event),FOREIGN KEY(org,event) REFERENCES cf_case);
CREATE TABLE cf_audit(seq bigserial PRIMARY KEY,org text NOT NULL,event text NOT NULL,
  actor text NOT NULL,at timestamptz NOT NULL,previous text NOT NULL,status text NOT NULL,
  reason text NOT NULL,evidence jsonb NOT NULL,FOREIGN KEY(org,event) REFERENCES cf_case);
CREATE TRIGGER cf_audit_immutable BEFORE UPDATE OR DELETE ON cf_audit
 FOR EACH ROW EXECUTE FUNCTION immutable_voucher();

CREATE FUNCTION cf_import(o text,k text,b jsonb,e text,conf boolean) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c cf_case%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('cf-import:'||o||':'||k,0));
 SELECT * INTO c FROM cf_case WHERE org=o AND id=k;
 IF FOUND THEN
   IF c.bank<>b OR c.attestation IS DISTINCT FROM e OR c.conflict<>conf THEN RAISE EXCEPTION 'CF_IMPORT_CONFLICT'; END IF;
   RETURN 'DUPLICATE';
 END IF;
 IF b->>'org' IS DISTINCT FROM o THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 INSERT INTO cf_case(org,id,bank,attestation,conflict) VALUES(o,k,b,e,conf);
 RETURN 'IMPORTED';
END $$;

CREATE FUNCTION cf_valid(c cf_case,moment timestamptz) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM cf_attestation e JOIN cf_person p ON p.org=e.org AND p.id=e.person
 WHERE e.org=c.org AND e.id=c.attestation AND e.event=c.id AND e.bank=c.bank
 AND e.bank->>'org'=c.org AND e.source='SIMULATED_INDEPENDENT_ATTESTOR'
 AND e.authority AND NOT e.revoked AND e.expires>moment AND e.verified_at<=moment
 AND p.tenant=e.tenant AND p.role='customer' AND p.contact_verified AND p.active
 AND cardinality(e.leases)>0)
$$;
CREATE FUNCTION cf_transition(c cf_case,who text,moment timestamptz,next text,why text,details jsonb)
 RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO cf_audit(org,event,actor,at,previous,status,reason,evidence)
 VALUES(c.org,c.id,who,moment,c.status,next,why,details);
 UPDATE cf_case SET status=next WHERE org=c.org AND id=c.id;
END $$;

CREATE FUNCTION cf_route(o text,k text,who text,token text,moment timestamptz)
 RETURNS text LANGUAGE plpgsql AS $$
DECLARE c cf_case%ROWTYPE;e cf_attestation%ROWTYPE;debts jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cf_person WHERE org=o AND id=who AND role='staff' AND active) THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 SELECT * INTO STRICT c FROM cf_case WHERE org=o AND id=k FOR UPDATE;
 IF c.status<>'IMPORTED' THEN RETURN c.status; END IF;
 IF NOT cf_valid(c,moment) THEN
   PERFORM cf_transition(c,who,moment,'STAFF_NO_RECIPIENT','NO_INDEPENDENT_AUTHORITY_OR_RECIPIENT','{}');
   RETURN 'STAFF_NO_RECIPIENT';
 END IF;
 SELECT * INTO STRICT e FROM cf_attestation WHERE org=o AND id=c.attestation;
 SELECT coalesce(jsonb_object_agg(n.id,jsonb_build_object('debt',n.debt,'revision',v.revision)),'{}') INTO debts
 FROM notice n JOIN cf_notice_version v ON v.org=n.org AND v.id=n.id
 JOIN scope s ON s.org=n.org AND s.tenant=n.tenant AND s.lease=n.lease
 WHERE n.org=o AND n.tenant=e.tenant AND n.lease=ANY(e.leases) AND n.issued AND n.debt>0 AND s.active;
 IF debts='{}'::jsonb THEN
   PERFORM cf_transition(c,who,moment,'STAFF_NO_NOTICE','NO_ELIGIBLE_OWN_NOTICE','{}');RETURN 'STAFF_NO_NOTICE';
 END IF;
 INSERT INTO cf_invitation(org,event,person,token_hash,expires,debts,binding)
 VALUES(o,k,e.person,token,least(moment+interval '30 minutes',e.expires),debts,to_jsonb(e));
 UPDATE cf_case SET recipient=e.person WHERE org=o AND id=k;
 PERFORM cf_transition(c,who,moment,'DRAFT','INDEPENDENT_TEST_BINDING',to_jsonb(e));
 RETURN 'DRAFT';
END $$;

CREATE FUNCTION cf_capture(o text,k text,who text,moment timestamptz) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c cf_case%ROWTYPE;i cf_invitation%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cf_person WHERE org=o AND id=who AND role='staff' AND active) THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 SELECT * INTO STRICT c FROM cf_case WHERE org=o AND id=k FOR UPDATE;
 IF c.status='WAITING' THEN RETURN 'WAITING'; END IF;
 SELECT * INTO STRICT i FROM cf_invitation WHERE org=o AND event=k;
 IF c.status<>'DRAFT' OR NOT cf_valid(c,moment) OR i.expires<=moment
 OR i.binding IS DISTINCT FROM (SELECT to_jsonb(e) FROM cf_attestation e WHERE e.org=o AND e.id=c.attestation)
 THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 INSERT INTO cf_outbox VALUES(o,k,i.person,jsonb_build_object('subject','TEST: fråga om inbetalning',
 'date',c.bank->>'date','amountOre',c.bank->'amount','text','Ange avsedd avi eller säg att betalningen inte är din. Endast lokal fångst.'));
 PERFORM cf_transition(c,who,moment,'WAITING','LOCAL_CAPTURE_ONLY',jsonb_build_object('recipient',i.person));
 RETURN 'WAITING';
END $$;

CREATE FUNCTION cf_expire(moment timestamptz) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE c cf_case%ROWTYPE;cnt integer:=0;
BEGIN
 FOR c IN SELECT x.* FROM cf_case x JOIN cf_invitation i ON i.org=x.org AND i.event=x.id
 WHERE x.status IN ('DRAFT','WAITING') AND i.expires<=moment FOR UPDATE OF x LOOP
   PERFORM cf_transition(c,'SYSTEM_TEST',moment,'STAFF_TIMEOUT','NO_VALID_RESPONSE_BEFORE_EXPIRY','{}');cnt:=cnt+1;
 END LOOP;RETURN cnt;
END $$;

CREATE FUNCTION cf_reply(o text,k text,who text,token text,request text,p jsonb,
 moment timestamptz,failpoint text DEFAULT '',pause_ms integer DEFAULT 0)
 RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c cf_case%ROWTYPE;i cf_invitation%ROWTYPE;e cf_attestation%ROWTYPE;n notice%ROWTYPE;
 a record;total bigint:=0;extra bigint;rev bigint;chosen_lease text;next text;why text;
 credit jsonb:='null';v_result jsonb;
BEGIN
 -- The case row serializes replies for different request IDs and tokens too.
 SELECT * INTO c FROM cf_case WHERE org=o AND id=k FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 SELECT * INTO i FROM cf_invitation WHERE org=o AND event=k;
 IF NOT FOUND OR i.person IS DISTINCT FROM who OR i.token_hash IS DISTINCT FROM token
 OR i.expires<=moment OR p->>'payment' IS DISTINCT FROM k THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cf_person WHERE org=o AND id=who AND role='customer' AND active) THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 IF i.consumed THEN
   IF i.request_key=request AND i.payload=p THEN RETURN i.result; END IF;
   RAISE EXCEPTION 'CF_DENIED';
 END IF;
 IF c.status<>'WAITING' THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
 SELECT * INTO e FROM cf_attestation WHERE org=o AND id=c.attestation FOR UPDATE;
 IF NOT cf_valid(c,moment) OR i.binding IS DISTINCT FROM to_jsonb(e) OR i.person IS DISTINCT FROM e.person
 THEN next:='STAFF_EVIDENCE_INVALID';why:='ATTESTATION_NO_LONGER_VALID_OR_CHANGED';
 ELSIF p->>'action'='decline' THEN next:='STAFF_DECLINED';why:='CUSTOMER_DENIES_PAYMENT';
 ELSIF p->>'action' IS DISTINCT FROM 'confirm' OR p->>'claim' IS DISTINCT FROM 'mine' THEN
   next:='STAFF_CONTRADICTORY';why:='NO_CONSISTENT_INSTRUCTION';
 ELSIF c.conflict THEN next:='STAFF_CONFLICT';why:='ORIGINAL_IDENTIFIER_CONFLICT_REMAINS';
 ELSIF nullif(btrim(p->>'note'),'') IS NOT NULL THEN
   next:='STAFF_CUSTOMER_NOTE';why:='FREE_TEXT_INSTRUCTION_REQUIRES_REVIEW';
 ELSE
   IF jsonb_typeof(p->'allocations') IS DISTINCT FROM 'object' OR p->'allocations'='{}'::jsonb THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
   -- Lock all allowed scopes in a consistent order before reading current debts.
   PERFORM 1 FROM scope WHERE org=o AND tenant=e.tenant AND lease=ANY(e.leases) ORDER BY lease FOR UPDATE;
   FOR a IN SELECT key,value FROM jsonb_each(p->'allocations') ORDER BY key LOOP
     IF jsonb_typeof(a.value)<>'number' OR a.value::text !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
     SELECT * INTO n FROM notice WHERE org=o AND id=a.key FOR UPDATE;
     IF NOT FOUND OR n.tenant<>e.tenant OR NOT n.lease=ANY(e.leases) OR NOT n.issued
       OR NOT i.debts ? n.id OR NOT EXISTS(SELECT 1 FROM scope WHERE org=o AND tenant=n.tenant AND lease=n.lease AND active)
       THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
     SELECT revision INTO STRICT rev FROM cf_notice_version WHERE org=o AND id=n.id;
     IF n.debt<>(i.debts->n.id->>'debt')::bigint OR rev<>(i.debts->n.id->>'revision')::bigint THEN
       next:='STAFF_DEBT_CHANGED';why:='DEBT_OR_REVISION_CHANGED';
     END IF;
     IF chosen_lease IS NOT NULL AND chosen_lease<>n.lease THEN next:='STAFF_MULTIPLE_LEASES';why:='NO_CROSS_LEASE_ALLOCATION'; END IF;
     chosen_lease:=n.lease;
     IF next IS NULL AND (a.value::text)::bigint>n.debt THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
     total:=total+(a.value::text)::bigint;
   END LOOP;
   IF next IS NULL THEN
     extra:=(c.bank->>'amount')::bigint-total;
     IF extra<0 THEN RAISE EXCEPTION 'CF_DENIED'; END IF;
     IF extra>0 THEN
       IF (SELECT count(*) FROM jsonb_object_keys(p->'allocations'))<>1 OR total<>n.debt
         OR p->'retainCredit' IS DISTINCT FROM 'true'::jsonb THEN
         next:='STAFF_AMOUNT_UNEXPLAINED';why:='REMAINDER_NOT_AUTHORIZED';
       ELSE
         credit:=jsonb_build_object('id','credit:'||k,'org',o,'tenant',n.tenant,'lease',n.lease,
           'bank_event',k,'source_notice',n.id,'created',extra,'target',NULL);
       END IF;
     END IF;
     IF next IS NULL THEN
       PERFORM apply(jsonb_build_object('kind','PAYMENT','id','bank:'||k,'org',o,'event',k,
         'bank',c.bank,'allocations',p->'allocations','credit',credit),failpoint);
       next:=CASE WHEN extra>0 THEN 'STAFF_CREDIT' ELSE 'RESOLVED_CUSTOMER' END;
       why:=CASE WHEN extra>0 THEN 'CREDIT_STILL_OUTSTANDING' ELSE 'CUSTOMER_AND_INDEPENDENT_TEST_EVIDENCE' END;
     END IF;
   END IF;
 END IF;
 PERFORM cf_transition(c,who,moment,next,why,jsonb_build_object('attestation',to_jsonb(e),
   'answer',p,'debtSnapshot',i.debts,'request',request,'authentication','SIMULATED_SESSION'));
 IF failpoint='after_case' THEN RAISE EXCEPTION 'INJECTED_after_case'; END IF;
 v_result:=jsonb_build_object('status',next,'customerParticipation',true,'testOnly',true);
 UPDATE cf_invitation SET consumed=true,request_key=request,payload=p,result=v_result WHERE org=o AND event=k;
 IF failpoint='after_audit_and_link' THEN RAISE EXCEPTION 'INJECTED_after_audit_and_link'; END IF;
 IF pause_ms>0 THEN PERFORM pg_sleep(pause_ms/1000.0); END IF;
 RETURN v_result;
END $$;
