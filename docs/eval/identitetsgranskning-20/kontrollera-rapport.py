"""Independent saved-report check; never imports the inventory or a decision policy."""
import argparse
from collections import Counter
from decimal import Decimal
import gzip
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]


def load(p):
    raw=p.read_bytes()
    return json.loads(gzip.decompress(raw) if p.suffix=='.gz' else raw)


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('directory',type=Path);args=ap.parse_args()
    directory=args.directory
    report=load(directory/'fall.json');manifest=load(directory/'manifest.json')
    assert hashlib.sha256((directory/'fall.json').read_bytes()).hexdigest()==manifest['fallJsonSha256']
    assert hashlib.sha256((directory/'falltabell.md').read_bytes()).hexdigest()==manifest['tableSha256']
    assert hashlib.sha256((ROOT/'apps/api/scripts/audit_identitetsfall_20.py').read_bytes()).hexdigest()==manifest['scriptSha256']
    public=load(ROOT/'docs/eval/overskottsprov/korning-1/public-input.json.gz')
    world=load(ROOT/'docs/eval/kundflode-2000/grund/kund-och-facit.json.gz')
    saved=load(ROOT/'docs/eval/tillgodo-livscykel/korning-1/resultat.json.gz')
    ids={k for k,v in saved['runs'][0]['memory']['rows'].items() if v['reason'] in ('OTILLRACKLIG_IDENTIFIERING','IDENTITETSKONFLIKT')}
    cases={c['id']:c for c in report['cases']}
    table_ids=re.findall(r'^\| (betalning-[^ ]+) \|',(directory/'falltabell.md').read_text(),re.M)
    assert len(report['cases'])==len(cases)==len(table_ids)==len(set(table_ids))==20
    assert set(cases)==set(table_ids)==ids
    assert Counter(c['classification'] for c in cases.values())=={'HUMAN_EVIDENCE_REQUIRED':20}
    assert list(report['categories'].values())==[0,0,20,0]
    assert Counter(c['reason'] for c in cases.values())=={'OTILLRACKLIG_IDENTIFIERING':10,'IDENTITETSKONFLIKT':10}
    world_by_id={p['id']:p for p in world['betalningar']}
    observations=0
    for key,c in cases.items():
        original=world_by_id[key];b=public['banks'][key]
        assert c['originalCsvFieldsReconstructed']==b==c['experimentBankFieldsObserved']
        assert (b['date'],b['text'],b['amount'])==(original['datum'],original['text'],original['beloppOre'])
        assert original['facit']['allokeringar']==[] and original['facit']['granskningKravsAvUnderlaget']
        assert c['agentFieldsFromCode']=={'date':b['date'],'text':b['text'],'amountOre':b['amount'],'rawOcr':b['reference'] or None}
        for evidence in c['historicalObserved'].values():
            raw=evidence['bankRowObserved']
            assert (raw['datum'],raw['text'],int(Decimal(str(raw['belopp']))*100),raw['rawOcr'] or '')==(b['date'],b['text'],b['amount'],b['reference'])
            assert 'reference' not in raw and evidence['candidateCapReached'] is False
            observations+=1
        if not b['reference']:
            assert b['text']=='Inbetalning' and len(c['competingScopes'])==3
        else:
            assert len(c['explicitNoticeIds'])==1
            assert {s[2] for s in c['competingScopes']}=={'avtal-58','avtal-118'}
    assert observations==80
    assert report['separateLastCreditPayment']=='betalning-57-9' and 'betalning-57-9' not in ids
    for run in saved['runs']:
        assert ids < set(run['metrics']['reviewPaymentIds'])
        assert set(run['metrics']['reviewPaymentIds'])-ids=={'betalning-57-9'}
        assert run['metrics']['outstandingCreditOre']==(25000 if run['variant']=='A' else 2500)
    assert report['newDecisionReplay'] is False
    print(json.dumps({'passed':True,'exactCaseIds':sorted(ids),'caseCount':20,'historicalBankObservationsChecked':80,
       'disjointCategories':[0,0,20,0],'tableMembersMatch':True,'goldAfterCheck':20,
       'lastCreditVisibleSeparately':True,'newDecisionReplay':False,
       'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
