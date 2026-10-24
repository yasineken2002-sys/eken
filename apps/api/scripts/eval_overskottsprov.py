"""Reproducible offline replay. Policy receives only projected public inputs."""
import argparse
from collections import Counter
from dataclasses import asdict
import gzip
import hashlib
import json
from pathlib import Path

from eval_referensprov import load_verified, project, replay as baseline_replay
from overskottsprov_policy import State, apply_event, VERSION

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = ROOT / 'docs/eval/overskottsprov'


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def project_public(world, saved):
    # Whitelist BEFORE entering the old projection. Neither scenario nor gold
    # can be read, even accidentally. unique=False preserves #869 bank inputs.
    clean = {
        'betalningar': [{k: p[k] for k in ('id', 'datum', 'beloppOre', 'text',
                        'ocrFranHyresgast', 'felskrivOcr')} for p in world['betalningar']],
        'hyresgaster': [{k: t[k] for k in ('index', 'fornamn', 'efternamn')}
                       for t in world['hyresgaster']],
        'avier': [{k: n[k] for k in ('id', 'hyresgast', 'nummer', 'year', 'month',
                  'forfallodatum', 'beloppOre', 'period')} for n in world['avier']],
    }
    notices, banks, changed = project(clean, saved, False)
    assert not changed
    return tuple(notices), banks


def replay_public(notices, banks, reverse):
    state = State(notices)
    order = sorted(banks, reverse=reverse)
    order.sort(key=lambda key: banks[key].date)
    rows = []
    for event in order:
        bank = banks[event]
        before = {(n.org, n.id): n.debt for n in state.notices}
        state, outcome, duplicate = apply_event(state, event, bank)
        assert not duplicate
        allocations = dict(outcome.allocations)
        credit = asdict(outcome.credit) if outcome.credit else None
        allocated = sum(allocations.values())
        held = credit['amount'] if credit else 0
        unallocated = bank.amount - allocated - held
        rows.append({
            'bankEvent': event, 'organization': bank.org, 'reason': outcome.reason,
            'allocations': allocations, 'credit': credit,
            'debtBefore': {key: before[(bank.org, key)] for key in allocations},
            'debtAfter': {key: before[(bank.org, key)] - value for key, value in allocations.items()},
            'creditLedgerAfter': [asdict(c) for c in state.credits],
            'allocationReviewRequired': outcome.allocation_review,
            'creditReviewRequired': credit is not None,
            'humanReviewRequired': outcome.human_review,
            'unallocatedOre': unallocated,
            # Arithmetic roles, NOT accounts, journals or accounting integration.
            'symbolicFlowOre': {'BANK_IN': bank.amount, 'NOTICE_SETTLEMENT': allocated,
                                'HELD_CREDIT': held, 'UNALLOCATED': unallocated},
        })
    # Replay/reimport the complete history against final debt AND credit state.
    # stable synthetic event IDs, not production bank import identities.
    after_first_pass = state
    for event in order:
        state, _, duplicate = apply_event(state, event, banks[event])
        assert duplicate and state is after_first_pass
    return {'reverseWithinDay': reverse, 'rows': rows,
            'finalDebts': [{'org': n.org, 'notice': n.id, 'debtOre': n.debt} for n in state.notices],
            'finalCredits': [asdict(c) for c in state.credits],
            'reimport': {'events': len(order), 'duplicates': len(order), 'stateUnchanged': True}}


