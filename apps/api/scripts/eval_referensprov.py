"""Stateful, offline experiment against the frozen 2,000-payment fixture.

No production writes, network calls, AI responses or simulated human corrections.
Gold is accessed only by the evaluator after each decision. The unique-OCR arm
changes payer input explicitly and is NOT another run on identical bank input.
"""
import argparse
from collections import Counter
from dataclasses import replace
from decimal import Decimal
import gzip
import hashlib
import json
from pathlib import Path

from referensprov_policy import Bank, Notice, checksum, decide

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'docs/eval/kundflode-2000'


def load_verified(name):
    payload = (SOURCE / name).read_bytes()
    if name.endswith('.gz'):
        payload = gzip.decompress(payload)
    manifest = json.loads((SOURCE / 'manifest.json').read_text())
    assert hashlib.sha256(payload).hexdigest() == manifest['filer'][name]['originalSha256']
    return json.loads(payload)


def project(world, saved, unique):
    """Fixture-to-public-input boundary; no facit read here or inside policy."""
    by_id = {r['id']: r for r in saved['rader']}
    tenant_ocr = {}
    for p in world['betalningar']:
        if p['ocrFranHyresgast'] is not None and not p['felskrivOcr']:
            tenant_ocr[p['ocrFranHyresgast']] = by_id[p['id']]['bankrad']['rawOcr']
    # Some tenants never submit correct OCR; the original seeder assigns sequences.
    for t in world['hyresgaster']:
        base = str(t['index'] + 1).zfill(10)
        generated = base + checksum(base)
        assert tenant_ocr.get(t['index'], generated) == generated
        tenant_ocr[t['index']] = generated
    people = {t['index']: t for t in world['hyresgaster']}
    notices = []
    for seq, n in enumerate(world['avier'], 1):
        t = people[n['hyresgast']]
        ref_base = str(9000000000 + seq)
        notices.append(Notice(
            id=n['id'], org='syntetisk', tenant=str(t['index']), lease=f"avtal-{t['index']}",
            name=t['fornamn'] + ' ' + t['efternamn'], number=n['nummer'],
            ocr=tenant_ocr[t['index']], year=n['year'], month=n['month'],
            due=n['forfallodatum'], issued=f"{n['year']:04d}-{n['month']:02d}-01",
            debt=n['beloppOre'], unique_ref=ref_base + checksum(ref_base) if unique else '',
        ))
    lookup = {(n['hyresgast'], n['period']): note for n, note in zip(world['avier'], notices)}
    banks = {}
    changed = []
    for p in world['betalningar']:
        raw = by_id[p['id']]['bankrad']
        assert raw['text'] == p['text'] and raw['datum'] == p['datum']
        assert Decimal(str(raw['belopp'])) * 100 == p['beloppOre']
        reference = '' if p['ocrFranHyresgast'] is None else tenant_ocr[p['ocrFranHyresgast']]
        if p['felskrivOcr']:
            reference = reference[:-1] + str((int(reference[-1]) + 1) % 10)
        # Explicit counterfactual: correctly entered single/partial rent payments
        # use the reference printed on the issued notice. Missing/typo/conflicting
        # and combined payment inputs remain unchanged; they never disappear.
        if unique and p['typ'] in ('OCR', 'DELBETALNING'):
            reference = lookup[(p['hyresgast'], p['period'])].unique_ref
            changed.append(p['id'])
        banks[p['id']] = Bank('syntetisk', p['datum'], p['beloppOre'], p['text'], reference)
    return notices, banks, changed


