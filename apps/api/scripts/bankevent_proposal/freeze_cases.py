"""Independent synthetic expectations, frozen before the SQL candidate runs."""
import copy
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4]
OUT=ROOT/'docs/eval/bankhandelse-forslag'


def delivery(ext='E1',org='org-A',account='A',kind='api',provider='P',consent='C',amount=10000,**body):
    return {'org':org,'origin':{'kind':kind,'provider':provider,'consent':consent,'account':account},
            'externalId':ext,'body':{'amountOre':amount,'day':'2026-09-10','booked':True,'currency':'SEK',
               'rawOcr':'00123459','reference':None,'description':'SYNTETISK',**body}}


def main():
    cases=[];gold={}
    def add(k,steps,new,ore,markers,*,mode='normal',legacy=False,bridge=False,cutover=False,held=0,open_state=False,**extra):
        cases.append(dict(id=k,steps=steps,mode=mode,legacy=legacy,bridge=bridge,cutover=cutover))
        gold[k]=dict(newPayments=new,newPaymentOre=ore,dispatchMarkers=markers,held=held,openIdentity=open_state,**extra)
    add('01-two-equal-events',[delivery('E1'),delivery('E2')],2,20000,2)
    add('02-exact-reimport',[delivery(),delivery()],1,10000,1)
    add('03-concurrent-reimport',[delivery(),delivery()],1,10000,1,mode='concurrent')
    add('04-concurrent-distinct',[delivery('E1'),delivery('E2')],2,20000,2,mode='concurrent')
    add('05-account-local-id',[delivery(),delivery(account='B',amount=20000)],2,30000,2)
    add('06-organization-isolation',[delivery(),delivery(org='org-B')],2,20000,2)
    add('07-verified-provider-bridge',[delivery(),delivery(provider='Q',consent='CQ')],1,10000,1)
    add('08-unbound-new-consent',[delivery(),delivery(consent='NEW')],1,10000,1,held=1,open_state=True)
    forged=delivery(consent='NEW');forged['origin'].update(scopeId='scope-A',verified=True)
    add('09-client-asserted-proof',[forged],0,0,0,held=1,open_state=True)
    for order in ['api-file','file-api']:
        a,b=delivery(),delivery(kind='file',provider='UNBOUND')
        steps=[a,b] if order=='api-file' else [b,a]
        add('10-unproven-'+order,steps,1,10000,1,held=1,open_state=True,
            identityAmbiguity='May be same or different physical event; observation sum is not money total.')
        a,b=delivery(),delivery(kind='file')
        add('11-proven-same-'+order,[a,b] if order=='api-file' else [b,a],1,10000,1)
        b['externalId']='E2'
        add('12-proven-distinct-'+order,[a,b] if order=='api-file' else [b,a],2,20000,2)
    add('13-no-source-proof',[delivery(provider='UNBOUND')],0,0,0,held=1,open_state=True)
    add('14-legacy-unproven',[delivery()],0,0,0,legacy=True,held=1,open_state=True)
    add('15-legacy-verified-link',[delivery(),delivery()],0,0,0,legacy=True,bridge=True)
    add('16-verified-transition',[delivery('NEW-EVENT')],1,10000,1,legacy=True,cutover=True)
    add('17-before-transition',[delivery(day='2026-09-09')],0,0,0,legacy=True,cutover=True,held=1,open_state=True)
    add('18-changed-content',[delivery(),delivery(amount=12000)],1,10000,1,held=1,open_state=True)
    add('19-conflict-before-claim',[delivery(),delivery(amount=12000)],1,10000,0,mode='defer',held=1,open_state=True)
    add('20-status-conflict',[delivery(),delivery(booked=False),delivery(amount=-10000)],1,10000,1,held=2,open_state=True)
    add('21-rollback-save',[delivery(),delivery()],1,10000,1,mode='rollback_save',committedObservations=1)
    add('22-crash-before-claim',[delivery(),delivery()],1,10000,1,mode='crash_pending')
    add('23-crash-before-effect',[delivery(),delivery()],1,10000,0,mode='crash_started',open_state=True)
    add('24-crash-after-effect',[delivery(),delivery()],1,10000,1,mode='crash_effect',open_state=True)
    add('25-wrong-claim-org',[delivery()],1,10000,0,mode='wrong_org',open_state=True)
    add('26-wrong-finish-token',[delivery()],1,10000,1,mode='wrong_token')
    add('27-old-ocr-amount-passthrough',[delivery('PART-1',amount=4000,rawOcr='1234'),delivery('PART-2',amount=6000,rawOcr='1234')],2,10000,2,
        limitation='Only preservation of reference and payment amounts, no invoice allocation/partial/waterfall algorithm is executed.')
    add('28-noneligible-recorded',[delivery(booked=False),delivery('EUR',currency='EUR'),delivery('ZERO',amount=0)],0,0,0,rejected=3)
    assert len(cases)==31 and len(gold)==31
    for name,obj in [('indata.json',{'kind':'NEW_SYNTHETIC_SQL_COMPONENT_INPUT_NOT_874_REPLAY','cases':cases}),
                     ('facit.json',{'kind':'PREDEFINED_REQUIREMENTS_NOT_OBSERVED','cases':gold})]:
        target=OUT/name;assert not target.exists();target.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
