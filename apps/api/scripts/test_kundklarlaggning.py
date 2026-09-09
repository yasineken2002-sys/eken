"""Real isolated PostgreSQL and loopback HTTP controls; no external services."""
import copy
import http.client
import json
import subprocess
import threading
import time
import unittest
from datetime import timedelta

from audit_kundklarlaggning import audit, negative_controls
from demo_kundklarlaggning import Demo
from kundklarlaggning import (Denied, FIXED, ORG, POLICY, PRINCIPALS, Postgres, Service,
                            answer, b_inputs, originals, run_scenarios)


class FlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg = Postgres()
        try:
            cls.pg.start()
        except BaseException:
            cls.pg.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.pg.close()

    def setUp(self):
        self.s = Service(self.pg, FIXED).bootstrap()

    def tearDown(self):
        # Only this test's newly generated schema, inside our verified container.
        self.pg.sql('DROP SCHEMA '+self.s.schema+' CASCADE;')

    def ready(self, k='B-full'):
        self.assertEqual(self.s.route(k), 'DRAFT')
        self.assertEqual(self.s.capture(k), 'WAITING')
        return self.s.tokens[ORG,k]

    def reply(self, k='B-full', request='request-1', payload=None, **kw):
        return self.s.reply(k, self.s.tokens[ORG,k], request, payload or answer(k), **kw)

    def denied(self, fn):
        before = self.s.snapshot()
        with self.assertRaises((Denied, RuntimeError)):
            fn()
        self.assertEqual(before, self.s.snapshot(), 'Rejected request changed database')

    def test_frozen_A_B_and_independent_recount(self):
        run_scenarios(self.s)
        report = {'snapshot': self.s.snapshot(), 'whole2000Replay':False,
                  'separateHistoricalCredit':json.loads(POLICY.read_text())['originalMetricsRemainHistorical']}
        result = audit(report)
        self.assertEqual(result['B']['resolvedWithCustomer'], 3)
        self.assertEqual(result['A']['staffRequired'], 20)
        self.assertEqual(len(negative_controls(report)), 14)

    def test_originals_no_recipient_no_customer_disclosure(self):
        for k in originals():
            self.assertEqual(self.s.route(k), 'STAFF_NO_RECIPIENT')
            self.denied(lambda:self.s.customer(k,self.s.tokens[ORG,k],PRINCIPALS['alice']))
        snap=self.s.snapshot()
        self.assertEqual(snap['cf_invitation'],[]); self.assertEqual(snap['cf_outbox'],[])
        self.assertEqual(snap['bank'],[])

    def test_wrong_person_organization_case_and_payment(self):
        token=self.ready()
        for actor in (PRINCIPALS['bob'],PRINCIPALS['other-org'],PRINCIPALS['staff']):
            with self.subTest(actor=actor):
                self.denied(lambda:self.s.customer('B-full',token,actor))
                self.denied(lambda:self.reply(actor=actor))
        self.denied(lambda:self.s.reply('B-partial',token,'r',answer('B-partial')))
        p=answer('B-full');p['payment']='B-partial'
        self.denied(lambda:self.reply(payload=p))

    def test_customer_projection_and_staff_role(self):
        token=self.ready('B-conflict')
        view=self.s.customer('B-conflict',token,PRINCIPALS['alice'])
        self.assertNotIn('FOREIGN-CONFLICT',json.dumps(view))
        self.assertNotIn('Annan syntetisk kund',json.dumps(view))
        self.assertFalse(any('foreign' in n['id'] for n in view['notices']))
        self.assertEqual(self.s.mailbox(PRINCIPALS['bob']),[])
        for actor in (PRINCIPALS['alice'],PRINCIPALS['bob'],('other-org','staff','staff')):
            self.denied(lambda:self.s.staff(actor))
            self.denied(lambda:self.s.capture('B-conflict',actor))

    def test_invoice_other_customer_unknown_or_wrong_contract(self):
        self.ready()
        for invoice in ('B-full-foreign','does-not-exist','B-partial-avi-1'):
            p=answer('B-full');p['allocations']={invoice:10000}
            self.denied(lambda:self.reply(payload=p))

    def test_explicit_choice_own_other_contract_and_no_cross_contract_transfer(self):
        self.ready();p=answer('B-full');p['allocations']={'B-full-garage':10000}
        self.assertEqual(self.reply(payload=p)['status'],'RESOLVED_CUSTOMER')
        self.assertEqual(self.s.sql("SELECT debt FROM notice WHERE id='B-full-avi-1';"),'10000')
        self.ready('B-partial');p=answer('B-partial');p['allocations']={'B-partial-avi-1':2000,'B-partial-garage':2000}
        self.assertEqual(self.reply('B-partial',payload=p)['status'],'STAFF_MULTIPLE_LEASES')
        self.assertEqual(len(self.s.snapshot()['bank']),1)

    def test_forged_and_missing_authority_no_links(self):
        for k in ('B-forged','B-no-authority'):
            self.assertEqual(self.s.route(k),'STAFF_NO_RECIPIENT')
        self.assertEqual(self.s.snapshot()['cf_invitation'],[])
        self.ready();p=answer('B-full');p['verified']=True;p['receipt']='self-uploaded'
        self.denied(lambda:self.reply(payload=p))

    def test_attestation_binding_mismatch_and_revocation(self):
        self.s.sql("UPDATE cf_attestation SET event='B-partial' WHERE id='proof:B-full';")
        self.assertEqual(self.s.route('B-full'),'STAFF_NO_RECIPIENT')
        token=self.ready('B-partial')
        self.s.sql("UPDATE cf_attestation SET revoked=true WHERE id='proof:B-partial';")
        self.denied(lambda:self.s.customer('B-partial',token,PRINCIPALS['alice']))
        self.assertEqual(self.reply('B-partial')['status'],'STAFF_EVIDENCE_INVALID')
        self.assertEqual(self.s.snapshot()['bank'],[])

    def test_recipient_removed_and_bank_payload_mismatch(self):
        self.s.sql("UPDATE cf_attestation SET bank=jsonb_set(bank,'{amount}','99') WHERE id='proof:B-full';")
        self.assertEqual(self.s.route('B-full'),'STAFF_NO_RECIPIENT')
        self.ready('B-partial');self.s.sql("UPDATE cf_person SET contact_verified=false WHERE org='syntetisk' AND id='alice';")
        self.assertEqual(self.s.mailbox(PRINCIPALS['alice']),[])
        self.assertEqual(self.reply('B-partial')['status'],'STAFF_EVIDENCE_INVALID')

    def test_changed_attestation_person_scope_and_draft_invalidates_old_link(self):
        for k, change in [('B-full',"person='bob',tenant='bob-tenant'"),
                          ('B-partial',"leases=ARRAY['B-partial-garage']")]:
            token = self.ready(k)
            self.s.sql(f"UPDATE cf_attestation SET {change} WHERE id='proof:{k}';")
            self.denied(lambda:self.s.customer(k,token,PRINCIPALS['alice']))
            self.assertNotIn(k,[r['payment'] for r in self.s.mailbox(PRINCIPALS['alice'])])
            p=answer(k);p['action']='decline'
            self.assertEqual(self.reply(k,payload=p)['status'],'STAFF_EVIDENCE_INVALID')
        self.s.route('B-draft')
        self.s.sql("UPDATE cf_attestation SET person='bob',tenant='bob-tenant' WHERE id='proof:B-draft';")
        self.denied(lambda:self.s.capture('B-draft'))
        self.assertEqual(self.s.snapshot()['bank'],[])

    def test_reference_conflict_customer_cannot_override(self):
        self.ready('B-conflict')
        self.assertEqual(self.reply('B-conflict')['status'],'STAFF_CONFLICT')
        self.assertEqual(self.s.snapshot()['bank'],[])
        self.assertTrue(next(c for c in self.s.snapshot()['cf_case'] if c['id']=='B-conflict')['conflict'])

    def test_decline_and_contradictory_reply(self):
        for k, action, claim, status in [('B-decline','decline','not-mine','STAFF_DECLINED'),
                ('B-contradictory','confirm','not-mine','STAFF_CONTRADICTORY')]:
            self.ready(k);p=answer(k);p.update(action=action,claim=claim)
            self.assertEqual(self.reply(k,payload=p)['status'],status)
        self.assertEqual(self.s.snapshot()['bank'],[])

    def test_expired_reused_and_exact_retry(self):
        token=self.ready();before=self.reply();snap=self.s.snapshot()
        self.assertEqual(before,self.reply());self.assertEqual(snap,self.s.snapshot())
        self.denied(lambda:self.reply(request='new-key'))
        p=answer('B-full');p['note']='changed'
        self.denied(lambda:self.reply(payload=p))
        self.denied(lambda:self.s.customer('B-full',token,PRINCIPALS['alice']))
        self.ready('B-partial');self.s.moment+=timedelta(minutes=31)
        self.denied(lambda:self.reply('B-partial'))
        self.assertEqual(self.s.expire(),1)

    def test_debt_changed_and_changed_back(self):
        for k,restore in [('B-full',False),('B-partial',True)]:
            self.ready(k)
            self.s.sql(f"UPDATE notice SET debt=9999 WHERE id='{k}-avi-1';")
            if restore:self.s.sql(f"UPDATE notice SET debt=10000 WHERE id='{k}-avi-1';")
            self.assertEqual(self.reply(k)['status'],'STAFF_DEBT_CHANGED')
        self.assertEqual(self.s.snapshot()['bank'],[])

    def test_inactive_lease_and_unissued_notice(self):
        self.ready()
        self.s.sql("UPDATE scope SET active=false WHERE lease='B-full-home';")
        self.denied(lambda:self.reply())
        self.ready('B-partial');self.s.sql("UPDATE notice SET issued=false WHERE id='B-partial-avi-1';")
        self.denied(lambda:self.reply('B-partial'))

    def test_partial_combined_and_outstanding_credit(self):
        for k in ('B-partial','B-combined','B-credit'):
            self.ready(k);self.reply(k)
        snap=self.s.snapshot()
        self.assertEqual(len(snap['allocation']),4)
        self.assertEqual(snap['credit'][0]['remaining'],2500)
        self.assertIsNone(snap['credit'][0]['target'])
        self.assertEqual(self.s.sql("SELECT debt FROM notice WHERE id='B-partial-avi-1';"),'6000')
        credits=self.s.customer_credits(PRINCIPALS['alice'])
        self.assertEqual(len(credits),1);self.assertEqual(credits[0]['remainingOre'],2500)
        self.assertEqual(self.s.customer_credits(PRINCIPALS['bob']),[])
        self.assertEqual(self.s.customer_credits(PRINCIPALS['other-org']),[])

    def test_integer_amounts_unexplained_remainder_and_untrusted_note(self):
        self.ready()
        for value in (True,0,-1,0.5,'10000',10**13,10001):
            p=answer('B-full');p['allocations']['B-full-avi-1']=value
            self.denied(lambda:self.reply(payload=p))
        self.ready('B-credit');p=answer('B-credit');p['retainCredit']=False
        self.assertEqual(self.reply('B-credit',payload=p)['status'],'STAFF_AMOUNT_UNEXPLAINED')
        p=answer('B-full');p['note']='<script>self claimed verification</script>'
        self.assertEqual(self.reply(payload=p)['status'],'STAFF_CUSTOMER_NOTE')

    def test_free_comment_may_contradict_even_structured_confirmation(self):
        self.ready()
        p=answer('B-full');p['note']='Min mamma betalade. Hon säger att pengarna gäller min brors hyra.'
        self.assertEqual(self.reply(payload=p)['status'],'STAFF_CUSTOMER_NOTE')
        self.assertEqual(self.s.snapshot()['bank'],[])
        self.ready('B-partial');p=answer('B-partial');p.update(action='decline',allocations={},note='Fel betalning')
        self.assertEqual(self.reply('B-partial',payload=p)['status'],'STAFF_DECLINED')

    def test_expiry_worker_retries_transient_transport_failure(self):
        self.ready();self.s.moment+=timedelta(minutes=31)
        original=self.s.expire
        attempts=[]
        def flaky():
            attempts.append(1)
            if len(attempts)==1:raise RuntimeError('INJECTED_LOCAL_TRANSPORT_FAILURE')
            return original()
        self.s.expire=flaky
        server=Demo(self.s,0);stop=threading.Event()
        thread=threading.Thread(target=server.run_expiry,args=(stop,.01));thread.start()
        try:
            until=time.monotonic()+5
            while server.expiry_health['status']!='OK' and time.monotonic()<until:time.sleep(.02)
            self.assertEqual(server.expiry_health,{'status':'OK','errors':1})
            self.assertGreaterEqual(len(attempts),2)
            self.assertEqual(self.s.sql("SELECT status FROM cf_case WHERE id='B-full';"),'STAFF_TIMEOUT')
            self.assertEqual(self.s.snapshot()['bank'],[])
        finally:stop.set();thread.join();server.server_close()

    def test_reimport_does_not_reset_link_or_duplicate_credit(self):
        self.ready('B-credit');self.reply('B-credit');snap=self.s.snapshot()
        self.s.import_case('B-credit',b_inputs()['B-credit'],'proof:B-credit',False)
        self.assertEqual(snap,self.s.snapshot())
        bank=copy.deepcopy(b_inputs()['B-credit']);bank['amount']+=1
        self.denied(lambda:self.s.import_case('B-credit',bank,'proof:B-credit',False))
        self.denied(lambda:self.s.import_case('B-credit',b_inputs()['B-credit'],None,False))

    def test_atomic_rollback_at_five_boundaries_then_retry(self):
        self.ready('B-credit')
        for point in ('after_debt','after_credit','after_bank_voucher','after_case','after_audit_and_link'):
            with self.subTest(point=point):
                before=self.s.snapshot()
                with self.assertRaisesRegex(RuntimeError,'INJECTED_'+point):
                    self.reply('B-credit',failpoint=point)
                self.assertEqual(before,self.s.snapshot())
        self.assertEqual(self.reply('B-credit')['status'],'STAFF_CREDIT')
        snap=self.s.snapshot();self.assertEqual(len(snap['credit']),1);self.assertEqual(len(snap['bank']),1)
        self.assertTrue(next(i for i in snap['cf_invitation'] if i['event']=='B-credit')['consumed'])

    def test_real_concurrent_duplicate_and_different_request_lock(self):
        for k,same in [('B-full',True),('B-credit',False)]:
            token=self.ready(k)
            first=subprocess.Popen(self.pg.command('cf-first'),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            first.stdin.write('SET search_path TO '+self.s.schema+',pg_catalog;\n'+self.s.reply_sql(k,token,'one',answer(k),pause=3000))
            first.stdin.close();first.stdin=None
            def observed(query):
                until=time.monotonic()+6
                while time.monotonic()<until:
                    if self.s.sql(query)=='1':return True
                    time.sleep(.05)
                return False
            self.assertTrue(observed("SELECT count(*) FROM pg_stat_activity WHERE application_name='cf-first' AND wait_event='PgSleep';"))
            second=subprocess.Popen(self.pg.command('cf-second'),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            second.stdin.write('SET search_path TO '+self.s.schema+',pg_catalog;\n'+self.s.reply_sql(k,token,'one' if same else 'two',answer(k)))
            second.stdin.close();second.stdin=None
            self.assertTrue(observed("SELECT count(*) FROM pg_stat_activity WHERE application_name='cf-second' AND wait_event_type='Lock';"))
            out1,err1=first.communicate(timeout=10);out2,err2=second.communicate(timeout=10)
            self.assertEqual(first.returncode,0,err1)
            if same:self.assertEqual((second.returncode,out2),(0,out1),err2)
            else:self.assertNotEqual(second.returncode,0);self.assertIn('CF_DENIED',err2)
        self.assertEqual(len(self.s.snapshot()['bank']),2)
        self.assertEqual(len(self.s.snapshot()['credit']),1)

    def test_no_response_and_draft_are_unresolved(self):
        self.ready('B-no-response');self.s.route('B-draft')
        self.assertEqual(self.s.expire(),0)
        self.assertEqual(self.s.snapshot()['bank'],[])
        self.assertEqual(self.s.sql("SELECT status FROM cf_case WHERE id='B-no-response';"),'WAITING')
        self.assertEqual(self.s.sql("SELECT status FROM cf_case WHERE id='B-draft';"),'DRAFT')

    def test_audit_cannot_be_mutated(self):
        self.ready()
        self.denied(lambda:self.s.sql('DELETE FROM cf_audit;'))

    def test_http_auth_csrf_origin_private_projection_and_reply(self):
        token=self.ready('B-conflict');self.ready()
        server=Demo(self.s,0);thread=threading.Thread(target=server.serve_forever);thread.start()
        cookie='';csrf=''
        def request(path,data=None,extra=None,raw=None):
            c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=10)
            headers={'Cookie':cookie,'Origin':server.origin,'Content-Type':'application/json','X-CSRF-Token':csrf}
            headers.update(extra or {})
            payload=raw if raw is not None else json.dumps(data) if data is not None else None
            c.request('POST' if payload is not None else 'GET',path,payload,headers)
            r=c.getresponse();body=r.read();result=(r.status,dict(r.getheaders()),body);c.close();return result
        try:
            self.assertEqual(request('/api/staff')[0],403)
            for path in ('/','/style.css','/app.js'):
                code,headers,body=request(path);self.assertEqual(code,200);self.assertTrue(body)
                self.assertEqual(headers['Cache-Control'],'no-store')
            self.assertEqual(request('/api/demo-login',{'key':'forged','persona':'alice'})[0],403)
            code,headers,_=request('/api/demo-login',{'key':server.boot_key,'persona':'alice'})
            self.assertEqual(code,200);cookie=headers['Set-Cookie'].split(';')[0]
            self.assertIn('HttpOnly',headers['Set-Cookie']);self.assertIn('SameSite=Strict',headers['Set-Cookie'])
            csrf=json.loads(request('/api/me')[2])['csrf']
            self.assertEqual(request('/api/staff')[0],403)
            self.assertEqual(request('/api/capture',{'case':'B-conflict'})[0],403)
            code,_,body=request('/api/customer?case=B-conflict&token='+token)
            self.assertEqual(code,200);self.assertNotIn(b'FOREIGN-CONFLICT',body);self.assertNotIn(b'foreign',body)
            self.assertEqual(request('/api/customer?case=betalning-56-0&token='+token)[0],403)
            p={'case':'B-full','token':self.s.tokens[ORG,'B-full'],'request':'http-request','answer':answer('B-full')}
            for headers in ({'Origin':'https://evil.example'},{'X-CSRF-Token':'wrong'},{'Host':'evil.example'}):
                self.assertEqual(request('/api/reply',p,headers)[0],403)
            self.assertEqual(request('/api/reply',raw='{"case":"B-full","case":"B-partial"}')[0],403)
            self.assertEqual(request('/api/attestation',{'verified':True})[0],403)
            first=request('/api/reply',p);self.assertEqual(first[0],200)
            self.assertEqual(json.loads(first[2])['status'],'RESOLVED_CUSTOMER')
            self.assertEqual(request('/api/reply',p)[2],first[2])
            self.ready('B-credit')
            credit_reply={'case':'B-credit','token':self.s.tokens[ORG,'B-credit'],'request':'http-credit','answer':answer('B-credit')}
            self.assertEqual(json.loads(request('/api/reply',credit_reply)[2])['status'],'STAFF_CREDIT')
            self.assertEqual(json.loads(request('/api/credits')[2])[0]['remainingOre'],2500)
            code,headers,_=request('/api/demo-login',{'key':server.boot_key,'persona':'bob'});cookie=headers['Set-Cookie'].split(';')[0]
            self.assertEqual(json.loads(request('/api/mailbox')[2]),[])
            self.assertEqual(json.loads(request('/api/credits')[2]),[])
            denied=request('/api/customer?case=B-conflict&token='+token)
            self.assertEqual(denied[0],403);self.assertNotIn(b'B-conflict',denied[2])
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main(verbosity=2)
