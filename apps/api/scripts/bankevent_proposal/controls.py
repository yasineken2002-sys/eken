"""Separate SQL controls; frozen requirements, no app/provider/queue execution."""
import copy
import json
from pathlib import Path
from run import setup, query, race_sql, Postgres, DATA, literal

EXPECTED=DATA/'sql-kontroller-facit.json'

def controls(pg):
    specs=json.loads(EXPECTED.read_text());passed=[]
    case=json.loads((DATA/'indata-v2.json').read_text())['cases'][0]
    n=0
    def fresh():
        nonlocal n
        n+=1;s='exp_controls_'+str(n);setup(pg,s,case);return s
    def observed(s,step=None):return json.loads(pg.sql(query(step or case['steps'][0]),s))
    def record(name):assert name in specs;passed.append(name)
    s=fresh();o=observed(s);event=o['eventId'];bank=o['bankTransactionId']
    q=lambda token:'SELECT bank_event_claim('+','.join(map(literal,['org-A',event,token]))+');'
    r,witness=race_sql(pg,s,[q('one'),q('two')]);assert sum(x['claimed'] for x in r)==1 and witness['secondSessionLockWaitObserved']
    record('concurrent_claim_one_winner')
    assert pg.sql("SELECT bank_event_authorized_attempt('org-A',"+literal(bank)+",'one');",s)=='t'
    assert pg.sql("SELECT bank_event_authorized_attempt('org-A',"+literal(bank)+",'two');",s)=='f'
    record('only_winning_internal_token')
    assert pg.sql("SELECT bank_event_authorized_attempt('org-B',"+literal(bank)+",'one');",s)=='f'
    record('wrong_org_denied')
    assert pg.sql("SELECT bank_event_allows_automatic('org-A','absent');",s)=='f'
    record('absent_bank_denied')
    s=fresh();o=observed(s);event=o['eventId'];changed=copy.deepcopy(case['steps'][0]);changed['body']['amountOre']=12000
    r,witness=race_sql(pg,s,[query(changed),q('after-conflict')]);assert r[0]['outcome']=='HELD' and r[1]['claimed'] is False and witness['secondSessionLockWaitObserved']
    record('conflict_commits_before_claim_denies')
    pg.sql('UPDATE "BankObservation" SET reason=\'erased\';',s,expect_error='BANK_OBSERVATION_APPEND_ONLY');record('observation_update_denied')
    pg.sql('DELETE FROM "BankObservation";',s,expect_error='BANK_OBSERVATION_APPEND_ONLY');record('observation_delete_denied')
    pg.sql("INSERT INTO \"BankIdentityScope\"(id,\"organizationId\",\"bankAccountAnchor\",\"idContract\",\"proofRef\") VALUES ('fake-second','org-A','BANK-A','other','fake');",s,expect_error='duplicate key');record('second_namespace_same_account_denied')
    pg.sql("INSERT INTO \"BankIdentityBinding\" VALUES ('org-B','X','C','A','api','org-A-scope-A','fake');",s,expect_error='foreign key');record('binding_cross_org_denied')
    s=fresh();step=copy.deepcopy(case['steps'][0]);step['body']['balance']='321.50';qtext=query(step).replace(');',",'SYSTEM');")
    o=json.loads(pg.sql(qtext,s));row=json.loads(pg.sql('SELECT to_jsonb(b) FROM "BankTransaction" b;',s));assert row['actorKind']=='SYSTEM' and row['balance']==321.5
    record('trusted_actor_balance_preserved')
    s='exp_controls_legacy';legacy=dict(case,legacy=True,cutover=True);setup(pg,s,legacy)
    pg.sql('UPDATE "BankTransaction" SET date=\'2026-09-11\';',s)
    assert observed(s)['reason']=='LEGACY_CONTINUITY_UNPROVEN';record('contradictory_cutover_denied')
    assert set(passed)==set(specs)
    return {'kind':'ACTUAL_POSTGRES_SQL_ONLY','passed':passed,'count':len(passed),'claimContentionWitness':witness}

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    pg=Postgres()
    try:
        pg.start();result=controls(pg);result['database']=pg.identity
        args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
    finally:pg.close()
