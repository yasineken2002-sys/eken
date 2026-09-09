"""Read-only inventory of saved evidence, NOT a new matching/decision replay.

No imports of policy, production code, DB clients or model clients. Reconstructs
ledger views from #871's saved operations solely to describe information that
was available. It cannot establish payer intent, a live bank field contract,
production behavior or a new automatic-success metric.
"""
import argparse
from collections import Counter
from copy import deepcopy
from decimal import Decimal
import gzip
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
BASE = '6c2f06f071ff19d2bd994c8ee09ba4af8c94b5c2'
REASONS = {'OTILLRACKLIG_IDENTIFIERING', 'IDENTITETSKONFLIKT'}


def data(path):
    raw = (ROOT/path).read_bytes()
    return gzip.decompress(raw) if str(path).endswith('.gz') else raw


def load(path):
    return json.loads(data(path))


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def checksum(base):
    # Matches the frozen seeder's convention; validates source reconstruction,
    # never treats checksum validity as proof of payment intent.
    return str(-sum(int(c) if i % 2 == 0 else sum(divmod(int(c)*2, 10))
                    for i, c in enumerate(reversed(base))) % 10)


def source_bank(payment, notices):
    # These are the generator's CSV fields only. No typ/hyresgast/period/facit.
    owner = payment['ocrFranHyresgast']
    refs = {n['ocr'] for n in notices.values() if n['tenant'] == str(owner)}
    reference = '' if owner is None else next(iter(refs))
    assert owner is None or len(refs) == 1
    if payment['felskrivOcr']:
        reference = reference[:-1] + str((int(reference[-1])+1) % 10)
    return {'date': payment['datum'], 'text': payment['text'],
            'amount': payment['beloppOre'], 'reference': reference, 'org': 'syntetisk'}


def ledger_views(run, notices, selected):
    """Read saved effects; does not decide or call matching again."""
    debts = {}; found = {}
    for op in run['memory']['operations']:
        if op['kind'] == 'ISSUE':
            debts[op['notice']] = notices[op['notice']]['debt']-sum(u['amount'] for u in op['uses'])
        elif op['kind'] == 'PAYMENT':
            if op['event'] in selected:
                found[op['event']] = dict(debts)
            for key, amount in op['allocations'].items():
                debts[key] -= amount
        else:
            raise AssertionError('Unexpected main-horizon operation')
    assert debts == run['memory']['debts']
    assert set(found) == selected
    return found


