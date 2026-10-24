"""Offline experiment only. Immutable memory state; no DB, accounts or I/O.

Original reference policy is imported unchanged. No evaluator, scenario or gold
is imported here. Dedup assumes a stable, organization-scoped bank event ID;
neither real import dedup nor crash durability/database locks are tested.
"""
from dataclasses import dataclass, replace
import hashlib
import json

from referensprov_policy import Bank, Notice, decide, whole


VERSION = 'overskott-v1'
PENDING = (
    'Fastställd kontohantering och beständig ekonomisk redovisning',
    'Bekräfta ägare och fortsatt hantering av kvarvarande tillgodo',
    'Separat beslut före återbetalning eller användning mot annan avi',
)


@dataclass(frozen=True)
class Credit:
    id: str
    org: str
    tenant: str
    lease: str
    bank_event: str
    notice: str
    amount: int
    created_on: str
    policy: str = VERSION
    status: str = 'PENDING_HUMAN_REVIEW'
    pending_decisions: tuple = PENDING


@dataclass(frozen=True)
class Outcome:
    reason: str
    allocations: tuple = ()
    credit: Credit | None = None

    @property
    def allocation_review(self):
        return not bool(self.allocations)

    @property
    def human_review(self):
        return self.allocation_review or self.credit is not None


@dataclass(frozen=True)
class Receipt:
    org: str
    bank_event: str
    bank: Bank
    outcome: Outcome


@dataclass(frozen=True)
class State:
    notices: tuple[Notice, ...]
    credits: tuple[Credit, ...] = ()
    receipts: tuple[Receipt, ...] = ()


class InterruptedCommit(RuntimeError):
    """Injected interruption before publishing the new immutable memory state."""


def credit_id(org, event):
    source = json.dumps([VERSION, org, event], ensure_ascii=False).encode()
    return 'credit-' + hashlib.sha256(source).hexdigest()


def decide_surplus(event: str, bank: Bank, notices: tuple[Notice, ...]) -> Outcome:
    if not isinstance(event, str) or not event.strip():
        raise ValueError('Stable bank event ID required')
    eligible = [n for n in notices if n.org == bank.org and n.issued <= bank.date]
    text = bank.text + ' ' + bank.reference
    explicit = [n for n in eligible if whole(text, n.number) or
                (n.unique_ref and whole(text, n.unique_ref))]
    # Duplicate identifiers and multiple explicit notices must never pick one.
    if len(explicit) > 1:
        return Outcome('FLERA_ELLER_TVETYDIGA_EXPLICITA_AVIER')
    original = decide(bank, notices, period_support=True)
    if original.reason != 'OVERSKOTT_KRAVER_HANTERING':
        return Outcome(original.reason, original.allocations)
    if len(explicit) != 1:
        return Outcome('OVERSKOTT_UTAN_ENTYDIG_EXPLICIT_AVI')
    notice = explicit[0]
    if type(notice.debt) is not int or notice.debt <= 0:
        return Outcome('INGEN_OPPEN_SKULD')
    # Re-use all identity/period checks with the capped amount. No bypass of a
    # conflict, paid identity, unknown reference or ambiguous name is permitted.
    capped = decide(replace(bank, amount=notice.debt), notices, period_support=True)
    if capped.allocations != ((notice.id, notice.debt),):
        return Outcome('OSAKER_UPPDELNING')
    credit = Credit(credit_id(bank.org, event), bank.org, notice.tenant,
                    notice.lease, event, notice.id, bank.amount - notice.debt, bank.date)
    return Outcome('ALLOKERAD_MED_TILLGODO_ATT_GRANSKA', capped.allocations, credit)


def apply_event(state: State, event: str, bank: Bank, interrupt_at=None):
    """Return (new state, outcome, duplicate). No mutation, even on interruption.

    Caller publishes the returned state in one assignment. This models atomicity
    only in one Python process. Receipts include unresolved events as well: retry
    is not an implicit human correction. Same ID with changed payload is rejected.
    """
    if interrupt_at not in (None, 'after_debt', 'after_credit'):
        raise ValueError('Unknown interruption point')
    for receipt in state.receipts:
        if (receipt.org, receipt.bank_event) == (bank.org, event):
            if receipt.bank != bank:
                raise ValueError('BANK_EVENT_PAYLOAD_CONFLICT')
            return state, receipt.outcome, True
    outcome = decide_surplus(event, bank, state.notices)
    allocations = dict(outcome.allocations)
    credit_amount = outcome.credit.amount if outcome.credit else 0
    if allocations:
        assert sum(allocations.values()) + credit_amount == bank.amount
    by_id = {n.id: n for n in state.notices if n.org == bank.org}
    for key, amount in allocations.items():
        assert type(amount) is int and 0 < amount <= by_id[key].debt
    staged_notices = tuple(replace(n, debt=n.debt - allocations.get(n.id, 0))
                           if n.org == bank.org else n for n in state.notices)
    if interrupt_at == 'after_debt':
        raise InterruptedCommit(interrupt_at)
    staged_credits = state.credits + ((outcome.credit,) if outcome.credit else ())
    if interrupt_at == 'after_credit':
        raise InterruptedCommit(interrupt_at)
    receipt = Receipt(bank.org, event, bank, outcome)
    return State(staged_notices, staged_credits, state.receipts + (receipt,)), outcome, False
