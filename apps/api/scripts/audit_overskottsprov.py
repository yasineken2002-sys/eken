"""Independent recomputation. Stdlib only; imports no policy or replay/scorer.

Checks source/gold/contract, all per-event flows and final debt/credit state.
Cannot verify real DB atomicity, import identities, accounting or payer intent.
"""
import argparse
from collections import Counter
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def read_gz(path):
    payload = path.read_bytes()
    return json.loads(gzip.decompress(payload) if path.suffix == '.gz' else payload)


def ocr(index):
    digits = str(index + 1).zfill(10)
    expanded = [int(c) * (1 if i % 2 == 0 else 2) for i, c in enumerate(digits[::-1])]
    return digits + str((-sum(sum(map(int, str(n))) for n in expanded)) % 10)


def check_public(public, world):
    payments = {p['id']: p for p in world['betalningar']}
    assert len(payments) == 2000 and set(public['banks']) == set(payments)
    for key, p in payments.items():
        reference = '' if p['ocrFranHyresgast'] is None else ocr(p['ocrFranHyresgast'])
        if p['felskrivOcr']:
            reference = reference[:-1] + str((int(reference[-1]) + 1) % 10)
        assert public['banks'][key] == {'org': 'syntetisk', 'date': p['datum'],
            'amount': p['beloppOre'], 'text': p['text'], 'reference': reference}
    people = {p['index']: p for p in world['hyresgaster']}
    expected = []
    for n in world['avier']:
        t = people[n['hyresgast']]
        expected.append({'id': n['id'], 'org': 'syntetisk', 'tenant': str(t['index']),
            'lease': f"avtal-{t['index']}", 'name': t['fornamn'] + ' ' + t['efternamn'],
            'number': n['nummer'], 'ocr': ocr(t['index']), 'year': n['year'],
            'month': n['month'], 'due': n['forfallodatum'],
            'issued': f"{n['year']:04d}-{n['month']:02d}-01", 'debt': n['beloppOre'], 'unique_ref': ''})
    assert public['notices'] == expected


