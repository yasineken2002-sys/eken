"""Isolated SQLite lifecycle prototype. Never imports or writes production data.

Journal accounts are symbolic test buckets, not approved BAS accounts. Return
account verification and settlement are supplied by TEST fixtures, not a bank.
SQLite transactions test persistence/atomicity, not PostgreSQL integration.
"""
from dataclasses import asdict, replace
from datetime import datetime, timezone
import json
import sqlite3

from referensprov_policy import Notice, decide


SCHEMA = '''
CREATE TABLE IF NOT EXISTS leases (
 org TEXT, id TEXT, tenant TEXT NOT NULL, carry INTEGER NOT NULL,
 closed_at TEXT, last_effect_at TEXT, PRIMARY KEY(org,id));
CREATE TABLE IF NOT EXISTS notices (
 org TEXT, id TEXT, tenant TEXT, lease TEXT, name TEXT, number TEXT, ocr TEXT,
 year INTEGER, month INTEGER, due TEXT, issued TEXT, unique_ref TEXT,
 period INTEGER, amount INTEGER CHECK(amount>0), debt INTEGER CHECK(debt>=0 AND debt<=amount),
 PRIMARY KEY(org,id), UNIQUE(org,number), UNIQUE(org,lease,period),
 FOREIGN KEY(org,lease) REFERENCES leases(org,id));
CREATE TABLE IF NOT EXISTS receipts (
 org TEXT, id TEXT, fixture_id TEXT, payload TEXT, amount INTEGER CHECK(amount>0),
 unresolved INTEGER CHECK(unresolved>=0), result TEXT, PRIMARY KEY(org,id));
CREATE TABLE IF NOT EXISTS lots (
 org TEXT, source_bank_id TEXT, fixture_id TEXT, source_notice_id TEXT,
 tenant TEXT, lease TEXT, period INTEGER, created_at TEXT,
 original INTEGER CHECK(original>0), applied INTEGER DEFAULT 0 CHECK(applied>=0),
 refunded INTEGER DEFAULT 0 CHECK(refunded>=0), reserved INTEGER DEFAULT 0 CHECK(reserved>=0),
 PRIMARY KEY(org,source_bank_id), CHECK(applied+refunded+reserved<=original),
 FOREIGN KEY(org,source_bank_id) REFERENCES receipts(org,id));
CREATE TABLE IF NOT EXISTS movements (
 org TEXT, event_id TEXT, source_bank_id TEXT, fixture_id TEXT,
 source_notice_id TEXT, target_notice_id TEXT, amount INTEGER CHECK(amount>0), kind TEXT);
CREATE TABLE IF NOT EXISTS return_accounts (
 org TEXT, source_bank_id TEXT, account_token TEXT, verification_id TEXT,
 PRIMARY KEY(org,source_bank_id), UNIQUE(org,verification_id));
CREATE TABLE IF NOT EXISTS refunds (
 org TEXT, id TEXT, source_bank_id TEXT, amount INTEGER CHECK(amount>0), account_token TEXT,
 status TEXT, requested_at TEXT, settlement_id TEXT, settled_at TEXT,
 PRIMARY KEY(org,id), UNIQUE(org,settlement_id));
CREATE TABLE IF NOT EXISTS journal (
 org TEXT, event_id TEXT, line INTEGER, account TEXT, signed_ore INTEGER CHECK(signed_ore!=0),
 PRIMARY KEY(org,event_id,line));
CREATE TABLE IF NOT EXISTS events (
 org TEXT, id TEXT, kind TEXT, payload TEXT, result TEXT, PRIMARY KEY(org,id));
'''


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def money(value):
    if type(value) is not int or value <= 0:
        raise ValueError('Positive integer ore required')
    return value


def instant(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, AttributeError) as exc:
        raise ValueError('Valid ISO event date required') from exc


