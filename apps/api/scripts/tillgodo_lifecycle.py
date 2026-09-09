"""Proposed policy only. Public Bank/Notice inputs; no gold/scenario imports.

This Python state is a reference model. PostgreSQL execution is separate and
must independently validate each proposed operation. No production accounts.
"""
from dataclasses import asdict, replace

from referensprov_policy import decide
from overskottsprov_policy import decide_surplus

VERSION = 'tillgodo-livscykel-v1'


def scope(n):
    return (n.org, n.tenant, n.lease)


def period(n):
    return n.year * 12 + n.month - 1


class Lifecycle:
    def __init__(self, notices, controls=None):
        self.notices = {n.id: n for n in notices}
        self.original = dict(self.notices)
        self.controls = {scope(n): {'active': True, 'consent': True, 'refund': False} for n in notices}
        if controls:
            self.controls.update(controls)
        self.issued = {}
        self.credits = {}
        self.rows = {}
        self.operations = []

    def issue(self, key):
        n = self.notices[key]
        if key in self.issued:
            raise ValueError('ALREADY_ISSUED')
        uses = []
        remaining = n.debt
        control = self.controls[scope(n)]
        for credit in self.credits.values():
            if (credit['target'] == key and credit['remaining'] > 0 and
                    (credit['org'], credit['tenant'], credit['lease']) == scope(n) and
                    control['active'] and control['consent'] and not control['refund']):
                amount = min(credit['remaining'], remaining)
                if amount:
                    uses.append({'credit': credit['id'], 'amount': amount})
                    credit['remaining'] -= amount
                    remaining -= amount
        self.notices[key] = replace(n, debt=remaining)
        self.issued[key] = {'gross': n.debt, 'deduction': n.debt-remaining, 'due': remaining,
                            'date': n.issued, 'uses': uses}
        self.operations.append({'kind': 'ISSUE', 'id': 'issue:'+key, 'org': n.org,
            'notice': key, 'date': n.issued, 'uses': uses})

    def issue_through(self, date):
        for n in sorted(self.notices.values(), key=lambda n: (n.issued, n.id)):
            if n.issued <= date and n.id not in self.issued:
                self.issue(n.id)

    def pay(self, event, bank):
        if event in self.rows:
            if self.rows[event]['bank'] != asdict(bank):
                raise ValueError('PAYLOAD_CONFLICT')
            return self.rows[event]
        notes = tuple(self.notices.values())
        first = decide(bank, notes)
        result = decide_surplus(event, bank, notes) if first.reason == 'OVERSKOTT_KRAVER_HANTERING' else first
        allocations = dict(result.allocations)
        credit = None
        for key, amount in allocations.items():
            n = self.notices[key]
            assert key in self.issued and n.org == bank.org and 0 < amount <= n.debt
            self.notices[key] = replace(n, debt=n.debt-amount)
        surplus = bank.amount-sum(allocations.values()) if allocations else 0
        if surplus:
            assert len(allocations) == 1
            n = self.notices[next(iter(allocations))]
            next_notes = [candidate for candidate in self.original.values()
                          if scope(candidate) == scope(n) and period(candidate) == period(n)+1]
            target = next_notes[0] if len(next_notes) == 1 else None
            eligible = target is not None and target.id not in self.issued and bank.date[:10] < target.issued
            credit = {'id': 'credit:'+event, 'org': bank.org, 'tenant': n.tenant,
                'lease': n.lease, 'bank_event': event, 'source_notice': n.id,
                'created': surplus, 'remaining': surplus, 'date': bank.date[:10],
                'target': target.id if eligible else None,
                'pending_reason': 'NEXT_NOTICE' if eligible else 'MISSING_AMBIGUOUS_OR_ALREADY_ISSUED'}
            self.credits[credit['id']] = credit
        row = {'bank': asdict(bank), 'reason': result.reason, 'allocations': allocations,
               'credit': credit['id'] if credit else None,
               'credit_created': surplus, 'unallocated': bank.amount-sum(allocations.values())-surplus}
        self.rows[event] = row
        self.operations.append({'kind': 'PAYMENT', 'id': 'bank:'+event, 'org': bank.org,
            'event': event, 'bank': asdict(bank), 'allocations': allocations,
            'credit': dict(credit) if credit else None})
        return row

    def snapshot(self):
        return {'rows': self.rows, 'credits': self.credits, 'issued': self.issued,
                'debts': {key: n.debt for key,n in self.notices.items()},
                'operations': self.operations}
