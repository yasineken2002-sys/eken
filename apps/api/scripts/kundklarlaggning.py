"""Isolated prototype. Simulated identity/attestor; no production adapters or DSN.

Only bootstrap may install evidence. A browser cannot create or promote evidence.
The database validates every financial decision in the same transaction as audit.
"""
import gzip
import hashlib
import json
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from referensprov_policy import Notice
from tillgodo_pg import Postgres, ROOT, literal

POLICY = ROOT / 'docs/eval/kundklarlaggning/policy-v1.json'
ORG = 'syntetisk'
FIXED = datetime(2026, 9, 9, 12, tzinfo=timezone.utc)
CF_TABLES = ('cf_person', 'cf_attestation', 'cf_case', 'cf_notice_version',
             'cf_invitation', 'cf_outbox', 'cf_audit')
PRINCIPALS = {
    'staff': (ORG, 'staff', 'staff'),
    'alice': (ORG, 'alice', 'customer'),
    'bob': (ORG, 'bob', 'customer'),
    'other-org': ('other-org', 'alice', 'customer'),
}


def js(value):
    return literal(json.dumps(value, ensure_ascii=False)) + '::jsonb'


def sha(value):
    return hashlib.sha256(value).hexdigest()


class Denied(Exception):
    """Deliberately generic; do not disclose bank/customer/SQL details."""


def originals():
    folder = ROOT / 'docs/eval/identitetsgranskning-20/korning-1'
    raw = (folder / 'fall.json').read_bytes()
    assert sha(raw) == json.loads((folder / 'manifest.json').read_text())['fallJsonSha256']
    public = ROOT / 'docs/eval/overskottsprov/korning-1'
    data = gzip.decompress((public / 'public-input.json.gz').read_bytes())
    assert sha(data) == json.loads((public / 'manifest.json').read_text())['publicInputUncompressedSha256']
    banks = json.loads(data)['banks']
    # The inventory selects cases only. No gold, candidate or scenario fields
    # enter routing. A stable test ID is a key, never evidence of ownership.
    selected = {c['id']: banks[c['id']] for c in json.loads(raw)['cases']}
    assert len(selected) == 20
    return selected


def b_inputs():
    """Separate NEW scenarios. Never replace or enrich original bank fields."""
    cases = {}
    for k in json.loads(POLICY.read_text())['B']['expectations']:
        amount = {'B-partial': 4000, 'B-combined': 14000, 'B-credit': 12500}.get(k, 10000)
        cases[k] = {'org': ORG, 'date': '2026-09-09', 'amount': amount,
                    'text': 'NYTT SYNTETISKT EXEMPEL', 'reference': ''}
    cases['B-conflict']['text'] = 'Hyra B-conflict-avi-1; Annan syntetisk kund'
    cases['B-conflict']['reference'] = 'FOREIGN-CONFLICT'
    return cases


def original_conflicts():
    """Retain known conflicts from public OCR/notice fields, never case/gold labels."""
    data = json.loads(gzip.decompress((ROOT/'docs/eval/overskottsprov/korning-1/public-input.json.gz').read_bytes()))
    notices = data['notices']
    if isinstance(notices, dict):
        notices = notices.values()
    references, numbers = {}, {}
    for n in notices:
        references.setdefault((n['org'], n['ocr']), set()).add(n['tenant'])
        numbers.setdefault((n['org'], n['number']), set()).add(n['tenant'])
    result = {}
    for k, bank in originals().items():
        owners = references.get((bank['org'], bank['reference']), set()) if bank['reference'] else set()
        explicit = set()
        for number in re.findall(r'\bAVI-\d{4}-\d{2}-\d{4}\b', bank['text']):
            explicit.update(numbers.get((bank['org'], number), set()))
        result[k] = bool(owners and explicit and owners.isdisjoint(explicit))
    return result


def answer(k):
    allocations = {k + '-avi-1': 4000 if k == 'B-partial' else 10000}
    if k == 'B-combined':
        allocations[k + '-avi-2'] = 4000
    return {'payment': k, 'action': 'confirm', 'claim': 'mine',
            'allocations': allocations, 'retainCredit': k == 'B-credit', 'note': ''}