def build(payments, public, lifecycle, historical):
    notices = {n['id']: n for n in public['notices']}
    first = lifecycle['runs'][0]
    selected = {k for k,r in first['memory']['rows'].items() if r['reason'] in REASONS}
    assert len(selected) == 20
    views = {}
    for run in lifecycle['runs']:
        assert {k for k,r in run['memory']['rows'].items() if r['reason'] in REASONS} == selected
        label = run['variant'] + ('_reverse' if run['reverseWithinDay'] else '_forward')
        views[label] = ledger_views(run, notices, selected)
    cases = []
    for key in sorted(selected):
        b = public['banks'][key]
        original = source_bank(payments[key], notices)
        assert original == b
        known = [n for n in notices.values() if n['org'] == b['org'] and n['issued'] <= b['date']]
        explicit = [n for n in known if n['number'].casefold() in b['text'].casefold()]
        ocr = [n for n in known if b['reference'] and n['ocr'] == b['reference']]
        same_amount = [n for n in known if n['debt'] == b['amount']]
        current_amount = [n for n in same_amount if f"{n['year']:04d}-{n['month']:02d}" == b['date'][:7]]
        reason = first['memory']['rows'][key]['reason']
        if reason == 'IDENTITETSKONFLIKT':
            assert len(explicit) == 1 and ocr
            assert {n['tenant'] for n in ocr}.isdisjoint({n['tenant'] for n in explicit})
            assert checksum(b['reference'][:-1]) == b['reference'][-1]
            competitors = explicit+ocr
            why = 'OCR och avinummer pekar på olika hyresgäster/avtal; giltig checksiffra och lika hyra avgör inte avsikten.'
            need = 'Spårbart svar från betalare eller verifierat personalunderlag som knyter just bankhändelsen till avsedd avi/avtal och uttryckligen förklarar den andra referensen.'
        else:
            assert not b['reference'] and b['text'] == 'Inbetalning'
            assert not explicit and not ocr and len({n['lease'] for n in current_amount}) >= 2
            competitors = same_amount
            why = 'Varken referens, namn, avtal eller hyresperiod finns i bankraden; belopp och återkomst räcker inte. Även del-/samlingsbetalning är möjlig.'
            need = 'Spårbar kund-/personaluppgift som binder just transaktionen till avtal och avi(er), period och eventuell fördelning; inte bara ett namn eller avsändarkonto.'
        saved = {}
        for label, rows in historical.items():
            row = rows[key]; bank = row['bankrad']
            assert bank['datum'] == b['date'] and bank['text'] == b['text']
            assert Decimal(str(bank['belopp']))*100 == b['amount']
            assert (bank['rawOcr'] or '') == b['reference']
            saved[label] = {'bankRowObserved': bank, 'statusHistoricalOnly': row['status'],
                           'candidateCapReached': row['underlag']['takNått'],
                           'candidateNumbersHistoricalOnly': [n['nummer'] for n in row['underlag']['kandidater']]}
        scopes = sorted({(n['org'], n['tenant'], n['lease']) for n in competitors})
        cases.append({'id': key, 'reason': reason, 'originalCsvFieldsReconstructed': original,
            'originalCsvLineReconstructed': f"{b['date'][:10]};{b['text']};{Decimal(b['amount'])/100:.2f};{b['reference']}",
            'notOriginalStoredCsvFile': True, 'historicalObserved': saved,
            'dbReferenceExpectedFromCodeNotObservedInOldDump': b['reference'] or None,
            'agentFieldsFromCode': {'date': b['date'], 'text': b['text'], 'amountOre': b['amount'], 'rawOcr': b['reference'] or None},
            'agentOriginalReferenceFieldOmitted': True,
            'experimentBankFieldsObserved': first['memory']['rows'][key]['bank'],
            'explicitNoticeIds': sorted(n['id'] for n in explicit),
            'ocrRegistryNoticeIdsIncludingPaid': sorted(n['id'] for n in ocr),
            'sameGrossAmountNoticeIdsNotIntentEvidence': sorted(n['id'] for n in same_amount),
            'bankMonthSameGrossAmountExamplesNotIntentEvidence': sorted(n['id'] for n in current_amount),
            'competingScopes': scopes,
            'competingNoticeDebtBeforePaymentFromSaved871': {
                label: {n['id']: state[key][n['id']] for n in competitors}
                for label,state in views.items()},
            'missingOriginalFields': ['senderAccount','senderName','externalBankTransactionId','extraRemittance','payerConfirmation'],
            'whyNoSafeDecision': why, 'minimumAdditionalEvidence': need,
            'classification': 'HUMAN_EVIDENCE_REQUIRED',
            'classificationBasis': 'No verified additional identifier resolves this frozen event; richer integration alone is unproven.'})
    return {'kind':'READ_ONLY_CASE_INVENTORY_NOT_MATCHING_EXPERIMENT','baseCommit':BASE,
            'newDecisionReplay':False,'bankCalls':0,'modelCalls':0,'productionWrites':0,
            'cases':cases,'categories':{'existingVerifiedInformation':0,'verifiedIntegrationOrPaymentFlowOnly':0,
                'humanEvidenceRequired':20,'insufficientEvidenceToClassify':0},
            'upstreamProviderAvailability':'UNKNOWN; no live adapter/payload/consent inspected',
            'saved871MetricsUnchanged':[{'variant':r['variant'],'reverseWithinDay':r['reverseWithinDay'],
                'metrics':r['metrics']} for r in lifecycle['runs']],
            'separateLastCreditPayment':'betalning-57-9',
            'originalBaselineUnchanged':{'correct':1970,'wrong':0,'review':30}}


