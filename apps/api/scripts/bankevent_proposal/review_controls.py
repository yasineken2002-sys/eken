"""Frozen follow-up requirements from two independent reviewers. SQL ONLY."""
import argparse
import copy
import hashlib
import json
import subprocess
from pathlib import Path
from run import setup, query, Postgres, DATA, HERE, ROOT, snapshot, literal
from controls import controls


def review_controls(pg):
    expected=json.loads((DATA/'granskning-komplettering-facit.json').read_text())['checks'];done=[]
    seed=json.loads((DATA/'indata-v2.json').read_text())['cases'][0]
    def fresh(n,**kw):
        schema='exp_review_'+str(n);setup(pg,schema,dict(seed,**kw));return schema
    def observe(s,step):return json.loads(pg.sql(query(step),s))
    def record(key):assert key in expected;done.append(key)
    s=fresh(1);a=copy.deepcopy(seed['steps'][0]);a['body']['description']='F-2026-001'
    first=observe(s,a);a['body']['description']='F-2026-002';second=observe(s,a)
    after=snapshot(pg,s);assert second['outcome']=='HELD' and second['reason']=='CONTENT_CONFLICT'
    assert len(after['BankTransaction'])==1 and len(after['BankObservation'])==2
    assert after['BankTransaction'][0]['amount']==100 and after['BankTransaction'][0]['description']=='F-2026-001'
    claim=json.loads(pg.sql('SELECT bank_event_claim(\'org-A\','+literal(first['eventId'])+",'test');",s));assert not claim['claimed']
    record('description_conflict_blocks_pending')
    s=fresh(2,legacy=True,bridge=True)
    # Separate synthetic UNMATCHED legacy fixture; no real/historical row touched.
    pg.sql('UPDATE "BankTransaction" SET status=\'UNMATCHED\';',s);before=snapshot(pg,s)['BankTransaction']
    a=copy.deepcopy(seed['steps'][0]);a['body']['amountOre']=12000;o=observe(s,a);after=snapshot(pg,s)
    assert o['reason']=='LEGACY_CONTENT_CONFLICT' and o['bankTransactionId']=='legacy-bank' and o['eventId']
    assert after['BankTransaction']==before and len(after['BankEvent'])==1 and after['BankEvent'][0]['conflict']
    assert pg.sql("SELECT bank_event_allows_automatic('org-A','legacy-bank');",s)=='f'
    assert pg.sql("SELECT bank_event_authorized_attempt('org-A','legacy-bank',NULL);",s)=='f'
    record('legacy_conflict_blocks_unmatched')
    s=fresh(3,legacy=True,bridge=True);o=observe(s,seed['steps'][0]);o2=observe(s,seed['steps'][0])
    assert o['reason']=='LEGACY_CONTENT_CONFLICT' and o2['reason']=='PRIOR_CONTENT_CONFLICT'
    assert pg.sql("SELECT bank_event_allows_automatic('org-A','legacy-bank');",s)=='f';record('legacy_description_conflict_visible')
    s=fresh(4,legacy=True,bridge=True)
    # Explicitly CHANGED synthetic initial description for this extra example.
    pg.sql('UPDATE "BankTransaction" SET description=\'SYNTETISK\';',s);before=snapshot(pg,s)['BankTransaction']
    o=observe(s,seed['steps'][0]);assert o['outcome']=='REPLAY' and o['reason']=='VERIFIED_LEGACY_BRIDGE'
    assert snapshot(pg,s)['BankTransaction']==before;record('legacy_identical_complete_content_replays')
    s=fresh(5);a=copy.deepcopy(seed['steps'][0]);a['body']['amountOre']=1000000000000;o=observe(s,a);after=snapshot(pg,s)
    assert o['outcome']=='REJECTED' and len(after['BankObservation'])==1 and not after['BankTransaction'];record('oversized_money_preserved_rejected')
    assert pg.sql("SELECT json_build_object('type',pg_typeof(bank_event_guard('org-A')::text)::text);",s)=='{"type" : "text"}'
    record('guard_text_cast')
    assert set(done)==set(expected)
    return {'passed':done,'count':len(done),'separateChangedLegacyDescriptionExample':True,'productionImportExecuted':False}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    pg=Postgres()
    try:
        pg.start();result={'previousControls':controls(pg),'reviewControls':review_controls(pg),'database':pg.identity,
         'headAtRun':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
         'sourceHashes':{p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in [HERE/'storage.sql',HERE/'run.py',HERE/'controls.py',HERE/'review_controls.py',DATA/'granskning-komplettering-facit.json']}}
        args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'previousControls':result['previousControls']['count'],'reviewControls':result['reviewControls']['count']}))
    finally:pg.close()
