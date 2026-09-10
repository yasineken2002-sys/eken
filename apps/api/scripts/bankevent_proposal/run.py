"""Runs ONLY proposed SQL storage in a new isolated database, never app methods."""
import argparse
import gzip
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from tillgodo_pg import Postgres, ROOT, literal

BASE='fa15d0d9f3eae17d04afc4d46165cb45205373fa'
DATA=ROOT/'docs/eval/bankhandelse-forslag'
sha=lambda b:hashlib.sha256(b).hexdigest()
j=lambda value:literal(json.dumps(value,ensure_ascii=False))+'::jsonb'
TABLES=['BankIdentityScope','BankIdentityBinding','BankIdentityBridge','BankEvent','BankObservation','BankTransaction','TestDispatch']


def setup(pg,schema,case):
    pg.sql('CREATE SCHEMA '+schema+';')
    pg.sql('''CREATE TYPE "ActorKind" AS ENUM ('HUMAN','SYSTEM','AGENT');
      CREATE TABLE "Organization"(id text PRIMARY KEY);
      INSERT INTO "Organization" VALUES ('org-A'),('org-B');
      CREATE TABLE "BankTransaction"(id text PRIMARY KEY,"organizationId" text NOT NULL REFERENCES "Organization"(id),
       date timestamp NOT NULL, description text NOT NULL, amount numeric(12,2) NOT NULL,
       "rawOcr" text, reference text, balance numeric(12,2), "actorKind" "ActorKind", "externalId" text, status text NOT NULL DEFAULT 'UNMATCHED',
       UNIQUE("organizationId","externalId"));
      -- Deliberately NO uniqueness/balance constraint on simulated downstream
      -- markers: it must be possible for a broken claim to show extra calls/money.
      CREATE TABLE "TestDispatch"(seq bigserial PRIMARY KEY,"eventId" text,"bankId" text,
        org text,"amountOre" bigint,"queueMarker" integer);
    ''',schema)
    pg.sql((HERE/'storage.sql').read_text(),schema)
    # Explicit synthetic administrative proof. Not supplied by a customer or by
    # the production provider; real availability is UNKNOWN.
    for org in ('org-A','org-B'):
        for account in ('A','B'):
            sid=org+'-scope-'+account
            cutoff="'2026-09-09','SYNTHETIC_VERIFIED_TRANSITION'" if case['cutover'] else 'NULL,NULL'
            pg.sql('INSERT INTO "BankIdentityScope" VALUES('+','.join(map(literal,[sid,org,'BANK-'+account,'SYNTHETIC_CANONICAL_EVENT_V1','SYNTHETIC_ADMIN_PROOF']))+','+cutoff+');',schema)
            for provider,consent,kind in [('P','C','api'),('P','C','file'),('Q','CQ','api')]:
                pg.sql('INSERT INTO "BankIdentityBinding" VALUES('+','.join(map(literal,[org,provider,consent,account,kind,sid,'SYNTHETIC_CONTINUITY_PROOF']))+');',schema)
    if case['legacy']:
        day='2026-09-09' if case['cutover'] else '2026-09-10'
        pg.sql('INSERT INTO "BankTransaction"(id,"organizationId",date,description,amount,"rawOcr","externalId",status) VALUES '
            +"('legacy-bank','org-A',"+literal(day)+",'SYNTHETIC LEGACY',100,'00123459','old-id','MATCHED');",schema)
    if case['bridge']:
        pg.sql("INSERT INTO \"BankIdentityBridge\" VALUES ('org-A','org-A-scope-A','E1','legacy-bank','SYNTHETIC_REVIEWED_BANK_LINK');",schema)


def query(step):
    return 'SELECT bank_event_observe('+','.join([literal(step['org']),j(step['origin']),literal(step['externalId']),j(step['body'])])+');'


def snapshot(pg,schema):
    parts=[]
    for table in TABLES:
        parts.extend([literal(table),f'(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\') FROM "{table}" t)'])
    return json.loads(pg.sql('SELECT jsonb_build_object('+','.join(parts)+');',schema))


