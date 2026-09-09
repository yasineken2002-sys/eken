"""Independent stdlib-only audit: no import of experiment policy, runner or SQL adapter."""
from collections import Counter
from copy import deepcopy
import argparse
import gzip
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]


def load(path):
    b=path.read_bytes(); return json.loads(gzip.decompress(b) if path.suffix=='.gz' else b)

def sorted_rows(rows):return sorted(rows,key=lambda x:json.dumps(x,sort_keys=True))


def check_database(memory,db,notices):
    expected_notice=[]; expected_bank=[]; expected_credit=[]; expected_alloc=[]; expected_use=[]; vouchers=[]
    for key,n in notices.items():
        issued=memory['issued'][key]
        expected_notice.append({'org':n['org'],'id':key,'tenant':n['tenant'],'lease':n['lease'],
            'period':n['year']*12+n['month']-1,'issue_date':n['issued'],'gross':n['debt'],
            'debt':memory['debts'][key],'issued':True,'display_due':issued['due'],'amendment_required':False})
        vouchers.append({'org':n['org'],'id':'issue:'+key,'reversal_of':None,
                         'lines':[['TEST_RECEIVABLE',n['debt'],0],['TEST_RENT',0,n['debt']]]})
        for use in issued['uses']:
            uid='issue:'+key+':'+use['credit']
            expected_use.append({'org':n['org'],'id':uid,'credit':use['credit'],'notice':key,
                                 'amount':use['amount'],'reversed':False})
            vouchers.append({'org':n['org'],'id':uid,'reversal_of':None,
                'lines':[['TEST_CREDIT',use['amount'],0],['TEST_RECEIVABLE',0,use['amount']]]})
    for key,row in memory['rows'].items():
        b=row['bank']; allocated=sum(row['allocations'].values())
        expected_bank.append({'org':b['org'],'id':key,'payload':b,'amount':b['amount'],
                              'status':'ALLOCATED' if allocated else 'REVIEW'})
        for n,amount in row['allocations'].items():
            expected_alloc.append({'org':b['org'],'bank_event':key,'notice':n,'amount':amount,'reversed':False})
        lines=[['TEST_BANK',b['amount'],0]]
        if allocated:lines.append(['TEST_RECEIVABLE',0,allocated])
        if row['credit_created']:lines.append(['TEST_CREDIT',0,row['credit_created']])
        if row['unallocated']:lines.append(['TEST_UNALLOCATED',0,row['unallocated']])
        vouchers.append({'org':b['org'],'id':'bank:'+key,'reversal_of':None,'lines':lines})
    for c in memory['credits'].values():
        expected_credit.append({'org':c['org'],'id':c['id'],'tenant':c['tenant'],'lease':c['lease'],
            'bank_event':c['bank_event'],'source_notice':c['source_notice'],'target':c['target'],
            'created_date':c['date'],'total':c['created'],'remaining':c['remaining'],'held':False,'reversed':False})
    for table,expected in (('notice',expected_notice),('bank',expected_bank),('credit',expected_credit),
                          ('allocation',expected_alloc),('credit_use',expected_use),('voucher',vouchers)):
        assert sorted_rows(db[table])==sorted_rows(expected),table
    assert sorted_rows(db['operation'])==sorted_rows([{'org':p['org'],'id':p['id'],'payload':p} for p in memory['operations']])
    expected_scopes={(n['org'],n['tenant'],n['lease']) for n in notices.values()}
    assert sorted_rows(db['scope'])==sorted_rows([{'org':o,'tenant':t,'lease':l,'active':True,'consent':True,'refund':False} for o,t,l in expected_scopes])
    for v in db['voucher']:
        assert len(v['lines'])>=2
        assert sum(line[1]-line[2] for line in v['lines'])==0
        for account,d,c in v['lines']:
            assert account.startswith('TEST_') and type(d) is int and type(c) is int
            assert (d>0 and c==0) or (c>0 and d==0)
    return len(vouchers)


