"""Independent stdlib-only recount; does not import the server/SQL/decision code."""
import argparse
import copy
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def audit(report):
    policy = json.loads((ROOT/'docs/eval/kundklarlaggning/policy-v1.json').read_text())
    s = report['snapshot']
    cases = {c['id']: c for c in s['cf_case']}
    assert len(cases) == len(s['cf_case']) == 33
    raw = json.loads(gzip.decompress((ROOT/'docs/eval/overskottsprov/korning-1/public-input.json.gz').read_bytes()))['banks']
    a_ids = {f'betalning-{tenant}-{month}' for tenant in (56,58) for month in range(10)}
    assert set(cases) == a_ids | set(policy['B']['expectations'])
    for k in a_ids:
        assert cases[k]['bank'] == raw[k] and cases[k]['attestation'] is None
        assert cases[k]['status'] == 'STAFF_NO_RECIPIENT' and cases[k]['recipient'] is None
        assert cases[k]['conflict'] == k.startswith('betalning-58-')
    for k, status in policy['B']['expectations'].items():
        assert cases[k]['status'] == status
    assert not any(x['event'] in a_ids for t in ('cf_invitation','cf_outbox') for x in s[t])
    expected = {'B-full': {'B-full-avi-1': 10000}, 'B-partial': {'B-partial-avi-1':4000},
                'B-combined': {'B-combined-avi-1':10000,'B-combined-avi-2':4000},
                'B-credit': {'B-credit-avi-1':10000}}
    assert {b['id'] for b in s['bank']} == set(expected) and len(s['bank']) == 4
    assert len(s['allocation']) == 5 and len(s['credit']) == 1 and not s['credit_use']
    actual = {}
    notices = {n['id']: n for n in s['notice']}
    for a in s['allocation']:
        assert a['org'] == 'syntetisk' and not a['reversed'] and type(a['amount']) is int
        actual.setdefault(a['bank_event'], {})[a['notice']] = a['amount']
        n = notices[a['notice']]
        assert n['org'] == a['org'] and n['tenant'] == 'alice-tenant' and n['lease'] == a['bank_event']+'-home'
    assert actual == expected
    cr = s['credit'][0]
    assert (cr['org'],cr['tenant'],cr['lease'],cr['bank_event'],cr['source_notice']) == (
        'syntetisk','alice-tenant','B-credit-home','B-credit','B-credit-avi-1')
    assert cr['total'] == cr['remaining'] == 2500 and cr['target'] is None and not cr['reversed']
    bank_sum = allocated = 0
    vouchers = {v['id']: v for v in s['voucher']}
    assert len(vouchers) == len(s['voucher']) == len(notices) + 4
    for b in s['bank']:
        assert b['org'] == 'syntetisk' and b['payload'] == cases[b['id']]['bank']
        assert b['amount'] == b['payload']['amount'] and b['status'] == 'ALLOCATED'
        amount = sum(expected[b['id']].values())
        assert b['amount'] == amount + (2500 if b['id'] == 'B-credit' else 0)
        lines = [['TEST_BANK', b['amount'], 0], ['TEST_RECEIVABLE', 0, amount]]
        if b['id'] == 'B-credit':
            lines.append(['TEST_CREDIT',0,2500])
        assert vouchers['bank:'+b['id']]['lines'] == lines
        bank_sum += b['amount']; allocated += amount
    for n in notices.values():
        applied = sum(a['amount'] for a in s['allocation'] if a['notice'] == n['id'])
        # Explicit negative-test injection, not another booked payment.
        injected = 1 if n['id'] == 'B-debt-changed-avi-1' else 0
        assert n['debt'] == n['gross'] - applied - injected
        assert vouchers['issue:'+n['id']]['lines'] == [['TEST_RECEIVABLE',n['gross'],0],['TEST_RENT',0,n['gross']]]
    for v in vouchers.values():
        assert all(type(x[1]) is int and type(x[2]) is int and x[0].startswith('TEST_') for x in v['lines'])
        assert sum(x[1]-x[2] for x in v['lines']) == 0
    invitations = {i['event']: i for i in s['cf_invitation']}
    attestations = {a['id']: a for a in s['cf_attestation']}
    for k, c in cases.items():
        trail = sorted((a for a in s['cf_audit'] if a['event'] == k), key=lambda a:a['seq'])
        previous = 'IMPORTED'
        for a in trail:
            assert a['org'] == c['org'] and a['previous'] == previous and a['at']
            previous = a['status']
        assert previous == c['status']
        if k in expected:
            i = invitations[k]; e = attestations[c['attestation']]
            assert i['consumed'] and i['person'] == e['person'] == 'alice'
            assert i['payload']['allocations'] == expected[k] and i['result']['status'] == c['status']
            assert e['bank'] == c['bank'] and e['event'] == k and e['org'] == c['org']
            assert e['authority'] and e['source'] == 'SIMULATED_INDEPENDENT_ATTESTOR' and not e['revoked']
            assert trail[-1]['evidence']['answer'] == i['payload'] and trail[-1]['actor'] == i['person']
            assert not c['conflict']
        if c['status'] == 'RESOLVED_CUSTOMER':
            assert k in expected and k != 'B-credit'
    def counts(ids):
        states = [cases[k]['status'] for k in ids]
        return {'cases': len(states), 'automaticWithoutHuman': 0,
                'resolvedWithCustomer': states.count('RESOLVED_CUSTOMER'),
                'staffRequired': sum(x.startswith('STAFF_') for x in states),
                'waitingUnresolved': sum(x in ('WAITING','DRAFT') for x in states)}
    result = {'A': counts(a_ids), 'B': counts(set(expected)|set(policy['B']['expectations'])),
              'bankOre':bank_sum,'allocatedOre':allocated,'outstandingCreditOre':cr['remaining'],
              'allocationRows':len(s['allocation']),'ledgerBankPayments':len(s['bank']),
              'balancedTestVouchers':len(vouchers), 'wrongDecisionsAgainstFrozenContract':0}
    for group in ('A','B'):
        for key, value in result[group].items():
            assert value == policy[group][key], (group,key,value)
    assert bank_sum == 40500 and allocated == 38000
    return result