class CreditStore:
    def __init__(self, path):
        self.db = sqlite3.connect(str(path), isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript(SCHEMA)
        self.fail_next = False

    def close(self):
        self.db.close()

    def _one(self, sql, params):
        row = self.db.execute(sql, params).fetchone()
        if row is None:
            raise ValueError('Unknown scoped identity')
        return dict(row)

    def _event(self, event_id, org, kind, payload, operation):
        if not event_id or not org:
            raise ValueError('Scoped event identity required')
        raw = encode(payload)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            existing = self.db.execute('SELECT * FROM events WHERE org=? AND id=?', (org, event_id)).fetchone()
            if existing:
                if existing['kind'] != kind or existing['payload'] != raw:
                    raise ValueError('Event identity reused with different payload')
                self.db.execute('COMMIT')
                return json.loads(existing['result'])
            result = json.loads(encode(operation()))
            if self.fail_next:
                self.fail_next = False
                raise RuntimeError('Injected failure before commit')
            self.db.execute('INSERT INTO events VALUES (?,?,?,?,?)', (org, event_id, kind, raw, encode(result)))
            self.db.execute('COMMIT')
            return result
        except Exception as exc:
            self.db.execute('ROLLBACK')
            if isinstance(exc, sqlite3.IntegrityError):
                raise ValueError(str(exc)) from exc
            raise

    def _journal(self, org, event, legs):
        assert sum(amount for _, amount in legs) == 0
        for i, (account, amount) in enumerate(legs):
            if amount:
                self.db.execute('INSERT INTO journal VALUES (?,?,?,?,?)', (org, event, i, account, amount))

    def _touch_time(self, org, lease, at):
        moment = instant(at)
        state = self._one('SELECT last_effect_at FROM leases WHERE org=? AND id=?', (org, lease))
        if state['last_effect_at'] and moment < state['last_effect_at']:
            raise ValueError('Backdated money disposition requires separate review')
        self.db.execute('UPDATE leases SET last_effect_at=? WHERE org=? AND id=?', (moment, org, lease))

    def register_lease(self, event_id, org, tenant, lease, carry_forward=False):
        def run():
            if not tenant or not lease or type(carry_forward) is not bool:
                raise ValueError('Explicit lease policy required')
            self.db.execute('INSERT INTO leases VALUES (?,?,?,?,NULL,NULL)', (org, lease, tenant, int(carry_forward)))
            return {'lease': lease, 'carry_forward': carry_forward}
        return self._event(event_id, org, 'LEASE', [tenant, lease, carry_forward], run)

    def issue(self, event_id, notice):
        def run():
            lease = self._one('SELECT * FROM leases WHERE org=? AND id=?', (notice.org, notice.lease))
            if lease['tenant'] != notice.tenant or lease['closed_at']:
                raise ValueError('Lease mismatch or closed lease')
            money(notice.debt)
            instant(notice.issued)
            instant(notice.due)
            if not 1 <= notice.month <= 12:
                raise ValueError('Invalid month')
            self.db.execute('INSERT INTO notices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (notice.org, notice.id, notice.tenant, notice.lease, notice.name, notice.number, notice.ocr,
                 notice.year, notice.month, notice.due, notice.issued, notice.unique_ref,
                 notice.year * 12 + notice.month, notice.debt, notice.debt))
            self._journal(notice.org, event_id, [('RECEIVABLE', notice.debt), ('RENT', -notice.debt)])
            return {'notice': notice.id}
        return self._event(event_id, notice.org, 'ISSUE', asdict(notice), run)

    def _notices(self):
        # The pure policy compares dates lexically; supply canonical UTC values
        # so offsets and date-only inputs cannot make a future notice available.
        return [replace(Notice(**{k: row[k] for k in Notice.__dataclass_fields__}),
                        issued=instant(row['issued']), due=instant(row['due']))
                for row in self.db.execute('SELECT * FROM notices')]

    def ingest(self, event_id, bank_id, fixture_id, bank):
        def run():
            money(bank.amount)
            instant(bank.date)
            if not self.db.execute('SELECT 1 FROM leases WHERE org=?', (bank.org,)).fetchone():
                raise ValueError('Unknown organization')
            if not bank_id or not fixture_id:
                raise ValueError('Source bank and fixture identity required')
            original = self.db.execute('SELECT * FROM receipts WHERE org=? AND id=?', (bank.org, bank_id)).fetchone()
            payload = encode(asdict(bank))
            if original:
                if original['payload'] != payload or original['fixture_id'] != fixture_id:
                    raise ValueError('Source bank identity reused with changed payload')
                return json.loads(original['result'])
            decision = decide(replace(bank, date=instant(bank.date)), self._notices(), hold_surplus=True)
            allocation = dict(decision.allocations)
            allocated = sum(allocation.values())
            unresolved = bank.amount if not allocation else 0
            if allocated + decision.held_surplus + unresolved != bank.amount:
                raise ValueError('Payment not conserved')
            result = {**asdict(decision), 'unresolved': unresolved}
            self.db.execute('INSERT INTO receipts VALUES (?,?,?,?,?,?,?)',
                            (bank.org, bank_id, fixture_id, payload, bank.amount, unresolved, encode(result)))
            for target, amount in allocation.items():
                n = self._one('SELECT * FROM notices WHERE org=? AND id=?', (bank.org, target))
                if type(amount) is not int or not 0 < amount <= n['debt'] or instant(n['issued']) > instant(bank.date):
                    raise ValueError('Invalid allocation')
                self._touch_time(bank.org, n['lease'], bank.date)
                self.db.execute('UPDATE notices SET debt=debt-? WHERE org=? AND id=?', (amount, bank.org, target))
                self.db.execute('INSERT INTO movements VALUES (?,?,?,?,?,?,?,?)',
                                (bank.org, event_id, bank_id, fixture_id, target, target, amount, 'BANK'))
            if decision.held_surplus:
                if len(allocation) != 1:
                    raise ValueError('Credit requires one exact source notice')
                n = self._one('SELECT * FROM notices WHERE org=? AND id=?', (bank.org, next(iter(allocation))))
                if n['debt'] != 0:
                    raise ValueError('Source notice still has debt')
                self.db.execute('INSERT INTO lots VALUES (?,?,?,?,?,?,?,?,?,0,0,0)',
                    (bank.org, bank_id, fixture_id, n['id'], n['tenant'], n['lease'], n['period'], bank.date, decision.held_surplus))
            self._journal(bank.org, event_id, [('BANK', bank.amount), ('RECEIVABLE', -allocated),
                         ('CUSTOMER_LIABILITY', -decision.held_surplus), ('UNIDENTIFIED', -unresolved)])
            return result
        return self._event(event_id, bank.org, 'INGEST', [bank_id, fixture_id, asdict(bank)], run)

    def apply_credit(self, event_id, org, notice_id, at):
        def run():
            moment = instant(at)
            n = self._one('SELECT * FROM notices WHERE org=? AND id=?', (org, notice_id))
            lease = self._one('SELECT * FROM leases WHERE org=? AND id=?', (org, n['lease']))
            if lease['closed_at'] or not lease['carry']:
                raise ValueError('Carry-forward not enabled for active lease')
            if instant(n['issued']) > moment or not n['debt']:
                return 0
            lots = self.db.execute('SELECT * FROM lots WHERE org=? AND tenant=? AND lease=? AND period<?',
                                   (org, n['tenant'], n['lease'], n['period'])).fetchall()
            lots = sorted((lot for lot in lots if instant(lot['created_at']) <= moment),
                          key=lambda lot: (instant(lot['created_at']), lot['source_bank_id']))
            total = 0
            for lot in lots:
                # A missing month or earlier open debt cannot be silently skipped.
                previous = self.db.execute('SELECT period,debt,issued FROM notices WHERE org=? AND lease=? AND period>? AND period<?',
                                           (org, n['lease'], lot['period'], n['period'])).fetchall()
                if len(previous) != n['period'] - lot['period'] - 1 or any(p['debt'] or instant(p['issued']) > moment for p in previous):
                    continue
                available = lot['original'] - lot['applied'] - lot['refunded'] - lot['reserved']
                amount = min(available, n['debt'] - total)
                if not amount:
                    continue
                self.db.execute('UPDATE lots SET applied=applied+? WHERE org=? AND source_bank_id=?', (amount, org, lot['source_bank_id']))
                self.db.execute('INSERT INTO movements VALUES (?,?,?,?,?,?,?,?)',
                    (org, event_id, lot['source_bank_id'], lot['fixture_id'], lot['source_notice_id'], notice_id, amount, 'CREDIT'))
                total += amount
            self.db.execute('UPDATE notices SET debt=debt-? WHERE org=? AND id=?', (total, org, notice_id))
            if total:
                self._touch_time(org, n['lease'], at)
            self._journal(org, event_id, [('CUSTOMER_LIABILITY', total), ('RECEIVABLE', -total)])
            return total
        return self._event(event_id, org, 'APPLY', [notice_id, at], run)

    def close_lease(self, event_id, org, lease, at):
        def run():
            old = self._one('SELECT * FROM leases WHERE org=? AND id=?', (org, lease))
            if old['closed_at'] and old['closed_at'] != at:
                raise ValueError('Closure date already recorded')
            if old['closed_at'] == at:
                return {'lease': lease, 'closed_at': at}
            if any(instant(n['issued']) > instant(at) for n in self.db.execute('SELECT issued FROM notices WHERE org=? AND lease=?', (org, lease))):
                raise ValueError('Closure predates an issued notice')
            self._touch_time(org, lease, at)
            self.db.execute('UPDATE leases SET closed_at=? WHERE org=? AND id=?', (at, org, lease))
            return {'lease': lease, 'closed_at': at}
        return self._event(event_id, org, 'CLOSE', [lease, at], run)

    def verify_return_account(self, event_id, org, source_bank_id, account_token, verification_id):
        """Fixture-supplied verification. No real account lookup or bank API."""
        def run():
            self._one('SELECT * FROM lots WHERE org=? AND source_bank_id=?', (org, source_bank_id))
            if not account_token or not verification_id:
                raise ValueError('Source-bound verification required')
            old = self.db.execute('SELECT * FROM return_accounts WHERE org=? AND source_bank_id=?', (org, source_bank_id)).fetchone()
            if old:
                if (old['account_token'], old['verification_id']) != (account_token, verification_id):
                    raise ValueError('Verified binding cannot be replaced')
            else:
                self.db.execute('INSERT INTO return_accounts VALUES (?,?,?,?)', (org, source_bank_id, account_token, verification_id))
            return {'source_bank_id': source_bank_id, 'account_token': account_token}
        return self._event(event_id, org, 'TEST_VERIFY', [source_bank_id, account_token, verification_id], run)

    def request_refund(self, event_id, org, source_bank_id, amount, account_token, at):
        def run():
            money(amount)
            lot = self._one('SELECT * FROM lots WHERE org=? AND source_bank_id=?', (org, source_bank_id))
            lease = self._one('SELECT * FROM leases WHERE org=? AND id=?', (org, lot['lease']))
            account = self._one('SELECT * FROM return_accounts WHERE org=? AND source_bank_id=?', (org, source_bank_id))
            if not lease['closed_at'] or instant(at) < instant(lease['closed_at']) or instant(at) < instant(lot['created_at']) or account['account_token'] != account_token:
                raise ValueError('Closure and source-bound destination required')
            if self.db.execute('SELECT 1 FROM notices WHERE org=? AND lease=? AND debt>0', (org, lot['lease'])).fetchone():
                raise ValueError('Outstanding lease debt needs resolution first')
            if amount > lot['original'] - lot['applied'] - lot['refunded'] - lot['reserved']:
                raise ValueError('Insufficient available credit')
            self._touch_time(org, lot['lease'], at)
            self.db.execute('UPDATE lots SET reserved=reserved+? WHERE org=? AND source_bank_id=?', (amount, org, source_bank_id))
            self.db.execute('INSERT INTO refunds VALUES (?,?,?,?,?,?,?,NULL,NULL)', (org, event_id, source_bank_id, amount, account_token, 'PENDING', at))
            return {'refund_id': event_id, 'status': 'PENDING'}
        return self._event(event_id, org, 'REQUEST_REFUND', [source_bank_id, amount, account_token, at], run)

    def confirm_refund(self, event_id, org, refund_id, bank_payment_id, amount, account_token, at):
        def run():
            money(amount)
            r = self._one('SELECT * FROM refunds WHERE org=? AND id=?', (org, refund_id))
            if r['status'] == 'SETTLED' and r['settlement_id'] == bank_payment_id and (r['amount'], r['account_token'], r['settled_at']) == (amount, account_token, at):
                return {'refund_id': refund_id, 'status': 'SETTLED', 'bank_payment_id': bank_payment_id}
            if r['status'] != 'PENDING' or not bank_payment_id or (r['amount'], r['account_token']) != (amount, account_token) or instant(at) < instant(r['requested_at']):
                raise ValueError('Settlement does not match pending refund')
            lot = self._one('SELECT * FROM lots WHERE org=? AND source_bank_id=?', (org, r['source_bank_id']))
            self._touch_time(org, lot['lease'], at)
            self.db.execute('UPDATE refunds SET status=?,settlement_id=?,settled_at=? WHERE org=? AND id=?', ('SETTLED', bank_payment_id, at, org, refund_id))
            self.db.execute('UPDATE lots SET reserved=reserved-?,refunded=refunded+? WHERE org=? AND source_bank_id=?', (amount, amount, org, r['source_bank_id']))
            self.db.execute('INSERT INTO movements VALUES (?,?,?,?,?,?,?,?)',
                            (org, event_id, r['source_bank_id'], lot['fixture_id'], lot['source_notice_id'], '', amount, 'REFUND'))
            self._journal(org, event_id, [('CUSTOMER_LIABILITY', amount), ('BANK', -amount)])
            return {'refund_id': refund_id, 'status': 'SETTLED', 'bank_payment_id': bank_payment_id}
        return self._event(event_id, org, 'CONFIRM_REFUND', [refund_id, bank_payment_id, amount, account_token, at], run)

    def fail_refund(self, event_id, org, refund_id, reason):
        """Definitive TEST bank decline only. Timeouts must retain reservations."""
        def run():
            r = self._one('SELECT * FROM refunds WHERE org=? AND id=?', (org, refund_id))
            if r['status'] != 'PENDING' or reason != 'BANK_FINAL_DECLINE':
                raise ValueError('Only definitive bank decline releases reservation')
            self.db.execute('UPDATE refunds SET status=? WHERE org=? AND id=?', ('DECLINED', org, refund_id))
            self.db.execute('UPDATE lots SET reserved=reserved-? WHERE org=? AND source_bank_id=?', (r['amount'], org, r['source_bank_id']))
            return {'refund_id': refund_id, 'status': 'DECLINED'}
        return self._event(event_id, org, 'FAIL_REFUND', [refund_id, reason], run)

    def balance(self, org, source_bank_id):
        r = self._one('SELECT * FROM lots WHERE org=? AND source_bank_id=?', (org, source_bank_id))
        return {k: r[k] for k in ('original', 'applied', 'refunded', 'reserved')} | {
            'available': r['original'] - r['applied'] - r['refunded'] - r['reserved']}

    def debt(self, org, notice_id):
        return self._one('SELECT debt FROM notices WHERE org=? AND id=?', (org, notice_id))['debt']

    def snapshot(self):
        tables = ('leases', 'notices', 'receipts', 'lots', 'movements', 'return_accounts', 'refunds', 'journal', 'events')
        return {table: sorted([dict(r) for r in self.db.execute('SELECT * FROM ' + table)], key=encode) for table in tables}

    def verify(self):
        s = self.snapshot()
        scoped = {r['org'] for table in s.values() for r in table}
        totals = {}
        for org in scoped:
            notices = [n for n in s['notices'] if n['org'] == org]
            lots = [l for l in s['lots'] if l['org'] == org]
            moves = [m for m in s['movements'] if m['org'] == org]
            receipts = [r for r in s['receipts'] if r['org'] == org]
            journal = [j for j in s['journal'] if j['org'] == org]
            for event in {j['event_id'] for j in journal}:
                assert sum(j['signed_ore'] for j in journal if j['event_id'] == event) == 0
            for n in notices:
                assert n['amount'] == n['debt'] + sum(m['amount'] for m in moves if m['target_notice_id'] == n['id'])
            for lot in lots:
                b = self.balance(org, lot['source_bank_id'])
                assert b['available'] >= 0 and sum(b[k] for k in ('available','reserved','applied','refunded')) == b['original']
                for kind, field in (('CREDIT','applied'), ('REFUND','refunded')):
                    assert lot[field] == sum(m['amount'] for m in moves if m['source_bank_id'] == lot['source_bank_id'] and m['kind'] == kind)
                assert lot['reserved'] == sum(r['amount'] for r in s['refunds'] if r['org'] == org and r['source_bank_id'] == lot['source_bank_id'] and r['status'] == 'PENDING')
            for receipt in receipts:
                assert receipt['amount'] == receipt['unresolved'] + sum(m['amount'] for m in moves if m['source_bank_id'] == receipt['id'] and m['kind'] == 'BANK') + sum(l['original'] for l in lots if l['source_bank_id'] == receipt['id'])
            accounts = {a: sum(j['signed_ore'] for j in journal if j['account'] == a)
                        for a in ('BANK','RECEIVABLE','CUSTOMER_LIABILITY','UNIDENTIFIED','RENT')}
            liability = sum(l['original'] - l['applied'] - l['refunded'] for l in lots)
            refunded = sum(l['refunded'] for l in lots)
            assert accounts['RECEIVABLE'] == sum(n['debt'] for n in notices)
            assert -accounts['CUSTOMER_LIABILITY'] == liability
            assert accounts['BANK'] == sum(r['amount'] for r in receipts) - refunded
            assert -accounts['UNIDENTIFIED'] == sum(r['unresolved'] for r in receipts)
            assert sum(accounts.values()) == 0
            totals[org] = {'incomingOre': sum(r['amount'] for r in receipts), 'liabilityOre': liability,
                           'creditAppliedOre': sum(l['applied'] for l in lots), 'refundedOre': refunded,
                           'reservedOre': sum(l['reserved'] for l in lots), 'accounts': accounts}
        return totals