def audit_data(report, public, world, contract):
    check_public(public, world)
    assert report['uniqueUnderlyingPayments'] == 2000
    assert report['productionImplemented'] is False and report['accountingIntegrated'] is False
    assert report['databaseCalls'] == report['modelCalls'] == 0
    assert report['policyVersion'] == contract['policyVersion']
    payments = {p['id']: p for p in world['betalningar']}
    notices = {n['id']: n for n in public['notices']}
    assert len(notices) == len(public['notices']) == 2000
    assert len(report['baseline']) == len(report['runs']) == 2
    summaries, decisions = [], []
    for reverse, old in zip((False, True), report['baseline']):
        assert old['reverseWithinDay'] == reverse
        assert set(old['rows']) == set(payments)
        computed = Counter()
        for key, row in old['rows'].items():
            gold = payments[key]['facit']
            expected = {a['avi']: a['beloppOre'] for a in gold['allokeringar']}
            assert row['allocations'] == expected
            correct = bool(expected) and not gold['granskningKravsAvUnderlaget']
            assert row['correct'] == correct
            computed['correctAutomatic'] += correct
            computed['wrongAutomatic'] += bool(row['allocations']) and not correct
            computed['review'] += not bool(row['allocations'])
        assert dict(computed) == {'correctAutomatic': 1970, 'wrongAutomatic': 0, 'review': 30}
        for key, value in computed.items():
            assert old[key] == value
    assert report['baseline'][0]['rows'] == report['baseline'][1]['rows']
    for reverse, run in zip((False, True), report['runs']):
        assert run['reverseWithinDay'] == reverse
        order = sorted(payments, reverse=reverse)
        order.sort(key=lambda key: public['banks'][key]['date'])
        assert [r['bankEvent'] for r in run['rows']] == order
        debt = {key: n['debt'] for key, n in notices.items()}
        ledger, cases, deviations, stable = [], {}, [], {}
        counts = Counter()
        for row in run['rows']:
            key = row['bankEvent']
            bank = public['banks'][key]
            gold = payments[key]['facit']
            original = {a['avi']: a['beloppOre'] for a in gold['allokeringar']}
            override = contract['expectedOverrides'].get(key)
            expected = override['allocations'] if override else original
            assert row['organization'] == bank['org']
            assert row['allocations'] == expected, ('allocation', key)
            assert row['debtBefore'] == {n: debt[n] for n in expected}
            for n, amount in expected.items():
                assert type(amount) is int and 0 < amount <= debt[n]
                assert notices[n]['org'] == bank['org'] and notices[n]['issued'] <= bank['date']
                debt[n] -= amount
            assert row['debtAfter'] == {n: debt[n] for n in expected}
            held = 0
            if override:
                n = notices[gold['avseddAvi']]
                assert expected == {n['id']: n['debt']}
                held = bank['amount'] - sum(expected.values())
                assert held == override['creditOre'] == 2500
                assert override['creditOwner'] == {'organization': bank['org'], 'tenant': n['tenant'], 'lease': n['lease']}
                raw_key = json.dumps([contract['policyVersion'], bank['org'], key], ensure_ascii=False).encode()
                expected_credit = {'id': 'credit-' + sha(raw_key), 'org': bank['org'],
                    'tenant': n['tenant'], 'lease': n['lease'], 'bank_event': key, 'notice': n['id'],
                    'amount': held, 'created_on': bank['date'], 'policy': contract['policyVersion'],
                    'status': 'PENDING_HUMAN_REVIEW', 'pending_decisions': contract['creditPendingDecisions']}
                assert row['credit'] == expected_credit, ('credit', key)
                assert row['reason'] == 'ALLOKERAD_MED_TILLGODO_ATT_GRANSKA'
                ledger.append(expected_credit)
                ckey = f"credit:{bank['org']}:{n['tenant']}"
                case = cases.setdefault(ckey, {'kind': 'CREDIT_CUSTOMER', 'org': bank['org'],
                    'tenant': n['tenant'], 'bankEvents': [], 'creditOre': 0,
                    'pendingDecisions': contract['creditPendingDecisions']})
                case['bankEvents'].append(key)
                case['creditOre'] += held
            else:
                assert row['credit'] is None
                expected_reason = ('AUTOMATISK' if expected else
                    'IDENTITETSKONFLIKT' if payments[key]['typ'] == 'MOTSTRIDIGA_IDENTIFIERARE'
                    else 'OTILLRACKLIG_IDENTIFIERING')
                assert row['reason'] == expected_reason
            assert row['creditLedgerAfter'] == ledger
            unallocated = bank['amount'] - sum(expected.values()) - held
            assert type(unallocated) is int and unallocated >= 0
            assert row['unallocatedOre'] == unallocated
            assert row['symbolicFlowOre'] == {'BANK_IN': bank['amount'], 'NOTICE_SETTLEMENT': sum(expected.values()),
                                               'HELD_CREDIT': held, 'UNALLOCATED': unallocated}
            assert row['allocationReviewRequired'] == (not bool(expected))
            assert row['creditReviewRequired'] == bool(held)
            human = not bool(expected) or bool(held)
            assert row['humanReviewRequired'] == human
            if human and not held:
                cases['unresolved:' + key] = {'kind': 'UNRESOLVED_PAYMENT', 'bankEvents': [key],
                                             'tenant': None, 'reason': row['reason']}
            counts['correctAllocationPayments'] += bool(expected)
            counts['wrongAllocationPayments'] += 0
            counts['allocationReviewPayments'] += not bool(expected)
            counts['creditReviewPayments'] += bool(held)
            counts['humanReviewPayments'] += human
            counts['identityConflicts'] += row['reason'] == 'IDENTITETSKONFLIKT'
            counts['unidentifiedPayments'] += row['reason'] == 'OTILLRACKLIG_IDENTIFIERING'
            if row['allocations'] != original:
                deviations.append(key)
            stable[key] = {k: row[k] for k in ('reason', 'allocations', 'credit', 'humanReviewRequired')}
        assert run['finalCredits'] == ledger
        assert len({c['id'] for c in ledger}) == len(ledger)
        assert run['finalDebts'] == [{'org': n['org'], 'notice': n['id'], 'debtOre': debt[n['id']]} for n in public['notices']]
        assert run['reimport'] == {'events': 2000, 'duplicates': 2000, 'stateUnchanged': True}
        assert run['reviewCases'] == cases
        assert run['originalGoldDeviations'] == sorted(deviations) == sorted(contract['expectedOverrides'])
        assert run['originalGoldScoreOnNewBehavior'] == {'correctAutomatic': 1970,
                    'automaticContraryToOriginalGold': 10, 'unallocatedReviewPayments': 20}
        counts.update({'creditEntries': len(ledger), 'creditTotalOre': sum(c['amount'] for c in ledger),
            'creditOwners': len({(c['org'], c['tenant']) for c in ledger}),
            'knownCreditCustomerCases': sum(c['kind'] == 'CREDIT_CUSTOMER' for c in cases.values()),
            'unresolvedPaymentCases': sum(c['kind'] == 'UNRESOLVED_PAYMENT' for c in cases.values()),
            'reviewWorkItems': len(cases)})
        metrics = dict(counts)
        metrics['max20HumanReviewPayments'] = metrics['humanReviewPayments'] <= 20
        assert run['metrics'] == metrics == contract['expectedNewMetric']
        summaries.append({'reverseWithinDay': reverse, 'metrics': metrics,
            'allocationRows': sum(len(r['allocations']) for r in run['rows']),
            'allocatedOre': sum(sum(r['allocations'].values()) for r in run['rows']),
            'settledNotices': sum(value == 0 for value in debt.values()),
            'remainingDebtOre': sum(debt.values()),
            'unallocatedOre': sum(r['unallocatedOre'] for r in run['rows'])})
        decisions.append(stable)
    assert decisions[0] == decisions[1]
    assert report['runs'][0]['finalDebts'] == report['runs'][1]['finalDebts']
    assert sorted(report['runs'][0]['finalCredits'], key=lambda c: c['id']) == sorted(report['runs'][1]['finalCredits'], key=lambda c: c['id'])
    return {'passed': True, 'runs': summaries, 'decisionAndFinalStateOrderParity': True,
            'rowsChecked': 4000, 'uniquePayments': 2000,
            'databaseAtomicityVerified': False, 'realImportDedupVerified': False}


