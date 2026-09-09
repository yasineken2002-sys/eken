"""Construct small synthetic inputs and independent desired contracts BEFORE runs.

Never consumes production observations or any original 2,000-payment gold.
"""
import copy
import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[3] / 'docs/eval/bankimport-identitet'


def raw(amount=100, ocr='00123459', **changes):
    value = dict(bookingDate='2026-09-01T09:00:00Z', booked=True, currency='SEK',
                 amount=amount, description='SYNTETISK inbetalning')
    if ocr is not None:
        value['ocr'] = ocr
    value.update(changes)
    return value


def api(ext='external-1', org='test-org-A', **kw):
    return dict(kind='api', org=org, externalId=ext, raw=raw(**kw))


def file_step():
    return dict(kind='file', org='test-org-A', date='2026-09-01', amountOre=10000,
                description='SYNTETISK inbetalning', reference='00123459', rawOcr='00123459')


def main():
    inputs, gold = [], {}
    def add(k, steps, count, ore, **expected):
        inputs.append(dict(id=k, kind='ingest', steps=steps))
        gold[k]=dict(distinctEvents=count, amountOre=ore, **expected)
    add('I01-distinct-same-fields', [api('one'),api('two')],2,20000,
        imported=2,duplicates=0,rejected=0,downstreamCalls=2,
        contract='Different IDs identify different events in ONE stipulated synthetic namespace.')
    add('I02-exact-reimport', [api(),api()],1,10000,imported=1,duplicates=1,rejected=0,downstreamCalls=1)
    add('I03-distinct-without-ocr', [api('one',ocr=None),api('two',ocr=None)],2,20000,
        imported=2,duplicates=0,rejected=0,downstreamCalls=2)
    add('I04-organization-isolation', [api(org='test-org-A'),api(org='test-org-B')],2,20000,
        imported=2,duplicates=0,rejected=0,downstreamCalls=2,organizations=['test-org-A','test-org-B'])
    add('I05-changed-content', [api(ocr=None),api(ocr=None,amount=120)],1,10000,
        imported=1,downstreamCalls=1,requiresChangeSignal=True,
        contract='One event, changed reported amount: retain original 10000 ore pending EXPLICIT review; do not auto-update money.')
    add('I06-pending-then-booked', [api(booked=False),api()],1,10000,
        imported=1,duplicates=0,rejected=1,downstreamCalls=1)
    add('I07-explicit-negative-status', [api(),api(amount=-100)],1,10000,
        imported=1,duplicates=0,rejected=1,downstreamCalls=1,
        contract='Negative update explicitly rejected, no automatic reversal; further handling remains outside this test.')
    add('I08-reference-fallback', [api(ocr=None,reference='Referens 00123459')],1,10000,
        imported=1,rawOcr=['00123459'],references=['Referens 00123459'])
    add('I09-conflicting-references', [api(ocr='00123459',reference='00999999',description='SYNTETISK AVI-OTHER')],1,10000,
        imported=1,rawOcr=['00123459'],references=['00999999'],
        contract='Both original signals must reach the downstream observer; no matching/intent decision is tested.')
    add('I10-empty-ocr-with-reference', [api(ocr='',reference='00123459')],1,10000,
        imported=1,references=['00123459'],contract='Observe empty-ocr precedence separately; reference must remain stored.')
    add('I11-prose-is-not-intent', [api(ocr=None,description='Inbetalning 20260601')],1,10000,
        imported=1,rawOcr=[None])
    add('I12-same-id-different-providers', [api(ocr=None),api(ocr=None,amount=200)],2,30000,
        imported=2,duplicates=0,downstreamCalls=2,
        contract='HYPOTHETICAL provider-local ID namespace. API lacks provider argument; no verified real provider contract.',
        hypotheticalSources=[{'provider':'P','account':'A'},{'provider':'Q','account':'A'}])
    add('I13-matching-error-reimport', [dict(api(),downstream='throw'),api()],1,10000,
        imported=1,duplicates=1,downstreamCalls=1,queueCalls=0,
        contract='Saved import with explicit synthetic matchError; repeat does not run match again. Not complete payment handling.')
    add('I14-non-sek', [api(currency='EUR')],0,0,imported=0,duplicates=0,rejected=1,downstreamCalls=0)
    for order in ('file-api','api-file'):
        steps=[file_step(),api()]
        if order=='api-file':steps.reverse()
        for identity,count in [('same-event',1),('different-events',2)]:
            add('F-'+order+'-'+identity,copy.deepcopy(steps),count,count*10000,
                requiresSourceUncertainty=True,
                contract='Identical production arguments across same/different-event gold. No bank identity bridge exists; date/amount/OCR alone cannot decide.')

    def tx(ext, amount):
        return dict(externalId=ext,**raw(amount=amount,ocr=None))
    def sync(k,accounts,pages,rounds,count,ore,*,cursorContract,failOnce=None,orgs=None,requireAccount=True):
        inputs.append(dict(id=k,kind='sync',accounts=accounts,pages=pages,rounds=rounds,
                           failOnce=failOnce,organizations=orgs or ['test-org-A']))
        gold[k]=dict(distinctEvents=count,amountOre=ore,requireAccountContext=requireAccount,
                     contract=cursorContract)
    # Provider responses are functions of actual account/since, not ordered mock return values.
    pages={a:{'START':dict(transactions=[tx(a+'-1',100+i*100)],cursor=a+':1'),
              a+':1':dict(transactions=[tx(a+'-2',300+i*100)],cursor=a+':2'),
              a+':2':dict(transactions=[],cursor=a+':2')} for i,a in enumerate(['A','B'])}
    for accounts in (['A','B'],['B','A']):
        sync('S-account-cursors-'+''.join(accounts),accounts,pages,2,4,100000,
             cursorContract='HYPOTHETICAL strict per-account resumable cursor; two successful rounds cover four events.')
    shared={a:{'START':dict(transactions=[tx(a+'-1',100+i*100)],cursor='G1'),
               'G1':dict(transactions=[tx(a+'-2',300+i*100)],cursor='G2'),
               'G2':dict(transactions=[],cursor='G2')} for i,a in enumerate(['A','B'])}
    for accounts in (['A','B'],['B','A']):
        sync('S-shared-cursor-'+''.join(accounts),accounts,shared,3,4,100000,
             cursorContract='HYPOTHETICAL compatible consent-global cursor. Every account returns same watermark, empty third round; event counts should pass.')
    sync('S-account-local-id',['A','B'],{
        'A':{'START':dict(transactions=[tx('local-id',100)],cursor='G1')},
        'B':{'START':dict(transactions=[tx('local-id',200)],cursor='G1')}},1,2,30000,
        cursorContract='HYPOTHETICAL account-local IDs; same ID on two accounts denotes two events. Actual namespace unknown.')
    sync('S-two-accounts-equal-signals',['A','B'],{
        'A':{'START':dict(transactions=[dict(externalId='A-1',**raw())],cursor='G1')},
        'B':{'START':dict(transactions=[dict(externalId='B-1',**raw())],cursor='G1')}},1,2,20000,
        cursorContract='Stipulated globally distinct IDs, two accounts. No real provider claim.')
    for rounds in (1,3):
        sync('S-next-page-'+str(rounds)+'-rounds',['A'],{'A':pages['A']},rounds,2,40000,
             cursorContract='HYPOTHETICAL next-page token. A complete feed has two pages; observe one sync versus later scheduled syncs.')
    sync('S-empty-account-page',['A','B'],{
        'A':{'START':dict(transactions=[],cursor='A:empty'),
             'A:empty':dict(transactions=[tx('A-after-empty',100)],cursor='A:1')},
        'B':{'START':dict(transactions=[tx('B-1',200)],cursor='B:1'),
             'B:1':dict(transactions=[],cursor='B:1')}},2,2,30000,
        cursorContract='HYPOTHETICAL account cursor; empty first page advances only its own account.')
    retry={a:{'START':dict(transactions=[tx(a+'-1',100+i*100)],cursor='G1'),
              'G1':dict(transactions=[],cursor='G1')} for i,a in enumerate(['A','B'])}
    sync('S-failed-account-retry',['A','B'],retry,3,2,30000,failOnce='B',
         cursorContract='HYPOTHETICAL shared resumable cursor. B transport fails once; retry returns both first pages, final empty round.')
    sync('S-sync-organization-scope',['A'],{'A':{'START':dict(transactions=[tx('same-id',100)],cursor='G1')}},1,2,20000,
         orgs=['test-org-A','test-org-B'],cursorContract='Two stored consents in different orgs; each actual sync must see only its org.')
    assert len(inputs)==29 and len(gold)==29
    OUT.mkdir(parents=True,exist_ok=True)
    for name,data in [('indata.json',{'kind':'SYNTHETIC_OFFLINE_INPUTS','cases':inputs}),
                      ('facit.json',{'kind':'DESIRED_CONTRACT_NOT_OBSERVED_OUTPUT','sourceBase':'c6457aa00f027baa685d7e9b6ec28e8aa264c8e4','cases':gold})]:
        (OUT/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    print('Frozen 29 small cases; unchanged original 2,000 data never read.')


if __name__=='__main__':main()