def negative_controls(report):
    mutations = {
        'false_original_completion': lambda s:[c.update(status='RESOLVED_CUSTOMER') for c in s['cf_case'] if c['id']=='betalning-56-0'],
        'lost_ore': lambda s:s['allocation'][0].update(amount=s['allocation'][0]['amount']-1),
        'wrong_lease': lambda s:s['credit'][0].update(lease='B-full-home'),
        'hidden_credit': lambda s:s['credit'].clear(),
        'unbalanced_voucher': lambda s:s['voucher'][0]['lines'][0].__setitem__(1,1),
        'missing_authority': lambda s:[a.update(authority=False) for a in s['cf_attestation'] if a['id']=='proof:B-full'],
        'missing_audit': lambda s:s['cf_audit'].clear(),
        'altered_original_bank': lambda s:[c['bank'].update(reference='INVENTED') for c in s['cf_case'] if c['id']=='betalning-56-0'],
    }
    for name, mutate in mutations.items():
        changed = copy.deepcopy(report); mutate(changed['snapshot'])
        try:
            audit(changed)
        except AssertionError:
            continue
        raise AssertionError('Uncaught negative control: '+name)
    return list(mutations)


def main():
    p=argparse.ArgumentParser();p.add_argument('report', type=Path);a=p.parse_args()
    report=json.loads(gzip.decompress(a.report.read_bytes()))
    for path, digest in report['sourceHashes'].items():
        assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==digest,path
    print(json.dumps({'recount':audit(report),'rejectedMutations':negative_controls(report)},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
