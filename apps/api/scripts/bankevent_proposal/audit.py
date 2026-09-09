"""Independent stdlib recount. Never imports the SQL runner or production code."""
import argparse
import copy
import gzip
import hashlib
import json
from decimal import Decimal
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4]
DATA=ROOT/'docs/eval/bankhandelse-forslag'
sha=lambda b:hashlib.sha256(b).hexdigest()
ore=lambda value:int(Decimal(str(value))*100)


def audit(observed):
    inputs=json.loads((DATA/'indata.json').read_text())['cases']
    expected=json.loads((DATA/'facit.json').read_text())['cases']
    assert observed['kind']=='PROPOSED_SQL_COMPONENT_NOT_PRODUCTION_IMPORT'
    assert len(observed['cases'])==len(inputs)==len(expected)==31
    assert [c['id'] for c in observed['cases']]==[c['id'] for c in inputs]
    result=[]
    for case,inp in zip(observed['cases'],inputs):
        g=expected[case['id']];snap=case['snapshot'];before=case['before'];trace=case['trace']
        banks={b['id']:b for b in snap['BankTransaction']};events={e['id']:e for e in snap['BankEvent']}
        observations={o['id']:o for o in snap['BankObservation']};scopes={s['id']:s for s in snap['BankIdentityScope']}
        assert len(banks)==len(snap['BankTransaction']) and len(events)==len(snap['BankEvent'])
        assert len(observations)==len(snap['BankObservation'])
        assert len(events)==len({(e['scopeId'],e['externalId']) for e in events.values()})
        assert len(events)==len({e['bankTransactionId'] for e in events.values()})
        for table in ['BankIdentityScope','BankIdentityBinding','BankIdentityBridge']:
            assert snap[table]==before[table],'Registry cannot be manufactured from payment input'
        for old in before['BankTransaction']:assert banks[old['id']]==old,'Legacy payment rewritten'
        new=[b for b in banks.values() if b['id'] not in {old['id'] for old in before['BankTransaction']}]
        assert {b['id'] for b in new}=={e['bankTransactionId'] for e in events.values() if e['state']!='LEGACY'}
        receipts=[t for t in trace if t['phase']=='observe'];rollbacks=[t for t in trace if t['phase']=='rollback']
        assert len(receipts)+len(rollbacks)==len(inp['steps'])
        assert [t['input'] for t in trace if t['phase'] in ('observe','rollback')]==inp['steps']
        assert len(receipts)==len(observations)==g.get('committedObservations',len(inp['steps']))
        for t in receipts:
            o=observations[t['result']['observationId']];step=t['input']
            assert (o['organizationId'],o['origin'],o['externalId'],o['body'])==(step['org'],step['origin'],step['externalId'],step['body'])
            assert (o['outcome'],o['reason'],o['eventId'])==(t['result']['outcome'],t['result']['reason'],t['result']['eventId'])
            if o['eventId']:
                e=events[o['eventId']];assert e['organizationId']==o['organizationId']
                matches=[b for b in snap['BankIdentityBinding'] if b['organizationId']==step['org'] and all(b[k]==step['origin'][k] for k in ['provider','consent','account','kind'])]
                assert len(matches)==1 and matches[0]['scopeId']==e['scopeId']
                assert e['externalId']==step['externalId']
                assert t['result']['bankTransactionId']==e['bankTransactionId']
        for e in events.values():
            b=banks[e['bankTransactionId']]
            assert scopes[e['scopeId']]['organizationId']==e['organizationId']==b['organizationId']
            assert ore(b['amount'])==e['body']['amountOre'] and b['date'][:10]==e['body']['day']
            assert b['rawOcr']==e['body']['rawOcr']
            assert any(o['eventId']==e['id'] and all(o['body'].get(k)==v for k,v in e['body'].items()) for o in observations.values())
            if e['conflict']:assert any(o['eventId']==e['id'] and o['reason']=='CONTENT_CONFLICT' for o in observations.values())
        claims=[t for t in trace if t['phase']=='claim' and t['result']['claimed']]
        assert len(claims)==len({t['eventId'] for t in claims}),'Same event claimed more than once'
        for t in claims:
            e=events[t['eventId']]
            assert t['org']==e['organizationId'] and t['result']['bankTransactionId']==e['bankTransactionId']
            assert t['token']==t['result']['token']==e['attemptToken']
        markers=snap['TestDispatch']
        assert len(markers)==len({m['eventId'] for m in markers})
        for marker in markers:
            e=events[marker['eventId']];assert any(t['eventId']==e['id'] for t in claims)
            assert (marker['bankId'],marker['org'],marker['amountOre'],marker['queueMarker'])==(e['bankTransactionId'],e['organizationId'],e['body']['amountOre'],1)
        for gate in [t for t in trace if t['phase']=='automatic-gate']:
            blocked=any(e['bankTransactionId']==gate['bankId'] and (e['state'] in ['PENDING','STARTED','UNCERTAIN'] or e['conflict']) for e in events.values())
            assert gate['allowed']==(not blocked)
        for org,value in case['openIdentity'].items():
            assert value==(any(o['organizationId']==org and o['outcome']=='HELD' for o in observations.values()) or any(e['organizationId']==org and (e['state'] in ['PENDING','STARTED','UNCERTAIN'] or e['conflict']) for e in events.values()))
        assert case['overlap']==({'separateSessions':2,'secondSessionLockWaitObserved':True} if inp['mode']=='concurrent' else None)
        r={'id':case['id'],'observations':len(observations),'newPayments':len(new),'newPaymentOre':sum(ore(b['amount']) for b in new),
           'legacyPayments':len(before['BankTransaction']),'legacyOre':sum(ore(b['amount']) for b in before['BankTransaction']),
           'events':len(events),'held':sum(o['outcome']=='HELD' for o in observations.values()),
           'rejected':sum(o['outcome']=='REJECTED' for o in observations.values()),
           'replays':sum(o['outcome']=='REPLAY' for o in observations.values()),
           'dispatchMarkers':len(markers),'simulatedDispatchOre':sum(m['amountOre'] for m in markers),
           'openIdentity':any(case['openIdentity'].values()),'uncertainEvents':sum(e['state'] in ['STARTED','UNCERTAIN'] for e in events.values()),
           'productionAllocationsTested':False,'productionQueueTested':False}
        for key in ['newPayments','newPaymentOre','dispatchMarkers','held','openIdentity']:
            assert r[key]==g[key],(case['id'],key,r[key],g[key])
        if 'rejected' in g:assert r['rejected']==g['rejected']
        result.append(r)
    return result