class Service:
    def __init__(self, pg, moment=None):
        self.pg = pg
        self.schema = 'exp_cf_' + uuid.uuid4().hex[:12]
        self.moment = moment  # Test injection only; no HTTP clock parameter.
        self.tokens = {}  # Raw links stay in this process, never report snapshots.

    def now(self):
        return self.moment or datetime.now(timezone.utc)

    def sql(self, query):
        return self.pg.sql(query, self.schema)

    def value(self, query):
        return json.loads(self.sql(query))

    def bootstrap(self):
        notices = []
        controls = {}
        for k in b_inputs():
            for suffix, tenant, lease in [('avi-1', 'alice-tenant', k + '-home'),
                                           ('avi-2', 'alice-tenant', k + '-home'),
                                           ('garage', 'alice-tenant', k + '-garage'),
                                           ('foreign', 'bob-tenant', k + '-foreign')]:
                notices.append(Notice(k+'-'+suffix, ORG, tenant, lease, 'TEST', k+'-'+suffix,
                                      '', 2026, 9, '2026-09-30', '2026-09-01', 10000))
                controls[ORG, tenant, lease] = {'active': True, 'consent': False, 'refund': False}
        self.pg.setup(self.schema, notices, controls)
        self.pg.execute(self.schema, [{'kind': 'ISSUE', 'org': n.org, 'id': 'issue:'+n.id,
                                      'notice': n.id, 'date': n.issued, 'uses': []} for n in notices])
        self.sql((Path(__file__).with_suffix('.sql')).read_text())
        self.sql("INSERT INTO cf_person VALUES "
                 "('syntetisk','staff',NULL,'staff',true,true),"
                 "('syntetisk','alice','alice-tenant','customer',true,true),"
                 "('syntetisk','bob','bob-tenant','customer',true,true),"
                 "('other-org','alice','other-tenant','customer',true,true);")
        statements = []
        conflicts = original_conflicts()
        for k, bank in originals().items():
            statements.append(self.import_sql(k, bank, None, conflicts[k]))
        for k, bank in b_inputs().items():
            source = 'UNTRUSTED_CUSTOMER_RECEIPT' if k == 'B-forged' else 'SIMULATED_INDEPENDENT_ATTESTOR'
            authority = k != 'B-no-authority'
            statements.append('INSERT INTO cf_attestation VALUES (' + ','.join([
                literal(ORG), literal('proof:'+k), literal(k), js(bank), "'alice'", "'alice-tenant'",
                'ARRAY['+literal(k+'-home')+','+literal(k+'-garage')+']', literal(source),
                str(authority).lower(), "'SIMULATED_TEST_VERIFIER'", literal((self.now()-timedelta(hours=1)).isoformat()),
                literal((self.now()+timedelta(hours=2)).isoformat()), 'false'])+');')
            statements.append(self.import_sql(k, bank, 'proof:'+k, k == 'B-conflict'))
        self.sql('\n'.join(statements))
        return self

    def import_case(self, k, bank, attestation, conflict):
        # Atomic import comparison, including absence of evidence. Never resets a
        # consumed link or silently replaces immutable bank data on reimport.
        self.sql(self.import_sql(k, bank, attestation, conflict))

    @staticmethod
    def import_sql(k, bank, attestation, conflict):
        return (f"SELECT cf_import({literal(bank['org'])},{literal(k)},{js(bank)},"
                f"{literal(attestation) if attestation else 'NULL'},{str(conflict).lower()});")

    def route(self, k, actor=PRINCIPALS['staff']):
        org, person, _ = actor
        token = self.tokens.setdefault((org, k), secrets.token_urlsafe(32))
        return self.sql(f'SELECT cf_route({literal(org)},{literal(k)},{literal(person)},'
                        f'{literal(sha(token.encode()))},{literal(self.now().isoformat())});')

    def capture(self, k, actor=PRINCIPALS['staff']):
        org, person, _ = actor
        return self.sql(f'SELECT cf_capture({literal(org)},{literal(k)},{literal(person)},'
                        f'{literal(self.now().isoformat())});')

    def expire(self):
        return int(self.sql(f'SELECT cf_expire({literal(self.now().isoformat())});'))

    @staticmethod
    def validate(payload):
        if not isinstance(payload, dict) or set(payload) != {'payment','action','claim','allocations','retainCredit','note'}:
            raise Denied()
        if any(not isinstance(payload[x], str) or len(payload[x]) > 400 for x in ('payment','action','claim','note')):
            raise Denied()
        if type(payload['retainCredit']) is not bool or not isinstance(payload['allocations'], dict):
            raise Denied()
        if len(payload['allocations']) > 20 or any(not isinstance(k, str) or len(k) > 160 or type(v) is not int or
                                                not 0 < v <= 10**12 for k, v in payload['allocations'].items()):
            raise Denied()

    def reply_sql(self, k, token, request, payload, actor=PRINCIPALS['alice'], failpoint='', pause=0):
        self.validate(payload)
        if not isinstance(request, str) or not 1 <= len(request) <= 100 or len(token) > 200:
            raise Denied()
        org, person, _ = actor
        return (f'SELECT cf_reply({literal(org)},{literal(k)},{literal(person)},'
                f'{literal(sha(token.encode()))},{literal(request)},{js(payload)},'
                f'{literal(self.now().isoformat())},{literal(failpoint)},{int(pause)});')

    def reply(self, k, token, request, payload, actor=PRINCIPALS['alice'], failpoint=''):
        return self.value(self.reply_sql(k, token, request, payload, actor, failpoint))

    def customer(self, k, token, actor):
        org, person, role = actor
        if role != 'customer':
            raise Denied()
        # Project only own permitted notices. Original prose/reference may name a
        # competing person and is deliberately absent even for an invited person.
        result = self.value(f"SELECT coalesce((SELECT jsonb_build_object('payment',c.id,'status',c.status,"
            "'date',c.bank->>'date','amountOre',c.bank->'amount','testOnly',true,"
            "'notices',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'lease',n.lease,'debtOre',n.debt) ORDER BY n.id),'[]') "
            "FROM notice n JOIN scope s ON s.org=n.org AND s.tenant=n.tenant AND s.lease=n.lease "
            "WHERE n.org=c.org AND n.tenant=e.tenant AND n.lease=ANY(e.leases) AND n.issued AND s.active AND i.debts ? n.id),"
            "'credits',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'remainingOre',x.remaining)),'[]') "
            "FROM credit x WHERE x.org=c.org AND x.tenant=e.tenant AND x.lease=ANY(e.leases) AND x.remaining>0)) "
            "FROM cf_case c JOIN cf_invitation i ON i.org=c.org AND i.event=c.id "
            "JOIN cf_attestation e ON e.org=c.org AND e.id=c.attestation "
            f"WHERE c.org={literal(org)} AND c.id={literal(k)} AND i.person={literal(person)} "
            f"AND i.token_hash={literal(sha(token.encode()))} AND i.expires>{literal(self.now().isoformat())} "
            f"AND NOT i.consumed AND c.status='WAITING' AND i.binding=to_jsonb(e) AND i.person=e.person "
            f"AND cf_valid(c,{literal(self.now().isoformat())})), 'null');")
        if result is None:
            raise Denied()
        return result

    def mailbox(self, actor):
        org, person, role = actor
        if role != 'customer':
            raise Denied()
        rows = self.value("SELECT coalesce(jsonb_agg(jsonb_build_object('payment',c.id)),'[]') "
            "FROM cf_outbox b JOIN cf_case c ON c.org=b.org AND c.id=b.event "
            "JOIN cf_invitation i ON i.org=c.org AND i.event=c.id "
            "JOIN cf_attestation e ON e.org=c.org AND e.id=c.attestation "
            f"WHERE b.org={literal(org)} AND b.person={literal(person)} AND NOT i.consumed "
            f"AND c.status='WAITING' AND i.expires>{literal(self.now().isoformat())} "
            f"AND i.binding=to_jsonb(e) AND i.person=e.person AND cf_valid(c,{literal(self.now().isoformat())});")
        return [{'payment': r['payment'], 'token': self.tokens[(org, r['payment'])]} for r in rows
                if (org, r['payment']) in self.tokens]

    def customer_credits(self, actor):
        org, person, role = actor
        if role != 'customer':
            raise Denied()
        # Already recorded own credit remains visible after consuming a question.
        return self.value("SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'lease',x.lease,"
            "'payment',x.bank_event,'remainingOre',x.remaining)),'[]') FROM credit x "
            "JOIN cf_person p ON p.org=x.org AND p.tenant=x.tenant "
            f"WHERE p.org={literal(org)} AND p.id={literal(person)} AND p.active AND p.role='customer' "
            "AND x.remaining>0 AND NOT x.reversed;")

    def staff(self, actor):
        org, person, role = actor
        if role != 'staff' or self.sql(f"SELECT count(*) FROM cf_person WHERE org={literal(org)} AND id={literal(person)} AND role='staff' AND active;") != '1':
            raise Denied()
        return self.value("SELECT jsonb_build_object('cases',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') "
            f"FROM cf_case c WHERE org={literal(org)}),'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY seq),'[]') "
            f"FROM cf_audit a WHERE org={literal(org)}),'credits',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') "
            f"FROM credit x WHERE org={literal(org)}));")

    def snapshot(self):
        result = self.pg.snapshot(self.schema)
        fields = []
        for table in CF_TABLES:
            fields.extend([literal(table), f"(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {table} t)"])
        result.update(self.value('SELECT jsonb_build_object('+','.join(fields)+');'))
        return result


def run_scenarios(s):
    """A all 20 originals; B new inputs and simulated replies, never a 2,000 replay."""
    for k in originals():
        s.route(k)
    for k in b_inputs():
        if s.route(k) != 'DRAFT' or k == 'B-draft':
            continue
        s.capture(k)
        if k in ('B-no-response', 'B-expired'):
            continue
        p = answer(k)
        if k == 'B-decline':
            p['action'] = 'decline'
        if k == 'B-contradictory':
            p['claim'] = 'not-mine'
        if k == 'B-debt-changed':
            s.sql(f"UPDATE notice SET debt=debt-1 WHERE org={literal(ORG)} AND id={literal(k+'-avi-1')};")
        s.reply(k, s.tokens[ORG,k], 'scenario:'+k, p)
    # Only one deliberately expired link. Other waiting/draft cases stay pending.
    s.sql(f"UPDATE cf_invitation SET expires={literal((s.now()-timedelta(seconds=1)).isoformat())} WHERE event='B-expired';")
    s.expire()