def replay(world, saved, mode, reverse=False):
    notices, banks, changed = project(world, saved, mode == 'UNIK_AVI_OCH_PERIOD')
    order = sorted(banks, reverse=reverse)
    order.sort(key=lambda key: banks[key].date)  # stable reversal only within same date
    outcomes = {}
    for key in order:
        bank = banks[key]
        result = decide(bank, notices, period_support=mode != 'GEMENSAM_REFERENSKONTROLL')
        allocation = dict(result.allocations)
        assert sum(allocation.values()) in (0, bank.amount)
        for n in notices:
            assert 0 <= allocation.get(n.id, 0) <= n.debt
            if n.id in allocation:
                assert n.org == bank.org and n.issued <= bank.date
        notices = [replace(n, debt=n.debt - allocation.get(n.id, 0)) for n in notices]
        outcomes[key] = {'reason': result.reason, 'allocations': allocation}
    # Gold/scenario are unavailable to the decision function; scoring starts here.
    correct = wrong = 0
    by_type = {}
    for payment in world['betalningar']:
        result = outcomes[payment['id']]
        expected = {a['avi']: a['beloppOre'] for a in payment['facit']['allokeringar']}
        automatic = bool(result['allocations'])
        passed = automatic and not payment['facit']['granskningKravsAvUnderlaget'] and result['allocations'] == expected
        correct += passed
        wrong += automatic and not passed
        counts = by_type.setdefault(payment['typ'], Counter())
        counts['total'] += 1
        counts['correct' if passed else 'wrong' if automatic else 'review'] += 1
        result['correct'] = passed
    assert len(outcomes) == 2000
    return {
        'mode': mode, 'reverseWithinDay': reverse, 'total': len(outcomes),
        'correctAutomatic': correct, 'wrongAutomatic': wrong,
        'review': 2000 - correct - wrong, 'attention': 2000 - correct,
        'automaticPercent': correct / 20, 'precisionPercent': correct * 100 / (correct + wrong),
        'max20Passed': 2000 - correct <= 20,
        'changedBankInputCount': len(changed), 'changedBankInputIds': changed,
        'reasons': dict(Counter(r['reason'] for r in outcomes.values())),
        'byType': by_type, 'rows': outcomes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Resultatet finns redan; tidigare körningar skrivs inte över.')
    world = load_verified('grund/kund-och-facit.json.gz')
    saved = load_verified('grund/AGENT_PA.json.gz')
    reversed_saved = load_verified('omvand-inom-dag/AGENT_PA.json.gz')
    runs = [replay(world, saved, mode, reverse) for mode in (
        'GEMENSAM_REFERENSKONTROLL', 'REFERENS_OCH_PERIOD', 'UNIK_AVI_OCH_PERIOD'
    ) for reverse in (False, True)]
    assert all(r['wrongAutomatic'] == 0 for r in runs)
    for forward, backward in zip(runs[::2], runs[1::2]):
        assert forward['rows'] == backward['rows'], 'Ordningsberoende beslut'
    report = {
        'kind': 'OFFLINE_STATEFUL_SIMULATION', 'productionImplemented': False,
        'modelCalls': 0, 'modelCost': 0, 'databaseCalls': 0,
        'uniqueUnderlyingPayments': 2000, 'independentRealCustomerEvidence': False,
        'limitations': [
            'Frozen constructed texts, names and frequencies; not customer data.',
            'New policy is Python simulation, not production matcher, AI or database integration.',
            'Named periods use a narrow exact month+year grammar, no arbitrary prose understanding.',
            'Full name+period uniqueness is a proposed policy, not proof of payer identity.',
            'Original fixture due dates are in rental month; separate tests vary due date.',
            'Unique-reference arm changes 1635 bank inputs and assumes correct copying.',
            'No oversurplus ledger, concurrent imports, delivery channel or production dedup tested.',
        ],
        'sourceHashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (
            Path(__file__), Path(__file__).with_name('referensprov_policy.py'), SOURCE / 'manifest.json'
        )},
        'historicalDatabaseBaseline': [saved['sammanfattning'], reversed_saved['sammanfattning']],
        'runs': runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    for r in runs:
        print(json.dumps({k: v for k, v in r.items() if k not in ('rows', 'changedBankInputIds', 'byType')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
