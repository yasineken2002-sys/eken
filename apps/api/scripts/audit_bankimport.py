"""Independent diagnostic recount, stdlib only; no production/loader imports.

Exits nonzero for corrupt harness evidence. Desired product violations remain
explicit FAIL rows in the diagnostic report, never disguised as passing product tests.
"""
import argparse
import copy
import gzip
import hashlib
import json
import subprocess
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[3]
DATA=ROOT/'docs/eval/bankimport-identitet'
sha=lambda b:hashlib.sha256(b).hexdigest()
ore=lambda n:int(Decimal(str(n))*100)


def instant(value):
    return datetime.fromisoformat(value.replace('Z','+00:00'))


def matches(row,where):
    """Independently replay actual repository predicates, not dedup policy."""
    for key,value in where.items():
        got=row.get(key)
        if isinstance(value,dict):
            assert value=={'not':None}
            if got is None:return False
        elif key=='date':
            if instant(got)!=instant(value):return False
        elif key=='amount':
            if Decimal(str(got))!=Decimal(str(value)):return False
        elif got!=value:return False
    return True


def normalize_raw(raw):
    x=copy.deepcopy(raw);x['bookingDate']=instant(x['bookingDate']).isoformat()
    return x


def audit(observed):
    fixture=json.loads((DATA/'indata.json').read_text())
    expected=json.loads((DATA/'facit.json').read_text())['cases']
    if 'supplementSha256' in observed:
        assert observed['supplementSha256']==sha((DATA/'tillagg-indata.json').read_bytes())
        fixture['cases']+=json.loads((DATA/'tillagg-indata.json').read_text())['cases']
        expected.update(json.loads((DATA/'tillagg-facit.json').read_text())['cases'])
    inputs={c['id']:c for c in fixture['cases']}
    assert observed['inputSha256']==sha((DATA/'indata.json').read_bytes())
    assert observed['forbidden']==[]
    assert observed.get('evidenceVersion') in (None,2)
    extended=observed.get('evidenceVersion')==2
    if extended:assert observed['boundaryControls']['nullIdentity']=={'rows':2,'nullIds':2,'nullKeys':2,'ore':300}
    assert len(observed['cases'])==len(inputs)==len(expected)==(31 if 'supplementSha256' in observed else 29)
    assert {c['id'] for c in observed['cases']}==set(inputs)
    for file,details in observed['sourceModules'].items():
        assert sha((ROOT/file).read_bytes())==details['sha256'],file
    probe=observed['dedupProbe']
    assert probe['stockholmDay']=='2026-09-02T00:00:00.000Z'
    assert probe['key']==sha(b'2026-09-02|100.00|00123459')
    results=[]
    for case in observed['cases']:
        k=case['id'];inp=inputs[k];gold=expected[k];rows=case['snapshot']['rows']
        assert len(rows)==len({r['id'] for r in rows})
        assert len(rows)==len({(r['organizationId'],r['externalId']) for r in rows if r['externalId'] is not None})+sum(r['externalId'] is None for r in rows)
        # Rebuild saved rows solely from actual successful create calls. A mock
        # that narrows the broad production query to files is caught here.
        saved={}
        for event in case['repositoryTrace']:
            if event['method']=='bankTransaction.findFirst':
                candidates=[r for r in saved.values() if matches(r,event['query']['where'])]
                got=event['result']
                assert (got is not None)==bool(candidates),(k,'false repository answer')
                if got is not None:
                    assert got['id'] in {r['id'] for r in candidates}
                    if 'select' not in event['query']:assert got==saved[got['id']]
            elif event['method']=='bankTransaction.create':
                data=event['query']['data']
                if event.get('error'):
                    assert event['error']=='SQLSTATE_23505_TO_P2002'
                    assert data.get('externalId') is not None
                    assert any(r['organizationId']==data['organizationId'] and r['externalId']==data['externalId'] for r in saved.values())
                else:
                    r={'id':event['createdId'],'externalId':None,'dedupKey':None,'reference':None,'rawOcr':None,
                       'balance':None,'status':'UNMATCHED',**data}
                    assert r['id'] not in saved;saved[r['id']]=r
            elif event['method']=='bankConsent.findMany':
                candidates=[c for c in case['snapshot']['consents'] if matches(c,event['query']['where'])]
                assert set(event['ids'])=={c['id'] for c in candidates},(k,'consent scope')
            else:
                assert event['method'] in ('bankConsent.update','bankStatementImport.create')
        assert sorted(saved.values(),key=lambda r:r['id'])==rows,(k,'rows do not equal successful SQL creates')
        for r in rows:
            assert r['organizationId'].startswith('test-org-')
            assert Decimal(str(r['amount']))*100==ore(r['amount'])
            if r['dedupKey']:
                signature=f"{r['date'][:10]}|{Decimal(r['amount']):.2f}|{r['rawOcr']}"
                assert r['dedupKey']==sha(signature.encode())
        calls=case['calls'];imported=duplicates=rejected=0;import_ids=[]
        for call in calls:
            assert 'error' not in call,(k,'unhandled ingest error')
            r=call['result']
            if call['method']=='ingestFromApi':
                assert r['outcome'] in ('imported','duplicate','rejected')
                imp=r['outcome']=='imported';dup=r['outcome']=='duplicate';rej=r['outcome']=='rejected'
                if imp or dup:
                    assert r['transactionId'] in saved
                    assert saved[r['transactionId']]['organizationId']==call['org']
            else:
                assert call['method']=='ingestFromFile';dup=r['duplicate'];imp=not dup;rej=False
            imported+=imp;duplicates+=dup;rejected+=rej
            if imp:
                import_ids.append(r['transactionId'])
                d=next(d for d in case['downstream'] if d['row']['id']==r['transactionId'])
                # Observer throws a host-realm Error; the VM's catch wraps its
                # String(error), retaining the explicit synthetic failure marker.
                if d['injectedError']:assert r.get('matchError')=='Error: INJECTED_SYNTHETIC_MATCH_ERROR',(k,'missing explicit matchError')
                else:assert not r.get('matchError'),(k,'unexpected matchError')
                stored=saved[r['transactionId']]
                if call['method']=='ingestFromApi':
                    raw=call['raw']
                    assert stored['externalId']==call['externalId']
                    assert stored['description']==raw['description']
                    assert Decimal(stored['amount'])==Decimal(str(raw['amount']))
                    assert stored['date'][:10]==instant(raw['bookingDate']).astimezone(ZoneInfo('Europe/Stockholm')).date().isoformat()
                    assert stored['reference']==(raw.get('reference') or None)
                    if raw.get('ocr'):assert stored['rawOcr']==raw['ocr']
                else:
                    for field,value in call['input']['data'].items():assert stored[field]==value
        assert imported==len(rows) and len(set(import_ids))==imported
        assert len(case['downstream'])==imported
        assert {d['row']['id'] for d in case['downstream']}==set(import_ids)
        for d in case['downstream']:
            assert d['organizationId']==saved[d['row']['id']]['organizationId']
            assert d['row']==saved[d['row']['id']]
        assert len(case['queue'])==sum(not d['injectedError'] for d in case['downstream'])
        assert {q['bankTransactionId'] for q in case['queue']}=={d['row']['id'] for d in case['downstream'] if not d['injectedError']}
        for q in case['queue']:assert q['organizationId']==saved[q['bankTransactionId']]['organizationId']
        if inp['kind']=='ingest':
            assert len(calls)==len(inp['steps'])
            for step,call in zip(inp['steps'],calls):
                assert call['org']==step['org']
                if step['kind']=='api':
                    assert call['externalId']==step['externalId'] and normalize_raw(call['raw'])==normalize_raw(step['raw'])
                else:
                    day=step['date']+'T00:00:00.000Z';amount=f"{Decimal(step['amountOre'])/100:.2f}"
                    assert call['method']=='ingestFromFile'
                    assert call['input']=={
                        'dedup':{'date':day,'description':step['description'],'amount':amount},
                        'data':{'date':day,'description':step['description'],'amount':amount,'reference':step['reference'],'rawOcr':step['rawOcr']},
                        'crossSource':{'date':day,'amount':amount,'ocr':step['rawOcr']}},(k,'file input differs from frozen step')
        else:
            assert len(case['rounds'])==inp['rounds']*len(inp['organizations'])
            by_id={c['id']:c for c in case['snapshot']['consents']}
            updates=[e for e in case['repositoryTrace'] if e['method']=='bankConsent.update']
            # A snapshot's final cursor must be the last actual update, not a
            # value reconstructed from provider labels/account names.
            for cid,c in by_id.items():
                changed=[u['query']['data']['syncCursor'] for u in updates if u['query']['where']['id']==cid and 'syncCursor' in u['query']['data']]
                assert c['syncCursor']==(changed[-1] if changed else None)
            successes=[r for r in case['rounds'] if 'result' in r]
            assert len(case['snapshot']['imports'])==len(successes)
            for r in successes:
                x=r['result'];assert x['fetched']==x['imported']+x['duplicates']+x['rejected']
                assert x['organizationId']==r['org'] and x['consents']==1 and x['matched']==0
            assert sum(r['result']['imported'] for r in successes)==imported
            # In these fixtures fetch failure occurs before ANY ingestion in the failed round.
            previous=[]
            for r in case['rounds']:
                if 'error' in r:assert r['snapshot']['rows']==previous
                previous=r['snapshot']['rows']
            transport_errors=0
            for p in case['providerCalls']:
                assert p['accountId'] in inp['accounts']
                if 'result' in p:
                    want=inp['pages'][p['accountId']][p['since'] or 'START']
                    assert p['result']['cursor']==want['cursor']
                    assert [normalize_raw(t) for t in p['result']['transactions']]==[normalize_raw(t) for t in want['transactions']]
                elif p['error']=='HYPOTHETICAL_CURSOR_SCOPE_MISMATCH':
                    assert (p['since'] or 'START') not in inp['pages'][p['accountId']]
                else:
                    transport_errors+=1
                    assert p['error']=='INJECTED_ACCOUNT_TRANSPORT_ERROR' and p['accountId']==inp['failOnce'] and transport_errors==1
            if extended:
                provider_end=ingest_end=0;cursor_by_org={org:None for org in inp['organizations']}
                setup=[]
                previous_state={'rows':[],'imports':[],'consents':[{
                    'id':'consent-'+str(i),'organizationId':org,'consentId':'synthetic-consent-'+str(i),
                    'status':'ACTIVE','accessTokenEnc':'SYNTHETIC_NO_SECRET','syncCursor':None
                    } for i,org in enumerate(inp['organizations'])]}
                for r in case['rounds']:
                    assert r['providerStart']==provider_end and r['ingestStart']==ingest_end
                    provider_end=r['providerEnd'];ingest_end=r['ingestEnd']
                    ps=case['providerCalls'][r['providerStart']:provider_end]
                    ing=calls[r['ingestStart']:ingest_end]
                    cid='synthetic-consent-'+str(inp['organizations'].index(r['org']))
                    setup += [{'method':method,'consentId':cid} for method in ('getConsentStatus','listAccounts')]
                    assert [p['accountId'] for p in ps]==inp['accounts'][:len(ps)]
                    for p in ps:
                        assert p['consentId']==cid,(k,'wrong consent for organization')
                        assert p['since']==cursor_by_org[r['org']],(k,'cursor not from stored consent')
                    if 'error' in r:
                        assert ps and 'error' in ps[-1] and ing==[]
                        assert r['snapshot']==previous_state,(k,'failed round changed stored state')
                    else:
                        assert len(ps)==len(inp['accounts']) and all('result' in p for p in ps)
                        delivered=[tx for p in ps for tx in p['result']['transactions']]
                        assert len(delivered)==len(ing)
                        for tx,call in zip(delivered,ing):
                            assert call['method']=='ingestFromApi' and call['org']==r['org']
                            assert call['externalId']==tx['externalId']
                            want={key:tx[key] for key in ('bookingDate','booked','currency','amount','description')}
                            for key in ('ocr','reference'):
                                if tx.get(key):want[key]=tx[key]
                            assert normalize_raw(call['raw'])==normalize_raw(want),(k,'provider delivery changed before ingest')
                        counts={key:sum(c['result']['outcome']==value for c in ing) for key,value in [('imported','imported'),('duplicates','duplicate'),('rejected','rejected')]}
                        assert r['result']['fetched']==len(delivered)
                        for key,value in counts.items():assert r['result'][key]==value
                    current=next(c for c in r['snapshot']['consents'] if c['organizationId']==r['org'])
                    cursor_by_org[r['org']]=current['syncCursor']
                    previous_state=r['snapshot']
                assert provider_end==len(case['providerCalls']) and ingest_end==len(calls)
                assert case['providerSetup']==setup,(k,'wrong account/status consent scope')
        totals=dict(saved=len(rows),savedOre=sum(ore(r['amount']) for r in rows),imported=imported,duplicates=duplicates,
                    rejected=rejected,unmatchedStored=sum(r['status']=='UNMATCHED' for r in rows),
                    downstreamCalls=len(case['downstream']),queueCalls=len(case['queue']),
                    syncErrors=sum('error' in r for r in case['rounds']),
                    rowsWithAccount=sum('accountId' in r for r in rows),rowsWithProvider=sum('provider' in r for r in rows),
                    references=[r['reference'] for r in rows],rawOcr=[r['rawOcr'] for r in rows],
                    providerCalls=len(case['providerCalls']),
                    providerReturnedTransactions=sum(len(p.get('result',{}).get('transactions',[])) for p in case['providerCalls']),
                    apiCalls=sum(c['method']=='ingestFromApi' for c in calls),fileCalls=sum(c['method']=='ingestFromFile' for c in calls),
                    viaDedupKey=sum(c['result'].get('via')=='dedupKey' for c in calls),
                    viaExternalId=sum(c['result'].get('via')=='externalId' for c in calls),
                    organizations=sorted({r['organizationId'] for r in rows}))
        violations=[]
        for target,actual in [('distinctEvents','saved'),('amountOre','savedOre'),('imported','imported'),
                              ('duplicates','duplicates'),('rejected','rejected'),('downstreamCalls','downstreamCalls'),
                              ('queueCalls','queueCalls'),('rawOcr','rawOcr'),('references','references'),('organizations','organizations')]:
            if target in gold and gold[target]!=totals[actual]:violations.append(f'{target}: expected {gold[target]!r}, observed {totals[actual]!r}')
        if gold.get('requiresChangeSignal') and not any(c['result'].get('reason')=='CONTENT_CHANGED' for c in calls):
            violations.append('NO_EXPLICIT_CHANGED_CONTENT_SIGNAL')
        if gold.get('requiresSourceUncertainty') and not any(c['result'].get('reason')=='SOURCE_IDENTITY_UNPROVEN' for c in calls):
            violations.append('NO_EXPLICIT_CROSS_SOURCE_UNCERTAINTY')
        if gold.get('requireAccountContext') and totals['rowsWithAccount']!=len(rows):
            violations.append('ACCOUNT_CONTEXT_NOT_STORED')
        results.append({'id':k,'intendedDistinct':gold['distinctEvents'],'intendedOre':gold['amountOre'],
                        **totals,'requirements':'FAIL' if violations else 'PASS','violations':violations})
    # Same/different physical-event pairs really have identical method inputs,
    # fresh schema state, downstream calls and observed outcomes.
    byid={c['id']:c for c in observed['cases']}
    for order in ('file-api','api-file'):
        a='F-'+order+'-same-event';b='F-'+order+'-different-events'
        assert inputs[a]['steps']==inputs[b]['steps']
        for field in ('calls','repositoryTrace','snapshot','downstream','queue'):
            assert byid[a][field]==byid[b][field],(order,'pair is distinguishable inside harness')
    return results


