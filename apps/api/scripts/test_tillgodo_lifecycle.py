"""Independent lifecycle cases. DB proofs are invoked explicitly by the runner."""
from copy import deepcopy
from dataclasses import replace
import subprocess
import time
import unittest

from referensprov_policy import Bank, Notice, checksum
from tillgodo_lifecycle import Lifecycle, scope
from tillgodo_pg import call


def fixtures():
    base='0000000001'; ocr=base+checksum(base)
    n=Notice('n1','org','person','lease','Sara Svensson','AVI-2026-09-0001',ocr,
             2026,9,'2026-09-30','2026-09-01',10000)
    nxt=replace(n,id='n2',number='AVI-2026-10-0001',month=10,issued='2026-10-01',due='2026-10-31')
    bank=Bank('org','2026-09-25',12500,n.number+' Sara Svensson',ocr)
    return n,nxt,bank


class LifecycleTests(unittest.TestCase):
    def test_full_payment_recreates_larger_credit(self):
        n,nxt,b=fixtures(); m=Lifecycle((n,nxt)); m.issue_through(b.date); m.pay('p1',b)
        m.issue_through('2026-10-25'); m.pay('p2',replace(b,date='2026-10-25',text=nxt.number+' Sara Svensson'))
        self.assertEqual(m.issued['n2']['due'],7500)
        self.assertEqual(m.credits['credit:p1']['remaining'],0)
        self.assertEqual(m.credits['credit:p2']['remaining'],5000)

    def test_adjusted_payment_consumes_credit_without_creating_new(self):
        n,nxt,b=fixtures(); m=Lifecycle((n,nxt)); m.issue_through(b.date); m.pay('p1',b)
        m.issue_through('2026-10-25'); row=m.pay('p2',replace(b,date='2026-10-25',amount=7500,text=nxt.number))
        self.assertEqual(row['allocations'],{'n2':7500}); self.assertIsNone(row['credit'])
        self.assertEqual(sum(c['remaining'] for c in m.credits.values()),0)

    def test_full_rent_not_original_overpayment_still_creates_credit(self):
        n,nxt,b=fixtures(); m=Lifecycle((n,nxt)); m.issue_through(b.date); m.pay('p1',b)
        m.issue_through('2026-10-25'); m.pay('p2',replace(b,date='2026-10-25',amount=10000,text=nxt.number))
        self.assertEqual(m.credits['credit:p2']['remaining'],2500)

    def test_already_issued_never_adjusted_silently(self):
        n,nxt,b=fixtures(); nxt=replace(nxt,issued='2026-09-01')
        m=Lifecycle((n,nxt)); m.issue_through(b.date); m.pay('p1',b)
        self.assertIsNone(m.credits['credit:p1']['target']); self.assertEqual(m.issued['n2']['due'],10000)

    def test_missing_next_and_final_credit_remain_visible(self):
        n,_,b=fixtures(); m=Lifecycle((n,)); m.issue_through(b.date); m.pay('p1',b)
        self.assertEqual(m.credits['credit:p1']['remaining'],2500)
        self.assertIsNone(m.credits['credit:p1']['target'])

    def test_inactive_no_consent_or_refund_never_use_credit(self):
        for control in ({'active':False,'consent':True,'refund':False},
                        {'active':True,'consent':False,'refund':False},
                        {'active':True,'consent':True,'refund':True}):
            n,nxt,b=fixtures(); m=Lifecycle((n,nxt),{scope(n):control})
            m.issue_through(b.date); m.pay('p1',b); m.issue_through('2026-10-01')
            self.assertEqual(m.credits['credit:p1']['remaining'],2500)
            self.assertEqual(m.issued['n2']['due'],10000)

    def test_org_tenant_and_lease_boundaries(self):
        for changes in ({'org':'foreign'},{'tenant':'other'},{'lease':'garage'}):
            n,nxt,b=fixtures(); m=Lifecycle((n,replace(nxt,**changes)))
            m.issue_through(b.date); m.pay('p1',b); m.issue_through('2026-10-01')
            self.assertEqual(m.credits['credit:p1']['remaining'],2500)
            self.assertEqual(m.issued['n2']['due'],10000)

    def test_multiple_next_notices_are_ambiguous(self):
        n,nxt,b=fixtures(); m=Lifecycle((n,nxt,replace(nxt,id='duplicate')))
        m.issue_through(b.date); m.pay('p1',b); m.issue_through('2026-10-01')
        self.assertIsNone(m.credits['credit:p1']['target'])
        self.assertEqual(m.credits['credit:p1']['remaining'],2500)

    def test_multiple_contracts_same_person_choose_only_explicit_contract(self):
        n,nxt,b=fixtures(); garage=replace(nxt,id='garage',lease='garage',number='AVI-2026-10-0002')
        m=Lifecycle((n,nxt,garage)); m.issue_through(b.date); m.pay('p1',b); m.issue_through('2026-10-01')
        self.assertEqual(m.issued['n2']['due'],7500); self.assertEqual(m.issued['garage']['due'],10000)

    def test_conflicting_reference_even_with_paid_owner(self):
        n,nxt,b=fixtures(); base='0000000002'; other=replace(n,id='other',tenant='other',lease='other',
            name='Anna Andersson',number='AVI-2026-09-0002',ocr=base+checksum(base),debt=0)
        m=Lifecycle((n,nxt,other)); m.issue_through(b.date)
        row=m.pay('conflict',replace(b,reference=other.ocr))
        self.assertEqual(row['reason'],'IDENTITETSKONFLIKT'); self.assertFalse(m.credits)

    def test_reimport_is_inert_and_changed_payload_rejected(self):
        n,nxt,b=fixtures(); m=Lifecycle((n,nxt)); m.issue_through(b.date); m.pay('p1',b)
        before=deepcopy(m.snapshot()); m.pay('p1',b); self.assertEqual(m.snapshot(),before)
        with self.assertRaises(ValueError):m.pay('p1',replace(b,amount=12501))