def recount(memory,keys=None):
    keys=set(memory['rows']) if keys is None else set(keys)
    pending={c['bank_event'] for c in memory['credits'].values() if c['remaining']>0}
    unresolved={k for k in keys if not memory['rows'][k]['allocations']}
    allocated={k for k in keys if memory['rows'][k]['allocations']}
    review=(pending & keys)|unresolved
    owners={(c['org'],c['tenant'],c['lease']) for c in memory['credits'].values() if c['remaining']>0}
    return {'bankEvents':len(keys),'allocationPayments':len(allocated),
        'fullyHandledPaymentsUnderAssumptions':len(allocated-review),'humanReviewPayments':len(review),
        'conflicts':sum(memory['rows'][k]['reason']=='IDENTITETSKONFLIKT' for k in keys),
        'unidentified':sum(memory['rows'][k]['reason']=='OTILLRACKLIG_IDENTIFIERING' for k in keys),
        'creditLots':len(memory['credits']),'createdCreditOre':sum(c['created'] for c in memory['credits'].values()),
        'outstandingCreditOre':sum(c['remaining'] for c in memory['credits'].values()),
        'outstandingCreditLots':sum(c['remaining']>0 for c in memory['credits'].values()),
        'usedCreditOre':sum(c['created']-c['remaining'] for c in memory['credits'].values()),
        'outstandingCreditCustomerCases':len(owners),'unresolvedPaymentCases':len(unresolved),
        'reviewCases':len(owners)+len(unresolved),'reviewPaymentIds':sorted(review),'max20WithinHorizon':len(review)<=20}


def check_memory(memory,notices,expected_allocations,expected_banks):
    assert set(memory['rows'])==set(expected_banks)
    allocated=Counter(); used=Counter(); credit_used=Counter()
    for key,row in memory['rows'].items():
        assert row['bank']==expected_banks[key],('bank input',key)
        assert row['allocations']==expected_allocations[key],('allocation',key)
        assert all(type(x) is int and x>0 for x in row['allocations'].values())
        assert row['bank']['amount']==sum(row['allocations'].values())+row['credit_created']+row['unallocated']
        allocated.update(row['allocations'])
        if row['credit']:
            credit=memory['credits'][row['credit']]
            assert credit['bank_event']==key and credit['created']==row['credit_created']
            assert len(row['allocations'])==1
            n=notices[next(iter(row['allocations']))]
            assert (credit['org'],credit['tenant'],credit['lease'],credit['source_notice'])==(n['org'],n['tenant'],n['lease'],n['id'])
            assert credit['date']==row['bank']['date'][:10]
        else:assert row['credit_created']==0
    assert set(memory['issued'])==set(notices)==set(memory['debts'])
    for key,issued in memory['issued'].items():
        n=notices[key]
        for usage in issued['uses']:
            c=memory['credits'][usage['credit']]; source=notices[c['source_notice']]
            assert (c['org'],c['tenant'],c['lease'])==(n['org'],n['tenant'],n['lease'])
            assert n['year']*12+n['month']==source['year']*12+source['month']+1
            assert c['target']==key and c['date']<n['issued']
            assert type(usage['amount']) is int and usage['amount']>0
            credit_used[c['id']]+=usage['amount']; used[key]+=usage['amount']
        assert issued['date']==n['issued'] and issued['gross']==n['debt']
        assert issued['deduction']==used[key] and issued['due']==n['debt']-used[key]
        assert memory['debts'][key]==n['debt']-used[key]-allocated[key]>=0
    for key,c in memory['credits'].items():
        assert c['id']==key and c['remaining']==c['created']-credit_used[key]>=0
    # Audit timeline, not just final balances. A use before credit exists or an
    # allocation before issue must fail even if the final sums happen to agree.
    seen_credit={}; seen_notice=set(); events=[]
    for op in memory['operations']:
        if op['kind']=='ISSUE':
            assert op['notice'] not in seen_notice
            seen_notice.add(op['notice'])
            for use in op['uses']:
                assert use['credit'] in seen_credit
                seen_credit[use['credit']]-=use['amount']; assert seen_credit[use['credit']]>=0
        elif op['kind']=='PAYMENT':
            assert all(n in seen_notice for n in op['allocations'])
            events.append(op['event'])
            if op['credit']:
                c=op['credit']; assert c['id'] not in seen_credit
                seen_credit[c['id']]=c['created']
        elif op['kind']=='PLAN_NEXT':
            assert op['authorization']=='ASSUMED_STANDING_CONSENT' and op['target'] not in seen_notice
        else:raise AssertionError('unknown operation')
    assert set(events)==set(expected_banks) and len(events)==len(expected_banks)
    return {'bankOre':sum(b['amount'] for b in expected_banks.values()),'bankAllocationOre':sum(allocated.values()),
            'creditCreatedOre':sum(c['created'] for c in memory['credits'].values()),
            'creditUsedOre':sum(used.values()),'creditOutstandingOre':sum(c['remaining'] for c in memory['credits'].values()),
            'unallocatedOre':sum(r['unallocated'] for r in memory['rows'].values())}


