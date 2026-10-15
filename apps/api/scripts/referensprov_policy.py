"""Experiment only: pure reference decision, no database or production imports.

Caller supplies only issued notices and bank-visible fields, never scenario/gold.
This deliberately supports a narrow Swedish month/year grammar, not general AI.
"""
from dataclasses import dataclass
from functools import lru_cache
import re
import unicodedata


MONTHS = ('januari februari mars april maj juni juli augusti september oktober november december').split()
MONTH_ALIASES = {
    alias: month for month, aliases in enumerate((
        'januari jan', 'februari feb', 'mars mar', 'april apr', 'maj', 'juni jun',
        'juli jul', 'augusti aug', 'september sep sept', 'oktober okt',
        'november nov', 'december dec',
    ), 1) for alias in aliases.split()
}
MONTH_PATTERN = '|'.join(sorted(MONTH_ALIASES, key=len, reverse=True))
NOTICE_PATTERN = r'(?<!\w)avi-\d{4}-\d{2}-\d{4,}(?!\w)'
# This is a deliberately closed experiment grammar. Unconsumed words/numbers
# require review, including unknown intent; no blacklist can understand prose.
PAYMENT_LABELS = {'hyra', 'hyran', 'hyresbetalning', 'delbetalning', 'inbetalning',
                  'betalning', 'ocr', 'avi', 'avinummer', 'referens', 'för',
                  'avser', 'period', 'månad', 'hyresavi'}


@lru_cache(maxsize=8192)
def normalize(text):
    normalized = unicodedata.normalize('NFKC', text).casefold()
    return ' '.join(normalized.translate(str.maketrans('‐‑–—', '----')).split())


def whole(text, value):
    return bool(re.search(r'(?<!\w)' + re.escape(normalize(value)) + r'(?!\w)', normalize(text)))


def read_period(text):
    """Return a single explicit rent period and unconsumed text, or an error.

    Caller first removes names and references, so an AVI number's embedded date
    is not mistaken for a second payment instruction. No bank-year inference.
    Full dates, ranges, missing years and relative periods are not accepted.
    """
    if re.search(r'[^\w\s.,:;()/\-#]', text):
        return None, text, 'TEXT_KRAVER_TOLKNING'
    periods = set()
    residual = text
    patterns = (
        (rf'(?<!\w)({MONTH_PATTERN})\.?\s+(20\d{{2}})(?!\w)', 'named'),
        (r'(?<![\w/.-])(20\d{2})\s*[-/]\s*(\d{1,2})(?!\w|\s*[-/.]\s*\d)', 'ym'),
        (r'(?<![\w/.-])(\d{1,2})\s*/\s*(20\d{2})(?!\w|\s*[-/.]\s*\d)', 'my'),
    )
    for pattern, form in patterns:
        def consume(match):
            a, b = match.groups()
            year, month = ((int(b), MONTH_ALIASES[a]) if form == 'named' else
                           (int(a), int(b)) if form == 'ym' else (int(b), int(a)))
            periods.add((year, month))
            return ' '
        residual = re.sub(pattern, consume, residual)
    if len(periods) > 1 or any(not 1 <= month <= 12 for _, month in periods):
        return None, residual, 'OKLAR_PERIOD'
    # No silent oldest-first fallback for abbreviated, malformed or missing periods.
    remaining_words = set(re.findall(r'\w+', residual))
    if not periods and remaining_words & {'period', 'månad'}:
        return None, residual, 'OKLAR_PERIOD'
    if remaining_words - PAYMENT_LABELS:
        return None, residual, 'TEXT_KRAVER_TOLKNING'
    return next(iter(periods), None), residual, None


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
    held_surplus: int = 0


def decide(bank, notices, period_support=True, hold_surplus=False):
    """No side effects. All checks finish before a caller may allocate money."""
    def review(reason):
        return Decision(reason)

    if type(bank.amount) is not int or bank.amount <= 0:
        return review('OGILTIGT_BELOPP')
    known = [n for n in notices if n.org == bank.org and n.issued <= bank.date]
    text = normalize(bank.text + ' ' + bank.reference)
    by_number = {}
    for n in known:
        by_number.setdefault(n.number.casefold(), []).append(n)
    named_numbers = set(re.findall(NOTICE_PATTERN, text))
    if named_numbers - by_number.keys():
        return review('OKAND_AVI')
    if any(len(by_number[num]) != 1 for num in named_numbers):
        return review('TVETYDIG_AVIREFERENS')
    explicit = {by_number[num][0].id for num in named_numbers}
    # Keep paid notices in the identity registry: payment order cannot erase conflicts.
    numeric = set(re.findall(r'(?<!\w)[0-9]{4,25}(?!\w)', text))
    legacy_refs = {n.ocr for n in known}
    unique_refs = {n.unique_ref for n in known if n.unique_ref}
    if numeric & legacy_refs & unique_refs:
        return review('REFERENSKOLLISION')
    owners = {n.tenant for n in known if n.ocr in numeric or
              (n.unique_ref and n.unique_ref in numeric)}
    explicit.update(n.id for n in known if n.unique_ref and n.unique_ref in numeric)
    raw = bank.reference.strip()
    recognized_raw = any(raw == n.ocr or (n.unique_ref and raw == n.unique_ref) for n in known)
    if raw and not recognized_raw and valid_ocr(raw):
        return review('OKAND_GILTIG_REFERENS')
    mentioned_names = {(n.tenant, n.name) for n in known}
    mentioned_names = {(tenant, name) for tenant, name in mentioned_names if whole(text, name)}
    names = {tenant for tenant, _ in mentioned_names}
    explicit_owners = {n.tenant for n in known if n.id in explicit}
    if len(owners | names | explicit_owners) > 1:
        return review('IDENTITETSKONFLIKT')
    prose = re.sub(NOTICE_PATTERN, ' ', text)
    for _, name in sorted(mentioned_names, key=lambda pair: len(pair[1]), reverse=True):
        prose = re.sub(r'(?<!\w)' + re.escape(normalize(name)) + r'(?!\w)', ' ', prose)
    # The reference column's numeric value is a reference, even when misspelled;
    # its validation below must not mistake its digits for a free-text period.
    remove_refs = (legacy_refs | unique_refs) & numeric
    if re.fullmatch(r'[0-9]{4,25}', raw):
        remove_refs.add(raw)
    for reference in remove_refs:
        prose = re.sub(r'(?<!\w)' + re.escape(reference) + r'(?!\w)', ' ', prose)
    period, _, period_error = read_period(prose)
    if period_error:
        return review(period_error)
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
    surplus = max(0, bank.amount - sum(n.debt for n in candidates))
    if surplus and not (hold_surplus and len(explicit) == 1 and len(candidates) == 1):
        return review('OVERSKOTT_KRAVER_HANTERING')
    remaining = bank.amount - surplus
    allocations = []
    for n in sorted(candidates, key=lambda n: (n.due, n.id)):
        amount = min(n.debt, remaining)
        if amount:
            allocations.append((n.id, amount))
        remaining -= amount
        if not remaining:
            break
    assert remaining == 0
    return Decision('AVI_BETALD_OVERSKOTT_RESERVERAT' if surplus else 'AUTOMATISK',
                    tuple(allocations), surplus)
