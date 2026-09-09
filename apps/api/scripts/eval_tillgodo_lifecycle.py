"""Four explicitly labelled lifecycle replays plus separate month-11 extension.

Public input is hash-bound to #870, with no gold/scenario fields in the policy.
The counterfactual changes are listed individually and never called original.
"""
import argparse
from copy import deepcopy
from dataclasses import asdict, replace
import gzip
import hashlib
import json
from pathlib import Path
import re

from referensprov_policy import Bank, Notice, decide
from tillgodo_lifecycle import Lifecycle, period, scope
from tillgodo_pg import Postgres
from test_tillgodo_lifecycle import run_database_proofs

ROOT=Path(__file__).resolve().parents[3]
ART=ROOT/'docs/eval/tillgodo-livscykel'


def encoded(x):return (json.dumps(x,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
def sha(x):return hashlib.sha256(x).hexdigest()
def save(path,x):
    payload=encoded(x)
    with path.open('xb') as f:f.write(gzip.compress(payload,mtime=0) if path.suffix=='.gz' else payload)


def load_public():
    directory=ROOT/'docs/eval/overskottsprov/korning-1'
    raw=gzip.decompress((directory/'public-input.json.gz').read_bytes())
    expected=json.loads((directory/'manifest.json').read_text())['publicInputUncompressedSha256']
    assert sha(raw)==expected
    public=json.loads(raw)
    return tuple(Notice(**n) for n in public['notices']),{k:Bank(**b) for k,b in public['banks'].items()}


def metrics(model, original_keys=None):
    keys=set(model.rows) if original_keys is None else set(original_keys)
    pending={c['bank_event'] for c in model.credits.values() if c['remaining']>0}
    unresolved={k for k,r in model.rows.items() if k in keys and not r['allocations']}
    allocated={k for k,r in model.rows.items() if k in keys and r['allocations']}
    review=(pending & keys)|unresolved
    owners={(c['org'],c['tenant'],c['lease']) for c in model.credits.values() if c['remaining']>0}
    return {'bankEvents':len(keys),'allocationPayments':len(allocated),
            'fullyHandledPaymentsUnderAssumptions':len(allocated-review),'humanReviewPayments':len(review),
            'conflicts':sum(model.rows[k]['reason']=='IDENTITETSKONFLIKT' for k in keys),
            'unidentified':sum(model.rows[k]['reason']=='OTILLRACKLIG_IDENTIFIERING' for k in keys),
            'creditLots':len(model.credits),'createdCreditOre':sum(c['created'] for c in model.credits.values()),
            'outstandingCreditOre':sum(c['remaining'] for c in model.credits.values()),
            'outstandingCreditLots':sum(c['remaining']>0 for c in model.credits.values()),
            'usedCreditOre':sum(c['created']-c['remaining'] for c in model.credits.values()),
            'outstandingCreditCustomerCases':len(owners),'unresolvedPaymentCases':len(unresolved),
            'reviewCases':len(owners)+len(unresolved),'reviewPaymentIds':sorted(review),
            'max20WithinHorizon':len(review)<=20}


def replay(notices,banks,variant,reverse):
    model=Lifecycle(notices)
    order=sorted(banks,reverse=reverse); order.sort(key=lambda k:banks[k].date)
    last_period=max(period(n) for n in notices)
    by_number={n.number.casefold():n.id for n in notices}
    enrolled=set(); changes=[]
    for event in order:
        bank=banks[event]
        model.issue_through(bank.date)
        if variant=='B':
            numbers=set(re.findall(r'(?<!\w)avi-\d{4}-\d{2}-\d{4,}(?!\w)',bank.text.casefold()))
            if len(numbers)==1 and next(iter(numbers)) in by_number:
                n=model.notices[by_number[next(iter(numbers))]]
                if scope(n) in enrolled and period(n)<last_period and n.debt>0:
                    gate=decide(replace(bank,amount=1),tuple(model.notices.values()))
                    if gate.allocations==((n.id,1),):
                        adjusted=model.issued[n.id]['due']
                        if adjusted!=bank.amount:
                            changes.append({'bankEvent':event,'beforeOre':bank.amount,'afterOre':adjusted,
                                'notice':n.id,'reason':'COUNTERFACTUAL_FOLLOWS_DISPLAYED_NOTICE'})
                            bank=replace(bank,amount=adjusted)
        row=model.pay(event,bank)
        if row['credit']:
            c=model.credits[row['credit']]; enrolled.add((c['org'],c['tenant'],c['lease']))
    before=deepcopy(model.snapshot())
    for event in order:model.pay(event,Bank(**model.rows[event]['bank']))
    assert before==model.snapshot()
    result={'variant':variant,'reverseWithinDay':reverse,'changedInput':variant=='B',
            'changes':changes,'metrics':metrics(model),'memory':deepcopy(model.snapshot())}
    return model,result


def extend(model):
    extra=deepcopy(model); original_keys=set(model.rows)
    outstanding=[c for c in extra.credits.values() if c['remaining']>0]
    assert len(outstanding)==1
    c=outstanding[0]; source=extra.original[c['source_notice']]
    n=replace(source,id='extra-2026-08',number='AVI-2026-08-EXTRA',year=2026,month=8,
              issued='2026-08-01',due='2026-08-31',debt=977500)
    # Numeric format is deliberately valid under the existing explicit parser.
    n=replace(n,number='AVI-2026-08-0058')
    extra.original[n.id]=n; extra.notices[n.id]=n
    c['target']=n.id
    plan={'kind':'PLAN_NEXT','id':'plan-extra-next','org':n.org,'credit':c['id'],
          'target':n.id,'authorization':'ASSUMED_STANDING_CONSENT'}
    offset=len(extra.operations); extra.operations.append(plan)
    extra.issue(n.id)
    bank=Bank(n.org,'2026-08-26',extra.issued[n.id]['due'],n.number+' '+n.name,n.ocr)
    extra.pay('EXTRA_PAYMENT_NOT_IN_ORIGINAL_2000',bank)
    return n,{'label':'SEPARATE_MONTH_11_NOT_ORIGINAL_2000','newNotice':asdict(n),
        'newBankEvent':asdict(bank),'originalSubsetMetrics':metrics(extra,original_keys),
        'allEventsMetrics':metrics(extra),'operations':extra.operations[offset:],'memory':extra.snapshot()}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path)
    parser.add_argument('--database',action='store_true',help='Create isolated local network-none Docker Postgres; never reads a DSN')
    args=parser.parse_args(); args.output.mkdir(parents=True,exist_ok=False)
    notices,banks=load_public(); models=[]; results=[]
    for variant in ('A','B'):
        for reverse in (False,True):
            model,result=replay(notices,banks,variant,reverse)
            results.append(result); models.append(model)
            print(variant,reverse,json.dumps(result['metrics'],ensure_ascii=False),flush=True)
    report={'kind':'PROPOSED_CREDIT_LIFECYCLE_EXPERIMENT','productionImplemented':False,
            'realCustomerEvidence':False,'modelCalls':0,'runs':results,'databaseVerified':False,
            'originalBaseline':{'correctAutomatic':1970,'wrongAutomatic':0,'reviewPayments':30},
            'prior870':{'correctAllocationPayments':1980,'reviewPayments':30,'creditOutstandingOre':25000}}
    pg=Postgres()
    if args.database:
        try:
            pg.start(); report['databaseIdentity']=pg.identity
            proofs=run_database_proofs(pg,'exp_proof_first')
            repeated=run_database_proofs(pg,'exp_proof_repeat')
            report['databaseProofs']=proofs; report['databaseProofsRepeated']=repeated
            assert len(proofs)==len(repeated)
            for index,(model,result) in enumerate(zip(models,results)):
                schema=f'exp_replay_{index}'
                pg.setup(schema,notices,model.controls)
                outcomes=pg.execute(schema,model.operations); assert set(outcomes)=={'APPLIED'}
                snapshot=pg.snapshot(schema)
                assert set(pg.execute(schema,model.operations))=={'DUPLICATE'}
                assert pg.snapshot(schema)==snapshot
                result['database']=snapshot
                result['databaseReimport']={'operations':len(outcomes),'allDuplicate':True,'snapshotUnchanged':True}
                extra_notice,extension=extend(model)
                pg.sql(pg.notice_insert(extra_notice),schema)
                assert set(pg.execute(schema,extension['operations']))=={'APPLIED'}
                extension['database']=pg.snapshot(schema)
                result['extension']=extension
                print('Postgres',result['variant'],result['reverseWithinDay'],'verified replay/reimport; separate extension saved',flush=True)
            report['databaseVerified']=True
        finally:pg.close()
    else:
        report['databaseBlocker']='--database was not supplied; no DB proof claimed'
        for model,result in zip(models,results):result['extension']=extend(model)[1]
    paths=[p for p in (ROOT/'apps/api/scripts').iterdir() if p.name in (
        'tillgodo_lifecycle.py','tillgodo_pg.py','tillgodo_experiment.sql','eval_tillgodo_lifecycle.py',
        'audit_tillgodo_lifecycle.py','test_tillgodo_lifecycle.py','referensprov_policy.py','overskottsprov_policy.py')]
    paths.extend([ART/'policy-v1.json',ROOT/'docs/eval/overskottsprov/korning-1/public-input.json.gz',
                  ROOT/'docs/eval/kundflode-2000/grund/kund-och-facit.json.gz'])
    report['sourceHashes']={str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in paths}
    save(args.output/'resultat.json.gz',report)
    save(args.output/'manifest.json',{'uncompressedSha256':sha(encoded(report)),'sourceHashes':report['sourceHashes']})


if __name__=='__main__':main()