def audit(report,public,world,policy):
    assert report['productionImplemented'] is False and report['modelCalls']==0 and report['realCustomerEvidence'] is False
    assert report['originalBaseline']=={'correctAutomatic':1970,'wrongAutomatic':0,'reviewPayments':30}
    assert report['prior870']=={'correctAllocationPayments':1980,'reviewPayments':30,'creditOutstandingOre':25000}
    assert len(report['runs'])==4
    base_notices={n['id']:n for n in public['notices']}
    original_banks=public['banks']; assert len(original_banks)==2000
    payments={p['id']:p for p in world['betalningar']}
    gold={k:{a['avi']:a['beloppOre'] for a in p['facit']['allokeringar']} for k,p in payments.items()}
    summaries=[]
    for expected_variant,run in zip(('A','A','B','B'),report['runs']):
        variant=run['variant']; assert variant==expected_variant
        assert run['changedInput']==(variant=='B')
        banks=deepcopy(original_banks); expected=deepcopy(gold)
        changes=policy['B']['changedBankEvents'] if variant=='B' else {}
        for key,amount in changes.items():banks[key]['amount']=amount
        assert {c['bankEvent']:c['afterOre'] for c in run['changes']}==changes
        assert len(run['changes'])==len(changes)
        for c in run['changes']:
            assert c['beforeOre']==original_banks[c['bankEvent']]['amount']
            assert c['reason']=='COUNTERFACTUAL_FOLLOWS_DISPLAYED_NOTICE'
        for i in range(10):
            key=f'betalning-57-{i}'; n=payments[key]['facit']['avseddAvi']
            amount=977500-2500*i if variant=='A' else (975000 if i==1 else 977500)
            expected[key]={n:amount}
        memory=run['memory']; totals=check_memory(memory,base_notices,expected,banks)
        order=sorted(banks,reverse=run['reverseWithinDay']); order.sort(key=lambda k:banks[k]['date'])
        assert [p['event'] for p in memory['operations'] if p['kind']=='PAYMENT']==order
        credits=sorted(memory['credits'].values(),key=lambda c:c['date'])
        assert [c['created'] for c in credits]==policy[variant]['expectedCreditCreatedOre']
        assert credits[-1]['bank_event']=='betalning-57-9' and credits[-1]['target'] is None
        actual=recount(memory); assert run['metrics']==actual
        assert actual['allocationPayments']==1980 and actual['fullyHandledPaymentsUnderAssumptions']==1979
        assert actual['humanReviewPayments']==21 and actual['conflicts']==actual['unidentified']==10
        assert actual['outstandingCreditOre']==policy[variant]['expectedCreditOutstandingOre']
        assert actual['usedCreditOre']==policy[variant]['expectedCreditUsedOre']
        assert actual['reviewCases']==21 and actual['outstandingCreditLots']==1 and actual['max20WithinHorizon'] is False
        voucher_count=0
        if report['databaseVerified']:
            voucher_count=check_database(memory,run['database'],base_notices)
            assert run['databaseReimport']=={'operations':len(memory['operations']),'allDuplicate':True,'snapshotUnchanged':True}
        ext=run['extension']; assert ext['label']=='SEPARATE_MONTH_11_NOT_ORIGINAL_2000'
        extra=ext['newNotice']; assert extra['id']=='extra-2026-08' and extra['year']==2026 and extra['month']==8
        next_notices={**base_notices,extra['id']:extra}; next_banks=deepcopy(banks); next_expected=deepcopy(expected)
        extra_event='EXTRA_PAYMENT_NOT_IN_ORIGINAL_2000'
        assert ext['newBankEvent']['amount']==policy['extraMonth'][variant]['customerBankPaymentOre']
        next_banks[extra_event]=ext['newBankEvent']; next_expected[extra_event]={extra['id']:ext['newBankEvent']['amount']}
        check_memory(ext['memory'],next_notices,next_expected,next_banks)
        assert ext['originalSubsetMetrics']==recount(ext['memory'],set(original_banks))
        assert ext['allEventsMetrics']==recount(ext['memory'])
        assert ext['allEventsMetrics']['fullyHandledPaymentsUnderAssumptions']==1981
        assert ext['originalSubsetMetrics']['fullyHandledPaymentsUnderAssumptions']==1980
        assert ext['originalSubsetMetrics']['humanReviewPayments']==20
        assert ext['allEventsMetrics']['bankEvents']==2001 and ext['allEventsMetrics']['outstandingCreditOre']==0
        if report['databaseVerified']:check_database(ext['memory'],ext['database'],next_notices)
        summaries.append({'variant':variant,'reverseWithinDay':run['reverseWithinDay'],
            'correctAllocationPayments':1980,'wrongDecisions':0,'metrics':actual,'totalsOre':totals,
            'databaseVouchersChecked':voucher_count,'extraMonthOriginalSubsetReview':20,
            'originalHorizonMax20':False,'extraMonthMax20ConditionalOnAssumptionsAndNewInput':report['databaseVerified']})
    for left,right in ((report['runs'][0],report['runs'][1]),(report['runs'][2],report['runs'][3])):
        assert left['reverseWithinDay'] is False and right['reverseWithinDay'] is True
        for key in ('rows','credits','debts','issued'):assert left['memory'][key]==right['memory'][key],key
        assert left['metrics']==right['metrics']
    if report['databaseVerified']:
        identity=report['databaseIdentity']
        assert identity['database']=='eveno_tillgodo_test' and identity['address'] is None
        assert identity['network']=='none' and identity['ports']==[] and identity['userTables']==0
        assert identity['fsync']==identity['synchronousCommit']=='on'
        for group in ('databaseProofs','databaseProofsRepeated'):
            assert len(report[group])==19 and all(p['passed'] for p in report[group])
            concurrent=next(p for p in report[group] if p['test']=='concurrent_credit_use')
            assert concurrent['observedPostgresLockWait'] and concurrent['committedUses']==1
    return {'passed':True,'runs':summaries,'databaseVerified':report['databaseVerified'],
            'uniqueOriginalBankEvents':2000,'originalBankEventReplaysChecked':8000,
            'newAndOldDataKeptSeparate':True,'orderParity':True}


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('directory',type=Path); parser.add_argument('output',type=Path)
    args=parser.parse_args(); assert not args.output.exists()
    raw=gzip.decompress((args.directory/'resultat.json.gz').read_bytes()); report=json.loads(raw)
    manifest=load(args.directory/'manifest.json'); assert hashlib.sha256(raw).hexdigest()==manifest['uncompressedSha256']
    assert manifest['sourceHashes']==report['sourceHashes']
    for path,expected in report['sourceHashes'].items():assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==expected,path
    public=load(ROOT/'docs/eval/overskottsprov/korning-1/public-input.json.gz')
    world_path=ROOT/'docs/eval/kundflode-2000/grund/kund-och-facit.json.gz'
    frozen=load(ROOT/'docs/eval/kundflode-2000/manifest.json')
    assert hashlib.sha256(gzip.decompress(world_path.read_bytes())).hexdigest()==frozen['filer']['grund/kund-och-facit.json.gz']['originalSha256']
    world=load(world_path); policy=load(ROOT/'docs/eval/tillgodo-livscykel/policy-v1.json')
    result=audit(report,public,world,policy); negative=[]
    for kind in ('missing_ore','wrong_source_scope','duplicate_use','changed_input_hidden','false_completion','unbalanced_voucher','hidden_final_credit','use_before_creation'):
        broken=deepcopy(report); run=broken['runs'][0]; credit=next(iter(run['memory']['credits'].values()))
        if kind=='missing_ore':credit['created']+=1
        elif kind=='wrong_source_scope':credit['lease']='another-lease'
        elif kind=='duplicate_use':
            issue=next(x for x in run['memory']['issued'].values() if x['uses']); issue['uses'].append(deepcopy(issue['uses'][0]))
        elif kind=='changed_input_hidden':broken['runs'][2]['changedInput']=False
        elif kind=='false_completion':run['metrics']['fullyHandledPaymentsUnderAssumptions']=1980
        elif kind=='unbalanced_voucher':run['database']['voucher'][0]['lines'][0][1]+=1
        elif kind=='hidden_final_credit':run['memory']['credits']['credit:betalning-57-9']['remaining']=0
        elif kind=='use_before_creation':
            ops=run['memory']['operations']; idx=next(i for i,p in enumerate(ops) if p['kind']=='ISSUE' and p['uses']); ops.insert(0,ops.pop(idx))
        try:audit(broken,public,world,policy)
        except AssertionError:negative.append({'mutation':kind,'rejected':True})
        else:raise AssertionError('Missed negative control '+kind)
    result['negativeControls']=negative; result['reportUncompressedSha256']=hashlib.sha256(raw).hexdigest()
    with args.output.open('x') as f:f.write(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
