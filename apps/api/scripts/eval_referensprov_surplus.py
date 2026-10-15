"""Test a proposed HOLD policy separately from the unchanged original gold.

No real funds, bank, accounting, DB or model calls. Ten open surplus obligations
remain open; this script must not call them finally resolved to pass max-20.
"""
import argparse
from collections import Counter
from dataclasses import asdict
import hashlib
import json
from pathlib import Path

from eval_referensprov import SOURCE, load_verified, project
from referensprov_ledger import SimulationLedger


def replay_holding(world, saved, reverse=False):
    notices, banks, changed = project(world, saved, False)
    assert not changed
    source_rows = {row['id']: row['bankrad'] for row in saved['rader']}
    ledger = SimulationLedger(notices)
    order = sorted(banks, reverse=reverse)
    order.sort(key=lambda key: banks[key].date)
    rows = {}
    for key in order:
        bank = banks[key]
        source = source_rows[key]
        receipt = ledger.process(source['id'], key, bank)
        rows[key] = asdict(receipt)
        rows[key]['originalSavedBankRow'] = source
    before_replay = ledger.verify()
    for key in reversed(order):
        ledger.process(source_rows[key]['id'], key, banks[key])
    assert ledger.verify() == before_replay
    assert len(ledger.receipts) == len(banks) == 2000

    # Evaluation boundary: neither scenario labels nor either gold are available
    # to decide/process. This policy extension is expressly NOT the old gold.
    notice_by_id = {n.id: n for n in notices}
    counts = Counter()
    by_type = {}
    for p in world['betalningar']:
        row = rows[p['id']]
        d, hold = row['decision'], row['hold']
        allocated = dict(d['allocations'])
        old = {a['avi']: a['beloppOre'] for a in p['facit']['allokeringar']}
        original_pass = bool(allocated) and not p['facit']['granskningKravsAvUnderlaget'] and allocated == old and not hold
        counts['strictOriginalGoldCorrect'] += original_pass
        counts['strictOriginalGoldDeviations'] += bool(allocated) and not original_pass
        expected_hold = 0
        if p['typ'] == 'OVERBETALNING':
            target = notice_by_id[p['facit']['avseddAvi']]
            expected = {target.id: target.debt}
            expected_hold = p['beloppOre'] - target.debt
            assert expected_hold > 0
            valid = allocated == expected and hold is not None
            if valid:
                valid = (hold['amount'], hold['org'], hold['tenant'], hold['lease'],
                         hold['notice_id'], hold['source_bank_id'], hold['fixture_id'], hold['status']) == (
                         expected_hold, banks[p['id']].org, target.tenant, target.lease,
                         target.id, source_rows[p['id']]['id'], p['id'], 'HELD_PENDING_DISPOSITION')
            valid = valid and row['unresolved'] == 0
        else:
            expected = old
            valid = allocated == expected and hold is None
            valid = valid and row['unresolved'] == (0 if expected else p['beloppOre'])
        counts['unexpectedDecisionsUnderHoldingProposal'] += not valid
        counts['automaticAccountedUnderProposal'] += valid and bool(allocated)
        counts['identificationReview'] += not allocated
        counts['openSurplusDispositions'] += hold is not None
        counts['heldOre'] += d['held_surplus']
        group = by_type.setdefault(p['typ'], Counter())
        group['total'] += 1
        group['proposalPass'] += valid
        row['strictOriginalGoldPass'] = original_pass
        row['holdingProposalPass'] = valid
        row['holdingProposalExpected'] = {'allocations': expected, 'heldOre': expected_hold}
    assert counts['unexpectedDecisionsUnderHoldingProposal'] == 0
    assert counts['heldOre'] == before_replay['heldOre']
    assert counts['heldOre'] == 25000 and counts['openSurplusDispositions'] == 10
    return {'reverseWithinDay': reverse, 'total': 2000, **counts,
            'fullyResolved': counts['strictOriginalGoldCorrect'],
            'paymentsWithRemainingObligations': counts['identificationReview'] + counts['openSurplusDispositions'],
            'originalMax20Passed': counts['identificationReview'] + counts['openSurplusDispositions'] <= 20,
            'moneyConservation': before_replay, 'identicalReplayCount': 2000,
            'byType': by_type, 'rows': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Existing evidence must not be overwritten')
    world = load_verified('grund/kund-och-facit.json.gz')
    saved = load_verified('grund/AGENT_PA.json.gz')
    runs = [replay_holding(world, saved, reverse) for reverse in (False, True)]
    assert runs[0]['rows'] == runs[1]['rows']
    report = {
        'kind': 'OFFLINE_PROPOSED_HOLD_POLICY', 'productionImplemented': False,
        'modelCalls': 0, 'databaseCalls': 0, 'modelFeesSEK': 0,
        'uniqueUnderlyingPayments': 2000, 'bankInputsChanged': 0,
        'originalGoldChanged': False, 'independentRealCustomerEvidence': False,
        'limitations': [
            'Holding is an experimental disposition proposal, not an implemented accounting liability.',
            'An open hold is not a finally resolved payment, refund or usable credit.',
            'Pure in-memory sequential replay; no persistence, concurrency or bank reimport integration.',
            'Original bank UUID and saved derived rawOcr retained; input reference reconstructed from original CSV generation.',
            'No field-frequency estimates, general language understanding, legal or accounting approval.',
        ],
        'sourceHashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (
            Path(__file__), Path(__file__).with_name('referensprov_ledger.py'),
            Path(__file__).with_name('referensprov_policy.py'),
            Path(__file__).with_name('eval_referensprov.py'), SOURCE / 'manifest.json')},
        'runs': runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    for r in runs:
        print(json.dumps({k: v for k, v in r.items() if k not in ('rows', 'byType')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
