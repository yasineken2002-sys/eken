"""In-memory experiment only; NOT a customer credit ledger or accounting service.

Holds remain obligations awaiting disposition. They are never spent, refunded or
counted as finally resolved. No DB transactions/concurrency are simulated here.
"""
from dataclasses import dataclass, replace

from referensprov_policy import Bank, Decision, decide


@dataclass(frozen=True)
class HeldSurplus:
    org: str
    source_bank_id: str
    fixture_id: str
    tenant: str
    lease: str
    notice_id: str
    amount: int
    status: str = 'HELD_PENDING_DISPOSITION'
    policy: str = 'EXPLICIT_NOTICE_HOLD_V1'


@dataclass(frozen=True)
class Receipt:
    source_bank_id: str
    fixture_id: str
    bank: Bank
    decision: Decision
    hold: object
    unresolved: int


class SimulationLedger:
    def __init__(self, notices):
        self.notices = tuple(notices)
        self.opening = {(n.org, n.id): n.debt for n in self.notices}
        if len(self.opening) != len(self.notices):
            raise ValueError('Duplicate notice identity')
        self.receipts = {}

    def process(self, source_bank_id, fixture_id, bank):
        if not source_bank_id or not fixture_id:
            raise ValueError('Source bank identity required')
        if type(bank.amount) is not int or bank.amount <= 0:
            raise ValueError('Positive integer ore required')
        key = (bank.org, source_bank_id)
        if key in self.receipts:
            original = self.receipts[key]
            if original.bank != bank or original.fixture_id != fixture_id:
                raise ValueError('Source identity reused with different payload')
            return original

        decision = decide(bank, self.notices, hold_surplus=True)
        allocation = dict(decision.allocations)
        if len(allocation) != len(decision.allocations):
            raise ValueError('Duplicate allocation target')
        known = {n.id: n for n in self.notices if n.org == bank.org}
        for notice_id, amount in allocation.items():
            n = known.get(notice_id)
            if n is None or n.issued > bank.date or type(amount) is not int or not 0 < amount <= n.debt:
                raise ValueError('Invalid allocation')
        hold = None
        if decision.held_surplus:
            if type(decision.held_surplus) is not int or decision.held_surplus <= 0 or len(allocation) != 1:
                raise ValueError('Invalid held surplus')
            notice_id = next(iter(allocation))
            n = known[notice_id]
            if allocation[notice_id] != n.debt:
                raise ValueError('Surplus cannot precede full notice payment')
            hold = HeldSurplus(bank.org, source_bank_id, fixture_id, n.tenant,
                               n.lease, n.id, decision.held_surplus)
        total = sum(allocation.values()) + decision.held_surplus
        if total not in (0, bank.amount):
            raise ValueError('Payment is not fully accounted for')
        receipt = Receipt(source_bank_id, fixture_id, bank, decision, hold,
                          bank.amount if total == 0 else 0)
        staged = tuple(replace(n, debt=n.debt - allocation.get(n.id, 0))
                       if n.org == bank.org else n for n in self.notices)
        # Publish only after validation: exceptions above cannot partially mutate.
        self.notices = staged
        self.receipts[key] = receipt
        return receipt

    def verify(self):
        allocated = {}
        bank_total = held_total = unresolved_total = allocated_total = 0
        for (org, source), receipt in self.receipts.items():
            d = receipt.decision
            assert org == receipt.bank.org and source == receipt.source_bank_id
            assert sum(a for _, a in d.allocations) + d.held_surplus + receipt.unresolved == receipt.bank.amount
            assert (receipt.hold is not None) == (d.held_surplus > 0)
            if receipt.hold:
                h = receipt.hold
                n = next(n for n in self.notices if n.org == org and n.id == h.notice_id)
                assert (h.org, h.source_bank_id, h.fixture_id) == (org, source, receipt.fixture_id)
                assert (h.tenant, h.lease) == (n.tenant, n.lease)
                assert h.amount == d.held_surplus and h.status == 'HELD_PENDING_DISPOSITION'
            for target, amount in d.allocations:
                allocated[(org, target)] = allocated.get((org, target), 0) + amount
                allocated_total += amount
            bank_total += receipt.bank.amount
            held_total += d.held_surplus
            unresolved_total += receipt.unresolved
        for n in self.notices:
            assert n.debt >= 0
            assert self.opening[(n.org, n.id)] == n.debt + allocated.get((n.org, n.id), 0)
        assert bank_total == allocated_total + held_total + unresolved_total
        return {'bankOre': bank_total, 'allocatedOre': allocated_total,
                'heldOre': held_total, 'unresolvedOre': unresolved_total,
                'uniqueSourcePayments': len(self.receipts)}