def race_sql(pg,schema,statements):
    commands=[];children=[]
    try:
        for index,statement in enumerate(statements):
            prefix='SET search_path TO '+schema+',pg_catalog; BEGIN;\n'
            sql=prefix+statement+('\nSELECT pg_sleep(2);' if index==0 else '')+'\nCOMMIT;'
            p=subprocess.Popen(pg.command('bankevent-race-'+str(index)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            children.append(p);p.stdin.write(sql);p.stdin.close();p.stdin=None
            if index==0:
                for _ in range(30):
                    sleeping=pg.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='bankevent-race-0' AND wait_event='PgSleep';")
                    if sleeping=='1':break
                    time.sleep(.02)
                else:raise AssertionError('First transaction never reached overlap window')
        for _ in range(20):
            blocked=pg.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='bankevent-race-1' AND wait_event_type='Lock';")
            if blocked=='1':break
            time.sleep(.02)
        assert blocked=='1','Required real PostgreSQL lock contention not observed'
        for p in children:
            stdout,stderr=p.communicate(timeout=15)
            assert p.returncode==0,stderr
            lines=[line for line in stdout.splitlines() if line.strip()]
            assert len(lines)==1,lines
            commands.append(json.loads(lines[0]))
        return commands,{'separateSessions':2,'secondSessionLockWaitObserved':True}
    finally:
        for child in children:
            if child.poll() is None:child.terminate();child.wait(timeout=5)


def run_case(pg,case,index):
    schema='exp_event_'+str(index);setup(pg,schema,case)
    before=snapshot(pg,schema);trace=[];overlap=None
    def dispatch(step,outcome,mode='normal'):
        if not outcome.get('eventId') or outcome['outcome']=='HELD':return
        token='SYNTHETIC_ATTEMPT_'+str(len(trace));org='org-B' if mode=='wrong_org' else step['org']
        claim=json.loads(pg.sql('SELECT bank_event_claim('+','.join(map(literal,[org,outcome['eventId'],token]))+');',schema))
        trace.append({'phase':'claim','org':org,'eventId':outcome['eventId'],'token':token,'result':claim})
        if not claim['claimed']:return
        if mode=='crash_started':return
        # Synthetic observer ONLY. No matcher, allocation, book entry or queue.
        pg.sql('INSERT INTO "TestDispatch"("eventId","bankId",org,"amountOre","queueMarker") '
            +'SELECT id,"bankTransactionId","organizationId",(body->>\'amountOre\')::bigint,1 FROM "BankEvent" WHERE id='+literal(outcome['eventId'])+';',schema)
        if mode=='crash_effect':return
        if mode=='wrong_token':
            wrong=pg.sql('SELECT bank_event_finish('+','.join(map(literal,[org,outcome['eventId'],'WRONG']))+',true);',schema)
            assert wrong=='f';trace.append({'phase':'wrong-finish','result':wrong})
        done=pg.sql('SELECT bank_event_finish('+','.join(map(literal,[org,outcome['eventId'],token]))+',true);',schema)
        assert done=='t';trace.append({'phase':'finish','eventId':outcome['eventId'],'result':done})
    outcomes=[]
    if case['mode']=='concurrent':
        outcomes,overlap=race_sql(pg,schema,[query(step) for step in case['steps']])
        for step,outcome in zip(case['steps'],outcomes):
            trace.append({'phase':'observe','input':step,'result':outcome});dispatch(step,outcome)
    else:
        for i,step in enumerate(case['steps']):
            if i==0 and case['mode']=='rollback_save':
                pg.sql('BEGIN;'+query(step)+"DO $$ BEGIN RAISE EXCEPTION 'INJECTED_SAVE_ROLLBACK'; END $$; COMMIT;",schema,expect_error='INJECTED_SAVE_ROLLBACK')
                assert snapshot(pg,schema)==before
                trace.append({'phase':'rollback','input':step});continue
            outcome=json.loads(pg.sql(query(step),schema));outcomes.append(outcome)
            trace.append({'phase':'observe','input':step,'result':outcome})
            if case['mode']=='defer' or (i==0 and case['mode']=='crash_pending'):continue
            dispatch(step,outcome,case['mode'] if i==0 else 'normal')
        if case['mode']=='defer':
            for step,outcome in zip(case['steps'],outcomes):dispatch(step,outcome)
    gates={org:pg.sql('SELECT bank_identity_open('+literal(org)+');',schema)=='t' for org in ('org-A','org-B')}
    after=snapshot(pg,schema)
    for row in after['BankTransaction']:
        allowed=pg.sql('SELECT bank_event_allows_automatic('+literal(row['organizationId'])+','+literal(row['id'])+');',schema)=='t'
        trace.append({'phase':'automatic-gate','bankId':row['id'],'allowed':allowed})
    return {'id':case['id'],'before':before,'trace':trace,'snapshot':after,'openIdentity':gates,'overlap':overlap}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);a=parser.parse_args()
    out=a.out.resolve();assert out.is_relative_to(Path('/tmp')) or out.is_relative_to(DATA)
    assert not out.exists() or (out.is_dir() and not any(out.iterdir()));out.mkdir(parents=True,exist_ok=True)
    for name in ['indata.json','facit.json']:
        file='docs/eval/bankhandelse-forslag/'+name
        assert (ROOT/file).read_bytes()==subprocess.check_output(['git','show','9f9b692b:'+file],cwd=ROOT)
    corrected='docs/eval/bankhandelse-forslag/indata-v2.json'
    assert (ROOT/corrected).read_bytes()==subprocess.check_output(['git','show','215a606d:'+corrected],cwd=ROOT)
    historic={}
    paths=subprocess.check_output(['git','ls-tree','-r','--name-only',BASE,'--','docs/eval','apps/api/src/reconciliation','apps/api/src/psd2','apps/api/prisma/schema.prisma'],cwd=ROOT,text=True).splitlines()
    for file in paths:
        old=subprocess.check_output(['git','show',BASE+':'+file],cwd=ROOT)
        assert (ROOT/file).read_bytes()==old,file;historic[file]=sha(old)
    inputs=json.loads((DATA/'indata-v2.json').read_text()) # facit bytes checked, never consumed as decisions
    pg=Postgres();results=[]
    try:
        pg.start()
        for index,case in enumerate(inputs['cases']):
            results.append(run_case(pg,case,index));print('Captured SQL component:',case['id'],flush=True)
        raw=json.dumps({'kind':'PROPOSED_SQL_COMPONENT_NOT_PRODUCTION_IMPORT','cases':results},ensure_ascii=False,separators=(',',':')).encode()
        (out/'observationer.json.gz').write_bytes(gzip.compress(raw,mtime=0))
        files=[p for p in HERE.iterdir() if p.is_file()]+[DATA/'indata.json',DATA/'indata-v2.json',DATA/'facit.json',DATA/'granskning-komplettering-facit.json',DATA/'granskning-komplettering-facit-v2.json',HERE.parent/'tillgodo_pg.py']
        manifest={'base':BASE,'headAtRun':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'database':pg.identity,'sourceHashes':{p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in files},
            'preservedHashes':historic,'observationSha256':sha(raw),'gzipSha256':sha((out/'observationer.json.gz').read_bytes())}
        (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
        print('Saved',len(results),'SQL component cases; no production methods or downstream economic systems run.')
    finally:pg.close()


if __name__=='__main__':main()
