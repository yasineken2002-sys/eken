"""Independent read-only evidence audit, without importing the prototype/matcher.

Recreate OUTPUT_DIRECTORY with eval_referensprov_credit.py first. The optional
previous run compares economic state across metadata-only report changes.
Assertion count counts invariants over repeated rows, not unique customer cases.
Only Python standard library; SQLite files are opened read-only and immutable.
"""
from pathlib import Path
from collections import defaultdict,Counter
from datetime import datetime,timezone
from decimal import Decimal
import sqlite3,json,gzip,hashlib,sys
root=Path(__file__).resolve().parents[3]
if len(sys.argv) not in (2,3):
 raise SystemExit('Usage: audit_referensprov_credit.py OUTPUT_DIRECTORY [PREVIOUS_OUTPUT_DIRECTORY]')
out=Path(sys.argv[1]);src=root/'docs/eval/kundflode-2000';rep=json.loads((out/'resultat.json').read_text());counts=Counter()
def ck(group,condition):
 counts[group]+=1
 assert condition,(group,counts[group])
def canon(x):return json.dumps(x,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def dt(s):
 d=datetime.fromisoformat(s.replace('Z','+00:00'));return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)
manifest=json.loads((src/'manifest.json').read_text())
for fn,meta in manifest['filer'].items():
 raw=(src/fn).read_bytes();data=gzip.decompress(raw) if fn.endswith('.gz') else raw
 ck('frozen_files',len(raw)==meta['sparadeBytes'] and len(data)==meta['originalBytes'] and hashlib.sha256(data).hexdigest()==meta['originalSha256'])
for fn,h in rep['sourceHashes'].items():
 p=src/fn if fn=='manifest.json' else root/'apps/api/scripts'/fn
 ck('source_hashes',hashlib.sha256(p.read_bytes()).hexdigest()==h)