def run_database_proofs(pg, prefix='exp_proof'):
    results=[]; seq=0
    def setup(control=None):
        nonlocal seq
        seq+=1; schema=f'{prefix}_{seq}'
        n,nxt,b=fixtures(); m=Lifecycle((n,nxt),{scope(n):control} if control else None)
        pg.setup(schema,(n,nxt),m.controls); m.issue('n1'); pg.execute(schema,m.operations)
        m.pay('p1',b); payment=m.operations[-1]
        return schema,m,payment
    def assert_failure(schema,operation,error,point=''):
        before=pg.snapshot(schema)
        message=pg.sql(call(operation,point),schema,expect_error=error)
        assert pg.snapshot(schema)==before
        return message.splitlines()[0]
    for point in ('after_debt','after_credit','after_bank_voucher'):
        schema,m,payment=setup()
        error=assert_failure(schema,payment,'INJECTED_'+point,point)
        assert pg.execute(schema,[payment])==['APPLIED']
        before=pg.snapshot(schema); assert pg.execute(schema,[payment])==['DUPLICATE']; assert pg.snapshot(schema)==before
        assert before['credit'][0]['remaining']==2500 and len(before['allocation'])==1 and len(before['voucher'])==2
        results.append({'test':'payment_rollback_'+point,'passed':True,'error':error})
    for point in ('after_debt','after_credit','after_use_voucher'):
        schema,m,payment=setup(); pg.execute(schema,[payment]); m.issue('n2'); issuance=m.operations[-1]
        error=assert_failure(schema,issuance,'INJECTED_'+point,point)
        assert pg.execute(schema,[issuance])==['APPLIED']
        before=pg.snapshot(schema); assert pg.execute(schema,[issuance])==['DUPLICATE']; assert pg.snapshot(schema)==before
        assert before['credit'][0]['remaining']==0 and len(before['credit_use'])==1 and len(before['voucher'])==4
        results.append({'test':'use_rollback_'+point,'passed':True,'error':error})
    for control in ({'active':False,'consent':True,'refund':False},
                    {'active':True,'consent':False,'refund':False},
                    {'active':True,'consent':True,'refund':True}):
        schema,m,payment=setup(control); pg.execute(schema,[payment]); m.issue('n2'); issuance=m.operations[-1]
        forced=deepcopy(issuance); forced['uses']=[{'credit':'credit:p1','amount':2500}]
        error=assert_failure(schema,forced,'NO_USE_PERMISSION')
        pg.execute(schema,[issuance]); snap=pg.snapshot(schema)
        assert snap['credit'][0]['remaining']==2500 and not snap['credit_use']
        results.append({'test':'permission_'+str(control),'passed':True,'error':error})
    for field in ('org','tenant','lease'):
        schema,m,payment=setup(); pg.execute(schema,[payment]); n=m.original['n2']
        foreign=replace(n,id='foreign',**{field:'foreign'})
        pg.sql('INSERT INTO scope VALUES(\''+foreign.org+'\',\''+foreign.tenant+'\',\''+foreign.lease+'\',true,true,false) ON CONFLICT DO NOTHING;\n'+pg.notice_insert(foreign),schema)
        op={'kind':'ISSUE','id':'foreign-issue','org':foreign.org,'notice':'foreign','date':foreign.issued,
            'uses':[{'credit':'credit:p1','amount':2500}]}
        error=assert_failure(schema,op,'query returned no rows' if field=='org' else 'WRONG_CREDIT_SCOPE_OR_TARGET')
        results.append({'test':'cross_'+field,'passed':True,'error':error})
    schema,m,payment=setup(); pg.execute(schema,[payment]); m.issue('n2'); issuance=m.operations[-1]
    # Actual concurrent sessions. First transaction holds row lock during pg_sleep;
    # second must wait, then fail after the first commits. Observer proves blocking.
    cmd1=pg.command('credit-worker-1'); cmd2=pg.command('credit-worker-2')
    one=subprocess.Popen(cmd1,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    one.stdin.write(f'SET search_path TO {schema},pg_catalog;\n'+call(issuance,pause=3000)); one.stdin.close(); one.stdin=None
    for _ in range(100):
        sleeping=pg.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='credit-worker-1' AND wait_event='PgSleep';")
        if sleeping=='1':break
        time.sleep(.01)
    assert sleeping=='1','first transaction did not reach hold point'
    competing=deepcopy(issuance); competing['id']='competing-issue'
    two=subprocess.Popen(cmd2,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    two.stdin.write(f'SET search_path TO {schema},pg_catalog;\n'+call(competing)); two.stdin.close(); two.stdin=None
    blocked=False
    for _ in range(100):
        blocked=pg.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='credit-worker-2' AND wait_event_type='Lock';")=='1'
        if blocked:break
        time.sleep(.01)
    out1,err1=one.communicate(timeout=15); out2,err2=two.communicate(timeout=15)
    assert blocked and one.returncode==0 and out1.strip()=='APPLIED',(out1,err1,blocked)
    assert two.returncode!=0 and 'ALREADY_ISSUED' in err2,(out2,err2)
    snap=pg.snapshot(schema); assert len(snap['credit_use'])==1 and snap['credit'][0]['remaining']==0
    results.append({'test':'concurrent_credit_use','passed':True,'observedPostgresLockWait':blocked,
                    'committedUses':1,'loserError':err2.splitlines()[0]})
    before=pg.snapshot(schema)
    assert_failure(schema,dict(issuance,id='issued-again'),'ALREADY_ISSUED')
    assert_failure(schema,dict(payment,bank={**payment['bank'],'amount':12501}),'OPERATION_PAYLOAD_CONFLICT')
    results.append({'test':'already_issued_and_changed_reimport','passed':True})
    reverse_bank={'kind':'REVERSE_BANK','id':'reverse-bank-p1','org':'org','event':'p1'}
    assert_failure(schema,reverse_bank,'CREDIT_ALREADY_USED')
    use_id=snap['credit_use'][0]['id']
    reverse_use={'kind':'REVERSE_USE','id':'reverse-use-p1','org':'org','use':use_id}
    assert_failure(schema,reverse_use,'INJECTED_after_debt','after_debt')
    pg.execute(schema,[reverse_use]); reversed_use=pg.snapshot(schema)
    n2=next(n for n in reversed_use['notice'] if n['id']=='n2')
    assert n2['debt']==10000 and n2['display_due']==7500 and n2['amendment_required']
    assert reversed_use['credit'][0]['remaining']==2500 and reversed_use['credit'][0]['held']
    assert pg.execute(schema,[reverse_use])==['DUPLICATE']
    assert_failure(schema,dict(reverse_use,id='another-reverse'),'ALREADY_REVERSED')
    pg.execute(schema,[reverse_bank]); final=pg.snapshot(schema)
    assert final['credit'][0]['remaining']==0 and final['credit'][0]['reversed']
    assert next(n for n in final['notice'] if n['id']=='n1')['debt']==10000
    assert pg.execute(schema,[reverse_bank])==['DUPLICATE']
    assert pg.snapshot(schema)==final
    for account in ('TEST_BANK','TEST_CREDIT'):
        assert sum(d-c for v in final['voucher'] for a,d,c in v['lines'] if a==account)==0
    results.append({'test':'reverse_use_then_bank_and_repeated_reversal','passed':True,'finalSnapshot':final})
    assert_failure(schema,dict(reverse_bank,id='reverse-bank-again'),'ALREADY_REVERSED')
    pg.sql("SELECT book('org','bad-voucher','[[\"TEST_BANK\",100,0],[\"TEST_CREDIT\",0,99]]'::jsonb);",schema,expect_error='UNBALANCED_VOUCHER')
    assert pg.snapshot(schema)==final
    results.append({'test':'unbalanced_voucher_rejected','passed':True})
    schema,m,payment=setup(); pg.execute(schema,[payment]); m.issue('n2'); pg.execute(schema,[m.operations[-1]])
    b=fixtures()[2]; m.pay('p2',replace(b,date='2026-10-25',amount=7500,text=m.original['n2'].number))
    pg.execute(schema,[m.operations[-1]])
    uid=pg.snapshot(schema)['credit_use'][0]['id']
    assert_failure(schema,{'kind':'REVERSE_USE','id':'reverse-paid-target','org':'org','use':uid},'TARGET_HAS_BANK_PAYMENT')
    results.append({'test':'reverse_use_after_target_bank_payment_rejected','passed':True})
    schema,m,payment=setup(); pg.execute(schema,[payment])
    pg.sql("UPDATE scope SET refund=true WHERE org='org' AND tenant='person' AND lease='lease';",schema)
    m.issue('n2'); assert_failure(schema,m.operations[-1],'NO_USE_PERMISSION')
    assert pg.snapshot(schema)['credit'][0]['remaining']==2500
    results.append({'test':'refund_requested_after_credit_creation_holds_funds','passed':True})
    schema,m,payment=setup(); pg.execute(schema,[payment]); m.issue('n2'); pg.execute(schema,[m.operations[-1]])
    b=fixtures()[2]; m.pay('p2',replace(b,date='2026-10-25',amount=10000,text=m.original['n2'].number))
    pg.execute(schema,[m.operations[-1]]); snap=pg.snapshot(schema)
    assert len(snap['credit'])==2 and {c['bank_event'] for c in snap['credit']}=={'p1','p2'}
    assert all(c['total']==2500 for c in snap['credit']) and sum(c['remaining'] for c in snap['credit'])==2500
    results.append({'test':'two_legitimate_equal_credit_amounts_keep_distinct_origins','passed':True})
    return results


if __name__=='__main__':unittest.main(verbosity=2)
