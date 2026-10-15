"""Explicit proposal tests: held funds are never relabelled as settled money."""
from dataclasses import replace
from unittest.mock import patch
import unittest

from referensprov_policy import Bank, Decision, Notice, decide
from referensprov_ledger import SimulationLedger


class SurplusTest(unittest.TestCase):
    def setUp(self):
        self.sep = Notice('sep', 'org', 'sara', 'flat', 'Sara Svensson',
                          'AVI-2026-09-0001', '00000000019', 2026, 9,
                          '2026-08-31', '2026-08-15', 10000)
        self.oct = replace(self.sep, id='oct', number='AVI-2026-10-0001', month=10,
                           due='2026-09-30', issued='2026-09-15')
        self.bank = Bank('org', '2026-10-25', 12500, 'Hyra AVI-2026-10-0001', self.oct.ocr)

    def test_default_policy_still_requires_review(self):
        d = decide(self.bank, [self.sep, self.oct])
        self.assertFalse(d.allocations)
        self.assertEqual(d.held_surplus, 0)

    def test_exact_notice_is_paid_surplus_is_preserved_and_old_debt_unchanged(self):
        ledger = SimulationLedger([self.sep, self.oct])
        r = ledger.process('source-1', 'fixture-1', self.bank)
        self.assertEqual(r.decision.allocations, (('oct', 10000),))
        self.assertEqual(r.hold.amount, 2500)
        self.assertEqual((r.hold.org, r.hold.tenant, r.hold.lease, r.hold.notice_id),
                         ('org', 'sara', 'flat', 'oct'))
        self.assertEqual(r.hold.status, 'HELD_PENDING_DISPOSITION')
        self.assertEqual([n.debt for n in ledger.notices], [10000, 0])
        self.assertEqual(ledger.verify()['bankOre'], 12500)

    def test_held_balance_is_not_used_on_later_rent_and_replay_does_not_duplicate(self):
        ledger = SimulationLedger([self.sep, self.oct])
        first = ledger.process('source-1', 'fixture-1', self.bank)
        ledger.process('source-2', 'fixture-2', replace(self.bank, amount=4000, text='AVI-2026-09-0001'))
        snapshot = (ledger.notices, dict(ledger.receipts))
        self.assertIs(ledger.process('source-1', 'fixture-1', self.bank), first)
        self.assertEqual(snapshot, (ledger.notices, ledger.receipts))
        self.assertEqual(ledger.verify(), {'bankOre': 16500, 'allocatedOre': 14000,
                         'heldOre': 2500, 'unresolvedOre': 0, 'uniqueSourcePayments': 2})

    def test_changed_replay_is_rejected_without_effects(self):
        ledger = SimulationLedger([self.sep, self.oct])
        ledger.process('source-1', 'fixture-1', self.bank)
        snapshot = (ledger.notices, dict(ledger.receipts))
        for bank in (replace(self.bank, amount=12501), replace(self.bank, text='Hyra'),
                     replace(self.bank, reference=''), replace(self.bank, date='2026-10-26')):
            with self.subTest(bank=bank), self.assertRaises(ValueError):
                ledger.process('source-1', 'fixture-1', bank)
            self.assertEqual(snapshot, (ledger.notices, ledger.receipts))

    def test_same_source_id_in_other_org_cannot_touch_first_org(self):
        foreign = replace(self.oct, org='foreign')
        ledger = SimulationLedger([self.sep, self.oct, foreign])
        ledger.process('source-1', 'fixture-1', self.bank)
        ledger.process('source-1', 'fixture-foreign', replace(self.bank, org='foreign'))
        self.assertEqual(ledger.verify()['heldOre'], 5000)
        self.assertEqual(ledger.notices[0].debt, 10000)

    def test_no_hold_without_explicit_notice_or_with_uncertain_intent(self):
        for text in ('Hyra', 'Hyra oktober 2026', 'Hyra 2026-10', 'Avser ej AVI-2026-10-0001',
                     'Kanske AVI-2026-10-0001', 'AVI-2026-09-0001 AVI-2026-10-0001'):
            with self.subTest(text=text):
                d = decide(replace(self.bank, text=text), [self.oct], hold_surplus=True)
                self.assertFalse(d.allocations)
                self.assertEqual(d.held_surplus, 0)

    def test_paid_unknown_foreign_future_conflicting_notice_cannot_create_hold(self):
        other = replace(self.sep, tenant='anna', name='Anna Andersson', ocr='00000000028')
        cases = [([replace(self.oct, debt=0)], self.bank),
                 ([replace(self.oct, org='foreign')], self.bank),
                 ([replace(self.oct, issued='2026-11-01')], self.bank),
                 ([self.sep], self.bank),
                 ([self.oct, other], replace(self.bank, reference=other.ocr))]
        for notices, bank in cases:
            with self.subTest(notices=notices):
                d = decide(bank, notices, hold_surplus=True)
                self.assertFalse(d.allocations)
                self.assertEqual(d.held_surplus, 0)

    def test_parallel_contract_is_safe_only_with_explicit_notice(self):
        garage = replace(self.oct, id='garage', lease='garage', number='AVI-2026-10-0002')
        ledger = SimulationLedger([self.oct, garage])
        r = ledger.process('source-1', 'fixture-1', self.bank)
        self.assertEqual(r.hold.notice_id, 'oct')
        self.assertEqual(ledger.notices[1].debt, 10000)

    def test_varied_surpluses_are_conserved_not_special_cased_to_fixture_25kr(self):
        for surplus in (1, 2499, 2500, 2501, 123456):
            with self.subTest(surplus=surplus):
                ledger = SimulationLedger([self.oct])
                ledger.process('s', 'f', replace(self.bank, amount=10000 + surplus))
                self.assertEqual(ledger.verify()['heldOre'], surplus)

    def test_invalid_staged_effects_leave_ledger_unchanged(self):
        for bad in (Decision('bad', (('oct', 10001),), 2499),
                    Decision('bad', (('oct', 10000),), 2499),
                    Decision('bad', (('missing', 10000),), 2500)):
            ledger = SimulationLedger([self.oct])
            with patch('referensprov_ledger.decide', return_value=bad), self.assertRaises(ValueError):
                ledger.process('s', 'f', self.bank)
            self.assertEqual(ledger.notices, (self.oct,))
            self.assertEqual(ledger.receipts, {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