world=json.loads(gzip.decompress((src/'grund/kund-och-facit.json.gz').read_bytes()));saved=json.loads(gzip.decompress((src/'grund/AGENT_PA.json.gz').read_bytes()))
original={p['id']:p for p in world['betalningar']};raws={r['id']:r['bankrad'] for r in saved['rader']};original_notices={n['id']:n for n in world['avier']};all_snap=[];summaries=[]
for idx,fn in enumerate(('forward.sqlite','reverse.sqlite','synthetic-closure.sqlite')):
 db=sqlite3.connect(f'file:{out/fn}?mode=ro&immutable=1',uri=True);db.row_factory=sqlite3.Row
 ck('sqlite_integrity',db.execute('PRAGMA integrity_check').fetchone()[0]=='ok' and not db.execute('PRAGMA foreign_key_check').fetchall())
 tables=('leases','notices','receipts','lots','movements','return_accounts','refunds','journal','events');s={t:[dict(r) for r in db.execute('SELECT * FROM '+t)] for t in tables};seq={(r['org'],r['id']):r['rowid'] for r in db.execute('SELECT rowid,org,id FROM events')};db.close()
 ns={(n['org'],n['id']):n for n in s['notices']};rs={(r['org'],r['id']):r for r in s['receipts']};ls={(l['org'],l['source_bank_id']):l for l in s['lots']};es={(e['org'],e['id']):e for e in s['events']};leases={(l['org'],l['id']):l for l in s['leases']};by_source=defaultdict(list);by_target=defaultdict(list);by_event=defaultdict(list);journal=defaultdict(lambda:Counter())
 for m in s['movements']:
  by_source[(m['org'],m['source_bank_id'])].append(m);by_target[(m['org'],m['target_notice_id'])].append(m);by_event[(m['org'],m['event_id'])].append(m)
 for j in s['journal']:journal[(j['org'],j['event_id'])][j['account']]+=j['signed_ore']
 for n in s['notices']:
  key=(n['org'],n['id']);lease=leases[(n['org'],n['lease'])];o=original_notices[n['id']]
  ck('notice_conservation',n['amount']==n['debt']+sum(m['amount'] for m in by_target[key]) and 0<=n['debt']<=n['amount'])
  ck('notice_source_scope',n['tenant']==str(o['hyresgast'])==lease['tenant'] and n['lease']=='avtal-'+n['tenant'] and n['amount']==o['beloppOre'] and n['period']==o['year']*12+o['month'] and n['org']=='syntetisk')
 scores=Counter();progress=[]
 for r in s['receipts']:
  key=(r['org'],r['id']);raw=raws[r['fixture_id']];p=original[r['fixture_id']];payload=json.loads(r['payload']);decision=json.loads(r['result']);lot=ls.get(key);bank_moves=[m for m in by_source[key] if m['kind']=='BANK'];cash=sum(m['amount'] for m in bank_moves);surplus=lot['original'] if lot else 0
  ck('receipt_input',r['id']==raw['id'] and payload=={'org':'syntetisk','date':raw['datum'],'amount':int(Decimal(str(raw['belopp']))*100),'text':raw['text'],'reference':('' if p['ocrFranHyresgast'] is None else raw['rawOcr'] or '')} and r['amount']==p['beloppOre']==payload['amount'])
  ck('reference_projection',payload['reference']==(raw['rawOcr'] or '') or (p['ocrFranHyresgast'] is None and raw['rawOcr']=='2026' and payload['reference']==''))
  ck('receipt_conservation',r['amount']==cash+surplus+r['unresolved'])
  allocations={m['target_notice_id']:m['amount'] for m in bank_moves}
  ck('receipt_decision',dict(decision['allocations'])==allocations and decision['held_surplus']==surplus and decision['unresolved']==r['unresolved'])
  expected={a['avi']:a['beloppOre'] for a in p['facit']['allokeringar']};correct=bool(allocations) and not p['facit']['granskningKravsAvUnderlaget'] and allocations==expected and surplus==0
  scores['correct' if correct else 'deviation' if allocations else 'review']+=1
  if p['typ']=='OVERBETALNING':
   n=ns[('syntetisk',p['facit']['avseddAvi'])];credit=sum(m['amount'] for m in by_target[('syntetisk',n['id'])] if m['kind']=='CREDIT')
   ck('overpayment_progression',p['hyresgast']==57 and p['beloppOre']==980000 and n['amount']==977500 and credit==p['period']*2500 and allocations=={n['id']:977500-credit} and surplus==(p['period']+1)*2500)
   progress.append((p['period'],credit,cash,surplus))
  else:ck('non_overpayment_original_gold',allocations==expected and not surplus)
  if idx<2:
   rr=rep['runs'][idx]['rows'][r['fixture_id']]
   ck('report_receipt_row',rr=={'sourceBankId':r['id'],'bank':payload,'decision':decision})
 for m in s['movements']:
  key=(m['org'],m['source_bank_id']);r=rs[key];source=ns[(m['org'],m['source_notice_id'])];e=es[(m['org'],m['event_id'])]
  ck('movement_source_scope',m['fixture_id']==r['fixture_id'] and m['amount']>0 and source['org']==r['org']==m['org'])
  if m['kind']=='BANK':
   target=ns[(m['org'],m['target_notice_id'])]
   ck('bank_linkage',source['id']==target['id'] and dt(target['issued'])<=dt(json.loads(r['payload'])['date']) and e['kind']=='INGEST')
  elif m['kind']=='CREDIT':
   l=ls[key];target=ns[(m['org'],m['target_notice_id'])];at=json.loads(e['payload'])[1]
   ck('credit_linkage',l['source_notice_id']==source['id'] and source['tenant']==l['tenant']==target['tenant'] and source['lease']==l['lease']==target['lease'] and source['period']<target['period'] and dt(l['created_at'])<=dt(at) and dt(target['issued'])<=dt(at) and e['kind']=='APPLY')
   prior=[n for n in s['notices'] if (n['org'],n['lease'])==(l['org'],l['lease']) and l['period']<n['period']<target['period']]
   ck('credit_no_skipped_month',len(prior)==target['period']-l['period']-1 and all(dt(n['issued'])<=dt(at) and n['amount']==sum(x['amount'] for x in by_target[(n['org'],n['id'])] if seq[(x['org'],x['event_id'])]<seq[(m['org'],m['event_id'])]) for n in prior))
  elif m['kind']=='REFUND':ck('refund_source_linkage',ls[key]['source_notice_id']==source['id'] and m['target_notice_id']=='' and e['kind']=='CONFIRM_REFUND')
  else:raise AssertionError('unknown movement kind')
 for l in s['lots']:
  key=(l['org'],l['source_bank_id']);r=rs[key];n=ns[(l['org'],l['source_notice_id'])];moves=by_source[key]
  ck('lot_conservation',l['original']>=l['applied']+l['refunded']+l['reserved']>=0 and l['applied']==sum(m['amount'] for m in moves if m['kind']=='CREDIT') and l['refunded']==sum(m['amount'] for m in moves if m['kind']=='REFUND') and l['reserved']==sum(f['amount'] for f in s['refunds'] if (f['org'],f['source_bank_id'])==key and f['status']=='PENDING'))
  ck('lot_source_scope',l['fixture_id']==r['fixture_id'] and (l['tenant'],l['lease'],l['period'])==(n['tenant'],n['lease'],n['period']) and l['created_at']==json.loads(r['payload'])['date'])
 for key,e in es.items():
  p=json.loads(e['payload']);expected=Counter();kind=e['kind']
  if kind=='ISSUE':expected.update({'RECEIVABLE':p['debt'],'RENT':-p['debt']})
  elif kind=='INGEST':
   r=rs[(e['org'],p[0])];allocated=sum(m['amount'] for m in by_event[key]);surplus=ls.get((e['org'],p[0]),{}).get('original',0)
   expected.update({'BANK':r['amount'],'RECEIVABLE':-allocated,'CUSTOMER_LIABILITY':-surplus,'UNIDENTIFIED':-r['unresolved']})
  elif kind=='APPLY':
   amount=sum(m['amount'] for m in by_event[key]);expected.update({'CUSTOMER_LIABILITY':amount,'RECEIVABLE':-amount})
  elif kind=='CONFIRM_REFUND':expected.update({'CUSTOMER_LIABILITY':p[2],'BANK':-p[2]})
  ck('journal_each_event',dict((a,v) for a,v in journal[key].items() if v)==dict((a,v) for a,v in expected.items() if v) and sum(journal[key].values())==0)
 ck('journal_orphans',all((j['org'],j['event_id']) in es for j in s['journal']))
 accounts={a:sum(j['signed_ore'] for j in s['journal'] if j['account']==a) for a in ('BANK','RECEIVABLE','CUSTOMER_LIABILITY','UNIDENTIFIED','RENT')};incoming=sum(r['amount'] for r in s['receipts']);liability=sum(l['original']-l['applied']-l['refunded'] for l in s['lots']);refunded=sum(l['refunded'] for l in s['lots']);reserved=sum(l['reserved'] for l in s['lots']);applied=sum(l['applied'] for l in s['lots'])
 totals={'incomingOre':incoming,'liabilityOre':liability,'creditAppliedOre':applied,'refundedOre':refunded,'reservedOre':reserved,'accounts':accounts}
 ck('account_totals',accounts['BANK']==incoming-refunded and accounts['RECEIVABLE']==sum(n['debt'] for n in s['notices']) and -accounts['CUSTOMER_LIABILITY']==liability and -accounts['UNIDENTIFIED']==sum(r['unresolved'] for r in s['receipts']) and sum(accounts.values())==0)
 ck('original_scores',scores=={'correct':1970,'deviation':10,'review':20})
 snapshot={t:sorted(rows,key=canon) for t,rows in s.items() if idx==2 or t!='events'}
 targetrep=rep['runs'][idx] if idx<2 else rep['syntheticClosure']
 ck('snapshot_matches_report',snapshot==targetrep['financialSnapshot'])
 ck('report_totals',totals==(targetrep['totals'] if idx<2 else targetrep['afterTestSettlement']['syntetisk']))
 ck('expected_final_liability',liability==(25000 if idx<2 else 0) and refunded==(0 if idx<2 else 25000) and reserved==0 and applied==112500 and sum(l['original'] for l in s['lots'])==137500)
 if idx==2:
  ck('one_synthetic_refund',len(s['refunds'])==len(s['return_accounts'])==1)
  r=s['refunds'][0];a=s['return_accounts'][0];key=(r['org'],r['source_bank_id']);l=ls[key];close=es[(r['org'],'synthetic-lease-end')];request=es[(r['org'],'synthetic-refund-request')];settlement=es[(r['org'],'synthetic-bank-settled')];verification=es[(r['org'],'synthetic-verified-source-account')]
  ck('refund_binding',r['status']=='SETTLED' and r['amount']==25000 and r['account_token']==a['account_token']=='TEST_ONLY_SOURCE_BOUND_ACCOUNT' and (a['org'],a['source_bank_id'])==key and r['settlement_id']=='TEST_ONLY_SETTLEMENT_250KR' and dt(r['requested_at'])<=dt(r['settled_at']))
  ck('refund_event_payloads',json.loads(request['payload'])==[r['source_bank_id'],r['amount'],r['account_token'],r['requested_at']] and json.loads(settlement['payload'])==[r['id'],r['settlement_id'],r['amount'],r['account_token'],r['settled_at']] and json.loads(verification['payload'])==[r['source_bank_id'],r['account_token'],a['verification_id']] and json.loads(request['result'])['status']=='PENDING' and json.loads(settlement['result'])['status']=='SETTLED')
  request_seq=seq[(request['org'],request['id'])];settle_seq=seq[(settlement['org'],settlement['id'])]
  ck('refund_event_sequence',seq[(close['org'],close['id'])]<request_seq<settle_seq and seq[(verification['org'],verification['id'])]<request_seq)
  pending_accounts={a:sum(j['signed_ore'] for j in s['journal'] if j['account']==a and seq[(j['org'],j['event_id'])]<=request_seq) for a in accounts};pending=targetrep['pending']['syntetisk']
  ck('pending_keeps_liability',pending['accounts']==pending_accounts and pending['liabilityOre']==-pending_accounts['CUSTOMER_LIABILITY']==25000 and pending['reservedOre']==25000 and pending['refundedOre']==0 and pending_accounts['BANK']==incoming and not journal[(request['org'],request['id'])])
  ck('settlement_outflow_only',accounts['BANK']==pending_accounts['BANK']-25000 and accounts['CUSTOMER_LIABILITY']==pending_accounts['CUSTOMER_LIABILITY']+25000 and liability==0)
 all_snap.append(snapshot);summaries.append({'database':fn,'table_counts':{t:len(v) for t,v in s.items()},'scores':dict(scores),'totals':totals,'overpayment_progression':sorted(progress)})