def validate(report, expected):
    cases = report['cases']
    assert len(cases) == len({c['id'] for c in cases}) == 20
    assert {c['id'] for c in cases} == set(expected)
    assert Counter(c['reason'] for c in cases) == Counter({'IDENTITETSKONFLIKT':10,'OTILLRACKLIG_IDENTIFIERING':10})
    assert sum(report['categories'].values()) == 20
    assert report['categories'] == {'existingVerifiedInformation':0,'verifiedIntegrationOrPaymentFlowOnly':0,
                                  'humanEvidenceRequired':20,'insufficientEvidenceToClassify':0}
    for c in cases:
        assert c == expected[c['id']],c['id']
    assert report['newDecisionReplay'] is False
    assert report['separateLastCreditPayment'] == 'betalning-57-9'
    assert report['separateLastCreditPayment'] not in expected
    for item in report['saved871MetricsUnchanged']:
        m=item['metrics']; assert m['humanReviewPayments']==21 and m['fullyHandledPaymentsUnderAssumptions']==1979
        assert m['conflicts']==m['unidentified']==10
        assert m['outstandingCreditOre']==(25000 if item['variant']=='A' else 2500)
        assert 'betalning-57-9' in m['reviewPaymentIds']


def table(report):
    lines=['# Exakt 20 faktiska identitetsfall — syntetiska uppgifter', '',
           'CSV är återskapad ur fryst generator/projektion; sparad originalfil saknas. D/I/M/P-spåren förklaras i huvudrapporten.',
           'DB-observation avser de fyra historiska #868-dumparna. `reference` saknas i dumpformatet: dess lagring anges därför som kodbelagd, inte observerad. Agentfält avser kodens kontrakt; inga modellkörningar görs.', '',
           '| Stabilt ID | Ursprungliga bankfält (datum; belopp kr; text; referens) | Import/DB | Matchare / agent / #871 | Konkurrerande avier och avtal | Varför inget säkert beslut | Minsta ytterligare bevis |',
           '| --- | --- | --- | --- | --- | --- | --- |']
    for c in report['cases']:
        b=c['originalCsvFieldsReconstructed']; p=int(c['id'].rsplit('-',1)[1])
        fields=f"{b['date'][:10]}; {Decimal(b['amount'])/100:.2f}; {b['text']}; {b['reference'] or 'tom'}"
        db=f"Datum/text/belopp oförändrade, rawOcr={b['reference'] or 'null'} i 4 dumpar; reference={b['reference'] or 'null'} enligt importkod (D1/I1)."
        agent='Matcharen får DB-raden; agenten datum/text/belopp/rawOcr men inte reference; #871 får originalprojektionen ovan (M1/M2/P1).'
        if c['reason']=='IDENTITETSKONFLIKT':
            alternatives=f"avi-58-{p}/avtal-58 (Freja Sundberg) mot OCR-ägarens avi-118-0…{p}/avtal-118 (Freja Nyberg). Betalda identiteter kvarstår."
        else:
            alternatives=f"Samma grundbelopp bl.a. avi-56-{p}, avi-116-{p}, avi-176-{p}: avtal-56/116/176; även månader 0…{p}, andra del-/samlingsalternativ. Bankmånad är inte avsikt."
        lines.append('| '+' | '.join([c['id'],fields,db,agent,alternatives,c['whyNoSafeDecision'],c['minimumAdditionalEvidence']])+' |')
    return '\n'.join(lines)+'\n'