def negative_controls(report, public, world, contract):
    """Mutate only memory copies. Each corruption must fail the independent audit."""
    def credit_row(data):
        return next(r for r in data['runs'][0]['rows'] if r['credit'])
    def mutate(data, kind):
        row = credit_row(data)
        if kind == 'missing_ore': row['credit']['amount'] -= 1
        elif kind == 'wrong_owner': row['credit']['tenant'] = 'other-owner'
        elif kind == 'wrong_notice': row['allocations'] = {'wrong-notice': 977500}
        elif kind == 'duplicate_credit': data['runs'][0]['finalCredits'].append(deepcopy(row['credit']))
        elif kind == 'queue_as_success':
            target = next(r for r in data['runs'][0]['rows'] if not r['allocations'])
            target['reason'] = 'AUTOMATISK'
        elif kind == 'hidden_credit_review': row['humanReviewRequired'] = False
        elif kind == 'wrong_summary': data['runs'][0]['metrics']['humanReviewPayments'] = 20
        elif kind == 'missing_event': data['runs'][0]['rows'].pop()
        elif kind == 'spent_old_credit':
            target = next(r for r in data['runs'][0]['rows'] if len(r['creditLedgerAfter']) > 1)
            target['creditLedgerAfter'][0]['amount'] = 0
    results = []
    for kind in ('missing_ore', 'wrong_owner', 'wrong_notice', 'duplicate_credit', 'queue_as_success',
                 'hidden_credit_review', 'wrong_summary', 'missing_event', 'spent_old_credit'):
        altered = deepcopy(report)
        mutate(altered, kind)
        try:
            audit_data(altered, public, world, contract)
        except AssertionError:
            results.append({'mutation': kind, 'rejected': True})
        else:
            raise AssertionError('Auditor did not detect ' + kind)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    assert not args.output.exists(), 'Never overwrite previous evidence'
    report_path = args.directory / 'resultat.json.gz'
    report_bytes = gzip.decompress(report_path.read_bytes())
    report = json.loads(report_bytes)
    manifest = read_gz(args.directory / 'manifest.json')
    assert sha(report_bytes) == manifest['reportUncompressedSha256']
    assert len(report_bytes) == manifest['reportUncompressedBytes']
    assert manifest['sourceHashes'] == report['sourceHashes']
    for path, expected in report['sourceHashes'].items():
        assert sha((ROOT / path).read_bytes()) == expected, path
    public_bytes = gzip.decompress((args.directory / 'public-input.json.gz').read_bytes())
    assert sha(public_bytes) == manifest['publicInputUncompressedSha256'] == report['publicInputUncompressedSha256']
    source_dir = ROOT / 'docs/eval/kundflode-2000'
    source_manifest = read_gz(source_dir / 'manifest.json')
    for name in ('grund/kund-och-facit.json.gz', 'grund/AGENT_PA.json.gz'):
        assert sha(gzip.decompress((source_dir / name).read_bytes())) == source_manifest['filer'][name]['originalSha256']
    world = read_gz(source_dir / 'grund/kund-och-facit.json.gz')
    contract = read_gz(ROOT / 'docs/eval/overskottsprov/policy-v1.json')
    public = json.loads(public_bytes)
    result = audit_data(report, public, world, contract)
    result['negativeControls'] = negative_controls(report, public, world, contract)
    result['reportUncompressedSha256'] = sha(report_bytes)
    result['auditorSha256'] = sha(Path(__file__).read_bytes())
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