def score(run, world, contract):
    # Gold and overrides enter AFTER the whole public replay has completed.
    payments = {p['id']: p for p in world['betalningar']}
    counts = Counter()
    cases = {}
    deviations = []
    for row in run['rows']:
        event = row['bankEvent']
        p = payments[event]
        original = {a['avi']: a['beloppOre'] for a in p['facit']['allokeringar']}
        expected = contract['expectedOverrides'].get(event, {'allocations': original, 'creditOre': 0})
        actual_credit = row['credit']['amount'] if row['credit'] else 0
        correct = row['allocations'] == expected['allocations'] and actual_credit == expected['creditOre']
        counts['correctAllocationPayments'] += bool(row['allocations']) and correct
        counts['wrongAllocationPayments'] += bool(row['allocations']) and not correct
        counts['allocationReviewPayments'] += row['allocationReviewRequired']
        counts['creditReviewPayments'] += row['creditReviewRequired']
        counts['humanReviewPayments'] += row['humanReviewRequired']
        counts['identityConflicts'] += row['reason'] == 'IDENTITETSKONFLIKT'
        counts['unidentifiedPayments'] += row['reason'] == 'OTILLRACKLIG_IDENTIFIERING'
        if row['credit']:
            c = row['credit']
            key = f"credit:{c['org']}:{c['tenant']}"
            case = cases.setdefault(key, {'kind': 'CREDIT_CUSTOMER', 'org': c['org'],
                       'tenant': c['tenant'], 'bankEvents': [], 'creditOre': 0,
                       'pendingDecisions': c['pending_decisions']})
            case['bankEvents'].append(event)
            case['creditOre'] += c['amount']
        elif row['humanReviewRequired']:
            cases['unresolved:' + event] = {'kind': 'UNRESOLVED_PAYMENT', 'bankEvents': [event],
                'tenant': None, 'reason': row['reason']}
        if row['allocations'] != original or (row['allocations'] and p['facit']['granskningKravsAvUnderlaget']):
            deviations.append(event)
    counts.update({
        'creditEntries': len(run['finalCredits']),
        'creditTotalOre': sum(c['amount'] for c in run['finalCredits']),
        'creditOwners': len({(c['org'], c['tenant']) for c in run['finalCredits']}),
        'knownCreditCustomerCases': sum(c['kind'] == 'CREDIT_CUSTOMER' for c in cases.values()),
        'unresolvedPaymentCases': sum(c['kind'] == 'UNRESOLVED_PAYMENT' for c in cases.values()),
        'reviewWorkItems': len(cases),
    })
    metrics = dict(counts)
    metrics['max20HumanReviewPayments'] = counts['humanReviewPayments'] <= 20
    run['metrics'] = metrics
    run['reviewCases'] = cases
    run['originalGoldDeviations'] = sorted(deviations)
    run['originalGoldScoreOnNewBehavior'] = {
        'correctAutomatic': counts['correctAllocationPayments'] - len(deviations),
        'automaticContraryToOriginalGold': len(deviations),
        'unallocatedReviewPayments': counts['allocationReviewPayments'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    world = load_verified('grund/kund-och-facit.json.gz')
    saved = load_verified('grund/AGENT_PA.json.gz')
    contract = json.loads((ARTIFACTS / 'policy-v1.json').read_text())
    notices, banks = project_public(world, saved)
    public = {'notices': [asdict(n) for n in notices],
              'banks': {key: asdict(value) for key, value in banks.items()}}
    public_bytes = encoded(public)
    (args.output / 'public-input.json.gz').write_bytes(gzip.compress(public_bytes, mtime=0))
    runs, baseline = [], []
    for reverse in (False, True):
        old = baseline_replay(world, saved, 'REFERENS_OCH_PERIOD', reverse)
        baseline.append(old)
        print('Baseline', reverse, old['correctAutomatic'], old['wrongAutomatic'], old['review'], flush=True)
        run = replay_public(notices, banks, reverse)
        score(run, world, contract)
        runs.append(run)
        print('Experiment', reverse, json.dumps(run['metrics'], ensure_ascii=False), flush=True)
    paths = [Path(__file__).relative_to(ROOT),
             Path('apps/api/scripts/overskottsprov_policy.py'),
             Path('apps/api/scripts/test_overskottsprov.py'),
             Path('apps/api/scripts/audit_overskottsprov.py'),
             Path('apps/api/scripts/referensprov_policy.py'),
             Path('apps/api/scripts/eval_referensprov.py'),
             Path('apps/api/scripts/test_referensprov.py'),
             Path('docs/eval/overskottsprov/policy-v1.json'),
             Path('docs/eval/kundflode-2000/manifest.json'),
             Path('docs/eval/kundflode-2000/grund/kund-och-facit.json.gz'),
             Path('docs/eval/kundflode-2000/grund/AGENT_PA.json.gz')]
    report = {'kind': 'OFFLINE_SURPLUS_SIMULATION', 'policyVersion': VERSION,
              'productionImplemented': False, 'accountingIntegrated': False,
              'databaseCalls': 0, 'modelCalls': 0, 'uniqueUnderlyingPayments': 2000,
              'sourceHashes': {str(p): digest((ROOT / p).read_bytes()) for p in paths},
              'publicInputUncompressedSha256': digest(public_bytes),
              'baseline': baseline, 'runs': runs,
              'limitations': ['Immutable single-process memory atomicity only; no database locks or durability.',
                              'Reimport dedup assumes stable synthetic organization/event ID.',
                              'Same #869 public input projection, no unique-OCR variant or bank input edits.',
                              'Credit still needs human review and economic handling; no accounts or journals.',
                              'Frozen synthetic mix, no 99.98 percent production evidence.']}
    payload = encoded(report)
    (args.output / 'resultat.json.gz').write_bytes(gzip.compress(payload, mtime=0))
    (args.output / 'manifest.json').write_bytes(encoded({
        'reportUncompressedSha256': digest(payload),
        'reportUncompressedBytes': len(payload),
        'publicInputUncompressedSha256': digest(public_bytes),
        'sourceHashes': report['sourceHashes'],
    }))


if __name__ == '__main__':
    main()