def main():
    ap=argparse.ArgumentParser(description=__doc__); ap.add_argument('output',type=Path); args=ap.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    frozen=load('docs/eval/kundflode-2000/manifest.json'); checked={}
    for name,entry in frozen['filer'].items():
        path='docs/eval/kundflode-2000/'+name
        assert digest(data(path))==entry['originalSha256'],path
        checked[path]=entry['originalSha256']
    world=load('docs/eval/kundflode-2000/grund/kund-och-facit.json.gz')
    public_path='docs/eval/overskottsprov/korning-1/public-input.json.gz'
    assert digest(data(public_path))==load('docs/eval/overskottsprov/korning-1/manifest.json')['publicInputUncompressedSha256']
    life_path='docs/eval/tillgodo-livscykel/korning-1/resultat.json.gz'
    life_manifest=load('docs/eval/tillgodo-livscykel/korning-1/manifest.json')
    assert digest(data(life_path))==life_manifest['uncompressedSha256']
    for name,h in life_manifest['sourceHashes'].items():assert digest((ROOT/name).read_bytes())==h,name
    public=load(public_path); lifecycle=load(life_path)
    historical={f'{order}/{arm}':{r['id']:r for r in load(f'docs/eval/kundflode-2000/{order}/{arm}.json.gz')['rader']}
                for order in ('grund','omvand-inom-dag') for arm in ('AGENT_AV','AGENT_PA')}
    payments={p['id']:p for p in world['betalningar']}
    report=build(payments,public,lifecycle,historical)
    expected={c['id']:deepcopy(c) for c in report['cases']}; validate(report,expected)
    # Gold is consulted only now, after the inventory, solely as an after-check.
    for key in expected:
        assert payments[key]['facit']['granskningKravsAvUnderlaget'] is True
        assert payments[key]['facit']['allokeringar']==[]
    poisoned=deepcopy(payments)
    for p in poisoned.values():
        for key in ('facit','typ','hyresgast','period'):p[key]={'UNUSABLE_METADATA':True}
    assert build(poisoned,public,lifecycle,historical)==report
    rejected=[]
    for mutation in ('missing_case','duplicate_case','same_count_wrong_member','invented_reference','hidden_conflict','false_resolution','credit_hidden'):
        bad=deepcopy(report)
        if mutation=='missing_case':bad['cases'].pop()
        elif mutation=='duplicate_case':bad['cases'][-1]=deepcopy(bad['cases'][0])
        elif mutation=='same_count_wrong_member':bad['cases'][-1]['id']='NOT_AN_ORIGINAL_CASE'
        elif mutation=='invented_reference':bad['cases'][0]['originalCsvFieldsReconstructed']['reference']='INVENTED'
        elif mutation=='hidden_conflict':bad['cases'][-1]['ocrRegistryNoticeIdsIncludingPaid']=[]
        elif mutation=='false_resolution':bad['categories']['existingVerifiedInformation']=1;bad['categories']['humanEvidenceRequired']=19
        elif mutation=='credit_hidden':bad['saved871MetricsUnchanged'][0]['metrics']['outstandingCreditOre']=0
        try:validate(bad,expected)
        except AssertionError:rejected.append(mutation)
        else:raise AssertionError('Missed negative control '+mutation)
    report['verification']={'originalManifestFilesChecked':checked,'publicInputSha256':digest(data(public_path)),
       'saved871Sha256':digest(data(life_path)),'goldAfterCheckPassed':20,'poisonedGoldAndScenarioInvariant':True,
       'negativeControlsRejected':rejected,'scriptSha256':digest(Path(__file__).read_bytes())}
    payload=(json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode()
    (args.output/'fall.json').write_bytes(payload)
    text=table(report); assert len(re.findall(r'^\| betalning-',text,re.M))==20
    (args.output/'falltabell.md').write_text(text)
    (args.output/'manifest.json').write_text(json.dumps({'fallJsonSha256':digest(payload),'tableSha256':digest(text.encode()),
        'scriptSha256':report['verification']['scriptSha256'],'caseCount':20},indent=2)+'\n')
    print(json.dumps({'passed':True,'cases':len(report['cases']),'categories':report['categories'],
        'originalManifestFilesChecked':len(checked),'negativeControlsRejected':rejected,
        'goldAfterCheckPassed':20,'newDecisionReplay':False},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
