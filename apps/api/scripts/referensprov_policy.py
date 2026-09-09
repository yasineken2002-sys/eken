"""Experiment only: pure reference decision, no database or production imports.

Caller supplies only issued notices and bank-visible fields, never scenario/gold.
This deliberately supports a narrow Swedish month/year grammar, not general AI.
"""
from dataclasses import dataclass
import re
import unicodedata


MONTHS = ('januari februari mars april maj juni juli augusti september oktober november december').split()


def normalize(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def whole(text, value):
    return bool(re.search(r'(?<!\w)' + re.escape(normalize(value)) + r'(?!\w)', normalize(text)))


def checksum(base):
    # Mirrors current shared implementation, checked against all saved tenant OCRs.
    # Not a new production OCR implementation or bank-format certification.
    return str(-sum((int(c) * 2 // 10 + int(c) * 2 % 10) if i % 2 else int(c)
                    for i, c in enumerate(reversed(base))) % 10)


def valid_ocr(value):
    return bool(re.fullmatch(r'[0-9]{4,25}', value)) and checksum(value[:-1]) == value[-1]


@dataclass(frozen=True)
class Notice:
    id: str
    org: str
    tenant: str
    lease: str
    name: str
    number: str
    ocr: str
    year: int
    month: int
    due: str
    issued: str
    debt: int
    unique_ref: str = ''


@dataclass(frozen=True)
class Bank:
    org: str
    date: str
    amount: int
    text: str
    reference: str


@dataclass(frozen=True)
class Decision:
    reason: str
    allocations: tuple = ()


def decide(bank, notices, period_support=True):
    """No side effects. All checks finish before a caller may allocate money."""
    def review(reason):
        return Decision(reason)

    if type(bank.amount) is not int or bank.amount <= 0:
        return review('OGILTIGT_BELOPP')
    known = [n for n in notices if n.org == bank.org and n.issued <= bank.date]
    text = normalize(bank.text + ' ' + bank.reference)
    if re.search(r'(?<!\w)(inte|bestrider|återbetalning|makulerad|ignorera|felaktig)(?!\w)', text):
        return review('TEXT_KRAVER_TOLKNING')
    by_number = {n.number.casefold(): n for n in known}
    named_numbers = set(re.findall(r'(?<!\w)avi-\d{4}-\d{2}-\d{4,}(?!\w)', text))
    if named_numbers - by_number.keys():
        return review('OKAND_AVI')
    explicit = {by_number[num].id for num in named_numbers}
    # Keep paid notices in the identity registry: payment order cannot erase conflicts.
    numeric = set(re.findall(r'(?<!\w)[0-9]{4,25}(?!\w)', text))
    owners = {n.tenant for n in known if n.ocr in numeric or
              (n.unique_ref and n.unique_ref in numeric)}
    explicit.update(n.id for n in known if n.unique_ref and n.unique_ref in numeric)
    raw = bank.reference.strip()
    recognized_raw = any(raw == n.ocr or (n.unique_ref and raw == n.unique_ref) for n in known)
    if raw and not recognized_raw and valid_ocr(raw):
        return review('OKAND_GILTIG_REFERENS')
    names = {n.tenant for n in known if whole(text, n.name)}
    explicit_owners = {n.tenant for n in known if n.id in explicit}
    if len(owners | names | explicit_owners) > 1:
        return review('IDENTITETSKONFLIKT')
    # A recognized month with no explicit year is not silently assigned the bank year.
    months = {i + 1 for i, name in enumerate(MONTHS) if whole(text, name)}
    years = set(re.findall(r'(?<!\w)(20\d{2})(?!\w)', normalize(bank.text)))
    if len(months) > 1 or (months and len(years) != 1):
        return review('OKLAR_PERIOD')
    period = (int(next(iter(years))), next(iter(months))) if months else None
    if len(explicit) > 1:
        return review('FLERA_EXPLICITA_AVIER')
    if explicit:
        candidates = [n for n in known if n.id in explicit]
        if period and any((n.year, n.month) != period for n in candidates):
            return review('PERIODKONFLIKT')
    elif period:
        identity = owners or names
        if not period_support or len(identity) != 1:
            return review('SAKNAR_PERIODSTOD')
        candidates = [n for n in known if n.tenant in identity and (n.year, n.month) == period]
        # Paid or parallel contracts still count: do not choose the one debt left open.
        if len(candidates) != 1:
            return review('TVETYDIG_AVI_FOR_PERIOD')
        if raw and not recognized_raw:
            expected = candidates[0].ocr
            if len(raw) != len(expected) or sum(a != b for a, b in zip(raw, expected)) != 1:
                return review('OKAND_FELSKRIVEN_REFERENS')
    elif len(owners) == 1:
        candidates = [n for n in known if n.tenant in owners and n.debt > 0]
        # Oldest-first remains a policy for a single lease, never an identity guess.
        if len({n.lease for n in known if n.tenant in owners}) != 1:
            return review('FLERA_AVTAL_UTAN_AVI')
        if names and not names.issubset(owners):
            return review('IDENTITETSKONFLIKT')
    else:
        return review('OTILLRACKLIG_IDENTIFIERING')
    if not candidates or any(n.debt <= 0 for n in candidates):
        return review('INGEN_OPPEN_SKULD')
    if bank.amount > sum(n.debt for n in candidates):
        return review('OVERSKOTT_KRAVER_HANTERING')
    remaining = bank.amount
    allocations = []
    for n in sorted(candidates, key=lambda n: (n.due, n.id)):
        amount = min(n.debt, remaining)
        if amount:
            allocations.append((n.id, amount))
        remaining -= amount
        if not remaining:
            break
    assert remaining == 0
    return Decision('AUTOMATISK', tuple(allocations))