def negatives(observed):
    def case(x,k):return next(c for c in x['cases'] if c['id']==k)
    changes={
        'lost_saved_row':lambda x:case(x,'I01-distinct-same-fields')['snapshot']['rows'].clear(),
        'invented_second_event':lambda x:case(x,'I01-distinct-same-fields')['calls'][1]['result'].update(outcome='imported'),
        'hidden_broad_query_result':lambda x:case(x,'I01-distinct-same-fields')['repositoryTrace'][-1].update(result=None),
        'invented_account_preservation':lambda x:case(x,'S-account-local-id')['snapshot']['rows'][0].update(accountId='A'),
        'missing_downstream_call':lambda x:case(x,'I02-exact-reimport')['downstream'].clear(),
        'wrong_organization':lambda x:case(x,'I04-organization-isolation')['snapshot']['rows'][0].update(organizationId='test-org-X'),
        'cursor_reconstructed_from_label':lambda x:case(x,'S-account-cursors-AB')['snapshot']['consents'][0].update(syncCursor='A:1'),
        'hidden_forbidden_call':lambda x:x['forbidden'].append('unexpected bank/network dependency'),
        'missing_explicit_match_error':lambda x:case(x,'I13-matching-error-reimport')['calls'][0]['result'].pop('matchError'),
    }
    if observed.get('evidenceVersion')==2:
        changes.update({
            'wrong_provider_consent':lambda x:case(x,'S-sync-organization-scope')['providerCalls'][0].update(consentId='synthetic-consent-1'),
            'changed_provider_to_ingest_link':lambda x:case(x,'S-reimport-account-pages')['calls'][-1]['raw'].update(description='unproven replacement'),
            'wrong_sync_duplicate_counter':lambda x:case(x,'S-reimport-account-pages')['rounds'][1]['result'].update(duplicates=1,rejected=1),
            'explicit_null_collapses':lambda x:x['boundaryControls']['nullIdentity'].update(rows=1),
            'missing_provider_delivery':lambda x:case(x,'S-shared-cursor-AB')['providerCalls'].pop(0),
            'valid_cursor_claimed_invalid':lambda x:case(x,'S-account-cursors-AB')['providerCalls'][-1].update(since='A:1'),
            'changed_both_file_pair_inputs':lambda x:[case(x,k)['calls'][0]['input']['data'].update(description='changed') for k in ('F-file-api-same-event','F-file-api-different-events')],
        })
    for name,mutate in changes.items():
        changed=copy.deepcopy(observed);mutate(changed)
        try:audit(changed)
        except (AssertionError,StopIteration):continue
        raise AssertionError('Negative control escaped: '+name)
    return list(changes)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('observations',type=Path);parser.add_argument('--out',type=Path)
    parser.add_argument('--evidence-commit',help='Explicit archived harness source commit, read with git show; no checkout')
    a=parser.parse_args()
    raw=a.observations.read_bytes();decoded=gzip.decompress(raw) if a.observations.suffix=='.gz' else raw
    manifest=json.loads((a.observations.parent/'manifest.json').read_text())
    assert sha(decoded)==manifest['observationsUncompressedSha256']
    if a.observations.suffix=='.gz':assert sha(raw)==manifest['observationsGzipSha256']
    verified=0
    for group in ('sourceHashes','harnessHashes','historicalHashes'):
        for file,digest in manifest[group].items():
            p=(ROOT/file).resolve();assert p.is_relative_to(ROOT)
            content=(subprocess.check_output(['git','show',a.evidence_commit+':'+file],cwd=ROOT)
                     if a.evidence_commit and group=='harnessHashes' else p.read_bytes())
            assert sha(content)==digest,(group,file)
            verified+=1
    observed=json.loads(decoded)
    rows=audit(observed);rejected=negatives(observed)
    report={'harnessRecount':'PASS','verifiedFileHashes':verified,'archivedHarnessCommit':a.evidence_commit,
        'negativeControlsRejected':rejected,'productCaseRequirements':{
        'PASS':sum(r['requirements']=='PASS' for r in rows),'FAIL':sum(r['requirements']=='FAIL' for r in rows)},'cases':rows}
    if a.out:
        a.out.mkdir(parents=True,exist_ok=True)
        (a.out/'omrakning.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        lines=['# Faktiska bankimportfall — produktkrav och observation','',
          'FAIL är en avvikelse från det frysta testkontraktet. HYPOTETISKA namespaces/cursors är inte verifierade bankavtal.',
          'Inga matchningar eller bokföringar körs; nedströms betyder observerade anrop till ersatt matchningsgräns. Alla belopp nedan är heltalsören.','',
          '| Fall | Avsedda / sparade | Avsett / sparat öre | Import / dup / avvisat | Olösta sparade | Matchanrop / köanrop | Synkfel | Kontofält / rader | Krav |',
          '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |']
        for r in rows:lines.append(f"| {r['id']} | {r['intendedDistinct']} / {r['saved']} | {r['intendedOre']} / {r['savedOre']} | {r['imported']} / {r['duplicates']} / {r['rejected']} | {r['unmatchedStored']} | {r['downstreamCalls']} / {r['queueCalls']} | {r['syncErrors']} | {r['rowsWithAccount']} / {r['saved']} | {r['requirements']} |")
        (a.out/'falltabell.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='cases'},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
