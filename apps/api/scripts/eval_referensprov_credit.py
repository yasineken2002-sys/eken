"""Persisted SQLite lifecycle replay. No real customer, accounting or bank APIs.

The original cash inputs remain unchanged. A separately labelled synthetic
closure adds a lease end, test bank verification and test refund settlement.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sqlite3

from eval_referensprov import SOURCE, load_verified, project
from referensprov_credit import CreditStore


def financial_snapshot(store):
    return {k: v for k, v in store.snapshot().items() if k != 'events'}


def replay(world, saved, path, reverse):
    notices, banks, changed = project(world, saved, False)
    assert not changed
    source = {r['id']: r['bankrad'] for r in saved['rader']}
    # Public payer input is reconstructed from the frozen fixture, not copied
    # blindly from the legacy parser's derived rawOcr (which can contain a year).
    reference_differences = [key for key in sorted(banks)
                             if (source[key]['rawOcr'] or '') != banks[key].reference]
    assert len(reference_differences) == 168
    assert all(source[key]['rawOcr'] == '2026' and banks[key].reference == ''
               for key in reference_differences)
    store = CreditStore(path)
    for tenant in world['hyresgaster']:
        i = str(tenant['index'])
        store.register_lease('enable-test-policy-' + i, 'syntetisk', i, 'avtal-' + i, True)
    order = sorted(banks, reverse=reverse)
    order.sort(key=lambda key: banks[key].date)
    pending = sorted(notices, key=lambda n: (n.issued, n.id))
    rows, monthly = {}, []
    for key in order:
        bank = banks[key]
        while pending and pending[0].issued <= bank.date:
            n = pending.pop(0)
            store.issue('issue-' + n.id, n)
            store.apply_credit('carry-' + n.id, n.org, n.id, n.issued)
        result = store.ingest('bank-' + key, source[key]['id'], key, bank)
        rows[key] = {'sourceBankId': source[key]['id'], 'bank': asdict(bank), 'decision': result}
    before_replay = financial_snapshot(store)
    before_totals = store.verify()
    for key in reversed(order):
        assert store.ingest('bank-' + key, source[key]['id'], key, banks[key]) == rows[key]['decision']
    assert before_replay == financial_snapshot(store)
    store.close()
    store = CreditStore(path)
    assert before_replay == financial_snapshot(store)
    assert before_totals == store.verify()

    # All ground-truth/scenario access starts after ingestion has finished.
    correct_original = original_deviations = review = 0
    for p in world['betalningar']:
        d = rows[p['id']]['decision']
        allocations = dict(d['allocations'])
        old = {a['avi']: a['beloppOre'] for a in p['facit']['allokeringar']}
        passed = bool(allocations) and not p['facit']['granskningKravsAvUnderlaget'] and allocations == old and not d['held_surplus']
        correct_original += passed
        original_deviations += bool(allocations) and not passed
        review += not allocations
        if p['typ'] == 'OVERBETALNING':
            # Independent closed-form expectation for the unchanged frozen cash:
            # each month adds 2500; credit forwarded is not cash disappearing.
            n = next(n for n in notices if n.id == p['facit']['avseddAvi'])
            expected_credit = p['period'] * 2500
            expected_cash_allocation = n.debt - expected_credit
            expected_new_surplus = (p['period'] + 1) * 2500
            assert allocations == {n.id: expected_cash_allocation}
            assert d['held_surplus'] == expected_new_surplus
            monthly.append({'fixtureId': p['id'], 'period': p['period'],
                            'previousCreditAppliedOre': expected_credit,
                            'cashAllocatedOre': expected_cash_allocation,
                            'newSurplusOre': d['held_surplus']})
        else:
            assert allocations == old and not d['held_surplus']
    lots = before_replay['lots']
    remaining = [l for l in lots if l['original'] > l['applied'] + l['refunded']]
    assert (correct_original, original_deviations, review) == (1970, 10, 20)
    assert len(lots) == 10 and len(remaining) == 1
    totals = store.verify()['syntetisk']
    assert totals['liabilityOre'] == 25000 and totals['creditAppliedOre'] == 112500
    assert sum(l['original'] for l in lots) == 137500
    report = {'reverseWithinDay': reverse, 'changedPayerInputCount': len(changed),
              'legacyParsedRawOcrDifferenceCount': len(reference_differences),
              'legacyParsedRawOcrDifferenceFixtureIds': reference_differences,
              'originalGoldCorrect': correct_original, 'originalGoldPolicyDeviations': original_deviations,
              'identificationReviews': review, 'remainingSourceCreditLots': len(remaining),
              'consumedSourceCreditLots': len(lots) - len(remaining),
              'economicSurplusObligationsEliminated': False,
              'originalMax20Proven': False, 'productionPrecisionProven': False,
              'totals': totals, 'grossCreditCreatedOre': sum(l['original'] for l in lots),
              'monthlySurplusProgression': sorted(monthly, key=lambda m: m['period']),
              'allOriginalBankPaymentsReplayedWithoutEffects': True, 'reopenPreservedState': True,
              'rows': rows, 'financialSnapshot': before_replay}
    store.close()
    return report


def synthetic_closed_lease(original_db, scenario_db):
    source = sqlite3.connect(str(original_db))
    target = sqlite3.connect(str(scenario_db))
    source.backup(target)
    target.close()
    source.close()
    store = CreditStore(scenario_db)
    before = store.verify()
    remaining = [l for l in store.snapshot()['lots'] if l['original'] > l['applied'] + l['refunded']]
    assert len(remaining) == 1
    lot = remaining[0]
    org, source_id = lot['org'], lot['source_bank_id']
    at = '2026-08-01T12:00:00.000Z'
    store.close_lease('synthetic-lease-end', org, lot['lease'], at)
    store.verify_return_account('synthetic-verified-source-account', org, source_id,
                                'TEST_ONLY_SOURCE_BOUND_ACCOUNT', 'TEST_ONLY_BANK_VERIFICATION')
    request = store.request_refund('synthetic-refund-request', org, source_id, 25000,
                                   'TEST_ONLY_SOURCE_BOUND_ACCOUNT', at)
    pending = store.verify()
    assert pending[org]['liabilityOre'] == pending[org]['reservedOre'] == 25000
    assert pending[org]['refundedOre'] == 0
    settled = store.confirm_refund('synthetic-bank-settled', org, request['refund_id'],
                                   'TEST_ONLY_SETTLEMENT_250KR', 25000, 'TEST_ONLY_SOURCE_BOUND_ACCOUNT', at)
    snapshot = store.snapshot()
    assert store.confirm_refund('synthetic-bank-settled', org, request['refund_id'],
                                'TEST_ONLY_SETTLEMENT_250KR', 25000, 'TEST_ONLY_SOURCE_BOUND_ACCOUNT', at) == settled
    assert store.snapshot() == snapshot
    final = store.verify()
    assert final[org]['liabilityOre'] == final[org]['reservedOre'] == 0
    assert final[org]['refundedOre'] == 25000
    store.close()
    return {'kind': 'ADDITIONAL_SYNTHETIC_CLOSURE_SCENARIO',
            'addedInputs': ['Assumed lease termination', 'Test source-bound verified return account',
                            'Test confirmed outgoing bank settlement of 25000 ore'],
            'realBankTransfer': False, 'realAccountVerification': False,
            'before': before, 'pending': pending, 'afterTestSettlement': final,
            'settlement': settled, 'financialSnapshot': snapshot,
            'remainingIdentificationReviews': 20,
            'originalDatasetMax20Proven': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output_directory', type=Path)
    args = parser.parse_args()
    if args.output_directory.exists():
        raise SystemExit('Existing experiment directory must not be overwritten')
    args.output_directory.mkdir(parents=True)
    world = load_verified('grund/kund-och-facit.json.gz')
    saved = load_verified('grund/AGENT_PA.json.gz')
    runs = []
    for reverse in (False, True):
        name = 'reverse.sqlite' if reverse else 'forward.sqlite'
        run = replay(world, saved, args.output_directory / name, reverse)
        runs.append(run)
        print(json.dumps({k: v for k, v in run.items() if k not in ('rows','financialSnapshot','monthlySurplusProgression')}, ensure_ascii=False), flush=True)
    assert runs[0]['rows'] == runs[1]['rows']
    assert runs[0]['financialSnapshot'] == runs[1]['financialSnapshot']
    closure = synthetic_closed_lease(args.output_directory / 'forward.sqlite', args.output_directory / 'synthetic-closure.sqlite')
    report = {'kind': 'ISOLATED_SQLITE_CREDIT_LIFECYCLE', 'currency': 'SEK',
              'sqliteVersion': sqlite3.sqlite_version, 'productionAccountingExecuted': False,
              'modelCalls': 0, 'modelFeesSEK': 0, 'realBankCalls': 0,
              'uniqueUnderlyingPayments': 2000, 'originalGoldChanged': False,
              'policyAssumption': 'Carry-forward explicitly enabled in each synthetic lease; no customer authorization measured.',
              'inputProjection': 'Payer OCR reconstructed from frozen ocrFranHyresgast; 168 legacy rawOcr year extractions (2026) are empty references here. Cash, date, text and source bank ID are unchanged. This is not a replay of the complete production bank importer.',
              'limitations': ['SQLite transaction/journal prototype, not PostgreSQL or production ledger integration.',
                              'Symbolic test account buckets, no approved production account mapping or period-close policy.',
                              'One RENT notice per lease/month, SEK only; no fees, interest, credit notes, cancellations or legal conclusions.',
                              'External settlement and return verification are synthetic inputs, not real bank evidence.',
                              'Original fixture contains no lease end or recipient account; closure scenario adds them explicitly.'],
              'sourceHashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (
                  Path(__file__), Path(__file__).with_name('referensprov_credit.py'),
                  Path(__file__).with_name('referensprov_policy.py'), Path(__file__).with_name('eval_referensprov.py'), SOURCE/'manifest.json')},
              'runs': runs, 'syntheticClosure': closure}
    (args.output_directory/'resultat.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'syntheticClosureLiabilityOre': closure['afterTestSettlement']['syntetisk']['liabilityOre'],
                      'syntheticRefundOre': 25000, 'realBankTransfer': False, 'originalMax20Proven': False}), flush=True)


if __name__ == '__main__':
    main()