def negatives(observed):
    def c(x,k):return next(c for c in x['cases'] if c['id']==k)
    mutations={
       'lost_100_kronor':lambda x:c(x,'01-two-equal-events')['snapshot']['BankTransaction'].pop(),
       'double_dispatch_money':lambda x:c(x,'02-exact-reimport')['snapshot']['TestDispatch'].append(copy.deepcopy(c(x,'02-exact-reimport')['snapshot']['TestDispatch'][0])),
       'wrong_stored_amount':lambda x:c(x,'01-two-equal-events')['snapshot']['BankTransaction'][0].update(amount=50),
       'wrong_dispatch_amount':lambda x:c(x,'01-two-equal-events')['snapshot']['TestDispatch'][0].update(amountOre=1),
       'lost_original_observation':lambda x:c(x,'10-unproven-api-file')['snapshot']['BankObservation'].pop(),
       'forged_account_link':lambda x:c(x,'05-account-local-id')['snapshot']['BankEvent'][0].update(scopeId='org-A-scope-B' if c(x,'05-account-local-id')['snapshot']['BankEvent'][0]['scopeId']=='org-A-scope-A' else 'org-A-scope-A'),
       'wrong_organization':lambda x:c(x,'06-organization-isolation')['snapshot']['BankEvent'][0].update(organizationId='org-X'),
       'rewritten_legacy':lambda x:c(x,'15-legacy-verified-link')['snapshot']['BankTransaction'][0].update(amount=1),
       'hidden_uncertain':lambda x:c(x,'24-crash-after-effect')['openIdentity'].update({'org-A':False}),
       'fake_concurrency':lambda x:c(x,'03-concurrent-reimport').update(overlap=None),
    }
    for name,fn in mutations.items():
        changed=copy.deepcopy(observed);fn(changed)
        try:audit(changed)
        except (AssertionError,KeyError,StopIteration):continue
        raise AssertionError('Negative mutation escaped: '+name)
    return list(mutations)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('directory',type=Path);parser.add_argument('--out',type=Path);a=parser.parse_args()
    p=a.directory;manifest=json.loads((p/'manifest.json').read_text());raw=(p/'observationer.json.gz').read_bytes();data=gzip.decompress(raw)
    assert sha(raw)==manifest['gzipSha256'] and sha(data)==manifest['observationSha256']
    for group in ['sourceHashes','preservedHashes']:
        for file,digest in manifest[group].items():assert sha((ROOT/file).read_bytes())==digest,file
    observed=json.loads(data);rows=audit(observed);controls=negatives(observed)
    report={'kind':'SQL_COMPONENT_ONLY_NOT_FIXED_IMPORT','casesPassed':len(rows),'negativeControlsRejected':controls,'cases':rows}
    if a.out:
        a.out.mkdir(parents=True,exist_ok=True)
        (a.out/'omrakning.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        lines=['# Separata SQL-komponentprov — inte #874:s 31 originalfall','',
          'Provider, Prisma, faktiska import-/matchmetoder och köer körs inte. Markörer är syntetiska anropsobservatörer; de är inte ekonomisk färdighantering.','',
          '| Fall | Observationer | Nya betalningsrader / öre | Äldre rader / öre | Replay / held / avvisat | Testanrop / öre | Öppen identitet |',
          '| --- | ---: | ---: | ---: | ---: | ---: | --- |']
        for r in rows:lines.append(f"| {r['id']} | {r['observations']} | {r['newPayments']} / {r['newPaymentOre']} | {r['legacyPayments']} / {r['legacyOre']} | {r['replays']} / {r['held']} / {r['rejected']} | {r['dispatchMarkers']} / {r['simulatedDispatchOre']} | {r['openIdentity']} |")
        (a.out/'falltabell.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='cases'},ensure_ascii=False))


if __name__=='__main__':main()