for run in rep['runs']:
 actual_differences=sorted(key for key,row in run['rows'].items() if row['bank']['reference']!=(raws[key]['rawOcr'] or ''))
 ck('projection_metadata',run['changedPayerInputCount']==0 and run['legacyParsedRawOcrDifferenceCount']==168 and sorted(run['legacyParsedRawOcrDifferenceFixtureIds'])==actual_differences and len(actual_differences)==168)
ck('projection_explanation',all(word in rep['inputProjection'] for word in ('168','2026','Cash','date','text','source bank ID')))
if len(sys.argv)==3:
 previous=json.loads((Path(sys.argv[2])/'resultat.json').read_text())
 for before,after in zip(previous['runs'],rep['runs']):
  ck('previous_rows_unchanged',before['rows']==after['rows'])
  ck('previous_financials_unchanged',before['financialSnapshot']==after['financialSnapshot'] and before['totals']==after['totals'])
 ck('previous_closure_unchanged',previous['syntheticClosure']==rep['syntheticClosure'])
ck('same_order_results',all_snap[0]==all_snap[1] and rep['runs'][0]['rows']==rep['runs'][1]['rows'])
ck('limits_labelled',rep['uniqueUnderlyingPayments']==2000 and rep['modelCalls']==rep['modelFeesSEK']==rep['realBankCalls']==0 and rep['productionAccountingExecuted'] is False and rep['originalGoldChanged'] is False and all(r['originalMax20Proven'] is False and r['productionPrecisionProven'] is False and r['changedPayerInputCount']==0 for r in rep['runs']) and rep['syntheticClosure']['realBankTransfer'] is False and rep['syntheticClosure']['realAccountVerification'] is False and rep['syntheticClosure']['originalDatasetMax20Proven'] is False)
print(json.dumps({'status':'PASS','artifact_hashes':{name:hashlib.sha256((out/name).read_bytes()).hexdigest() for name in ('resultat.json','forward.sqlite','reverse.sqlite','synthetic-closure.sqlite')},'check_count':sum(counts.values()),'checks':dict(counts),'summaries':summaries},ensure_ascii=False))
