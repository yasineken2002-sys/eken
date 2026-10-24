"""New independent edge cases. Original 28 tests and policy stay unchanged."""
from copy import deepcopy
from dataclasses import asdict, replace
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from eval_referensprov import load_verified, project
from eval_overskottsprov import project_public
from overskottsprov_policy import State, apply_event, decide_surplus, InterruptedCommit
from referensprov_policy import Bank, Notice, checksum


def ref(number):
    base = str(number).zfill(10)
    return base + checksum(base)


class SurplusTest(unittest.TestCase):
    def setUp(self):
        self.notice = Notice('current', 'org', 'sara', 'flat', 'Sara Svensson',
            'AVI-2026-10-0001', ref(1), 2026, 10, '2026-09-30', '2026-09-15', 10000)
        self.old = replace(self.notice, id='old', number='AVI-2026-09-0001', month=9,
                           due='2026-08-31', issued='2026-08-15')
        self.other = replace(self.notice, id='other', tenant='anna', lease='another-flat',
                           name='Anna Andersson', number='AVI-2026-10-0002', ocr=ref(2))
        self.bank = Bank('org', '2026-10-25', 12500, 'Hyra AVI-2026-10-0001 Sara Svensson', ref(1))
        self.state = State((self.old, self.notice))

    def assert_blocked(self, bank, notices):
        before = State(tuple(notices))
        after, result, duplicate = apply_event(before, 'event', bank)
        self.assertFalse(result.allocations)
        self.assertIsNone(result.credit)
        self.assertTrue(result.human_review)
        self.assertEqual(before.notices, after.notices)
        self.assertEqual(before.credits, after.credits)
        self.assertFalse(duplicate)
        return result

    def test_explicit_surplus_never_spills_into_older_notice(self):
        after, result, _ = apply_event(self.state, 'event', self.bank)
        self.assertEqual(result.allocations, (('current', 10000),))
        self.assertEqual([n.debt for n in after.notices], [10000, 0])
        self.assertEqual(result.credit.amount, 2500)
        self.assertEqual((result.credit.org, result.credit.tenant, result.credit.lease,
                          result.credit.bank_event, result.credit.notice),
                         ('org', 'sara', 'flat', 'event', 'current'))
        self.assertFalse(result.allocation_review)
        self.assertTrue(result.human_review)
        self.assertEqual(result.credit.status, 'PENDING_HUMAN_REVIEW')
        self.assertEqual(len(result.credit.pending_decisions), 3)

    def test_ocr_conflict_with_other_notice_open(self):
        self.assertEqual(self.assert_blocked(replace(self.bank, reference=ref(2)),
            [self.notice, self.other]).reason, 'IDENTITETSKONFLIKT')

    def test_ocr_conflict_with_other_notice_paid(self):
        self.assertEqual(self.assert_blocked(replace(self.bank, reference=ref(2)),
            [self.notice, replace(self.other, debt=0)]).reason, 'IDENTITETSKONFLIKT')

    def test_name_collision_including_paid_tenant(self):
        for debt in (0, 10000):
            with self.subTest(debt=debt):
                self.assert_blocked(self.bank, [self.notice,
                    replace(self.other, name=self.notice.name, debt=debt)])

    def test_parallel_contracts_without_explicit_notice_stop(self):
        garage = replace(self.notice, id='garage', lease='garage', number='AVI-2026-10-0003')
        self.assert_blocked(replace(self.bank, text='Hyra oktober 2026 Sara Svensson'), [self.notice, garage])

    def test_duplicate_explicit_notice_number_across_contracts_stops(self):
        self.assert_blocked(self.bank, [self.notice, replace(self.notice, id='garage', lease='garage')])

    def test_unique_explicit_number_resolves_parallel_contract(self):
        garage = replace(self.notice, id='garage', lease='garage', number='AVI-2026-10-0003')
        result = decide_surplus('event', self.bank, (self.notice, garage))
        self.assertEqual(result.allocations, (('current', 10000),))
        self.assertEqual(result.credit.lease, 'flat')

    def test_foreign_org_cannot_be_allocated_or_credited(self):
        self.assert_blocked(self.bank, [replace(self.notice, org='foreign')])

    def test_foreign_org_remains_unchanged_with_colliding_local_id(self):
        foreign = replace(self.notice, org='foreign')
        state, result, _ = apply_event(State((self.notice, foreign)), 'event', self.bank)
        self.assertEqual([n.debt for n in state.notices], [0, 10000])
        self.assertEqual(result.credit.org, 'org')

    def test_org_scoped_event_identity_allows_two_organizations(self):
        foreign = replace(self.notice, org='foreign')
        state, _, _ = apply_event(State((self.notice, foreign)), 'same-event', self.bank)
        state, _, duplicate = apply_event(state, 'same-event', replace(self.bank, org='foreign'))
        self.assertFalse(duplicate)
        self.assertEqual(len(state.credits), 2)
        self.assertEqual(len({c.id for c in state.credits}), 2)

    def test_duplicate_event_returns_same_state_no_double_credit(self):
        state, outcome, _ = apply_event(self.state, 'event', self.bank)
        again, result, duplicate = apply_event(state, 'event', self.bank)
        self.assertIs(again, state)
        self.assertEqual(result, outcome)
        self.assertTrue(duplicate)
        self.assertEqual(len(state.credits), 1)

    def test_reimport_serialized_bank_same_id_no_double_credit(self):
        state, _, _ = apply_event(self.state, 'event', self.bank)
        reimported = Bank(**json.loads(json.dumps(asdict(self.bank))))
        again, _, duplicate = apply_event(state, 'event', reimported)
        self.assertTrue(duplicate)
        self.assertIs(again, state)
        self.assertEqual(sum(c.amount for c in again.credits), 2500)

    def test_reused_id_with_changed_payload_rejected(self):
        state, _, _ = apply_event(self.state, 'event', self.bank)
        with self.assertRaisesRegex(ValueError, 'PAYLOAD_CONFLICT'):
            apply_event(state, 'event', replace(self.bank, amount=12600))
        self.assertEqual(sum(c.amount for c in state.credits), 2500)

    def test_two_legitimate_identical_amount_events_both_allocate(self):
        small = replace(self.bank, amount=4000)
        state, _, _ = apply_event(self.state, 'first', small)
        state, _, duplicate = apply_event(state, 'second', small)
        self.assertFalse(duplicate)
        self.assertEqual(state.notices[1].debt, 2000)
        self.assertEqual(len(state.receipts), 2)

    def test_partial_then_surplus_uses_remaining_debt(self):
        state, first, _ = apply_event(self.state, 'partial', replace(self.bank, amount=4000))
        self.assertEqual(first.allocations, (('current', 4000),))
        self.assertIsNone(first.credit)
        state, second, _ = apply_event(state, 'rest', replace(self.bank, amount=8500))
        self.assertEqual(second.allocations, (('current', 6000),))
        self.assertEqual(second.credit.amount, 2500)
        self.assertEqual(state.notices[0].debt, 10000)

    def test_multiple_explicit_notices_stop(self):
        for text in (self.old.number + ' ' + self.notice.number, self.notice.number + ' ' + self.old.number):
            self.assert_blocked(replace(self.bank, text=text, amount=22500), self.state.notices)

    def test_no_explicit_notice_no_new_surplus_path(self):
        self.assert_blocked(replace(self.bank, text='Hyra oktober 2026 Sara Svensson'), [self.notice])
        self.assert_blocked(replace(self.bank, text='Hyra Sara Svensson', amount=22500), self.state.notices)

    def test_existing_combined_payment_preserved_and_spends_no_credit(self):
        result = decide_surplus('combined', replace(self.bank, text='Hyra Sara Svensson', amount=16000), self.state.notices)
        self.assertEqual(result.allocations, (('old', 10000), ('current', 6000)))
        self.assertIsNone(result.credit)

    def test_ten_months_keep_ten_credits_no_automatic_offset(self):
        notices = tuple(replace(self.notice, id=f'n-{m}', number=f'AVI-2026-{m:02d}-0001',
            month=m, issued=f'2026-{m:02d}-01', due=f'2026-{m:02d}-28', debt=977500) for m in range(1, 11))
        state = State(notices)
        for month, notice in enumerate(notices, 1):
            bank = replace(self.bank, date=f'2026-{month:02d}-25', amount=980000,
                           text=notice.number + ' Sara Svensson')
            state, result, _ = apply_event(state, f'bank-{month}', bank)
            self.assertEqual(result.allocations, ((notice.id, 977500),))
            self.assertEqual(sum(c.amount for c in state.credits), month * 2500)
            self.assertEqual(len(state.credits), month)
        self.assertEqual({c.tenant for c in state.credits}, {'sara'})
        self.assertEqual(len({c.bank_event for c in state.credits}), 10)
        self.assertTrue(all(n.debt == 0 for n in state.notices))

    def test_interruption_after_debt_does_not_publish_partial_state(self):
        with self.assertRaises(InterruptedCommit):
            apply_event(self.state, 'event', self.bank, interrupt_at='after_debt')
        self.assertEqual([n.debt for n in self.state.notices], [10000, 10000])
        self.assertEqual((self.state.credits, self.state.receipts), ((), ()))
        committed, _, _ = apply_event(self.state, 'event', self.bank)
        self.assertEqual(len(committed.credits), 1)
        self.assertEqual(committed.notices[1].debt, 0)

    def test_interruption_after_credit_retry_preserves_existing_credit(self):
        state, _, _ = apply_event(self.state, 'old-event', replace(self.bank, text=self.old.number))
        with self.assertRaises(InterruptedCommit):
            apply_event(state, 'current-event', self.bank, interrupt_at='after_credit')
        self.assertEqual([n.debt for n in state.notices], [0, 10000])
        self.assertEqual(len(state.credits), 1)
        committed, _, _ = apply_event(state, 'current-event', self.bank)
        self.assertEqual(len(committed.credits), 2)
        self.assertEqual(committed.credits[0], state.credits[0])

    def test_paid_explicit_notice_not_redirected_to_open_debt(self):
        self.assert_blocked(self.bank, [self.old, replace(self.notice, debt=0)])

    def test_small_surplus_never_absorbed(self):
        for extra in (1, 100, 101, 2500):
            with self.subTest(extra=extra):
                result = decide_surplus('event', replace(self.bank, amount=10000+extra), self.state.notices)
                self.assertEqual(result.credit.amount, extra)
                self.assertEqual(result.allocations, (('current', 10000),))

    def test_invalid_amounts_have_no_effect(self):
        for amount in (-1, 0, 10000.5, True):
            self.assert_blocked(replace(self.bank, amount=amount), self.state.notices)

    def test_unknown_reference_and_period_conflict_do_not_bypass_gate(self):
        for bank in (replace(self.bank, reference=ref(999)),
                     replace(self.bank, text=self.notice.number + ' september 2026 Sara Svensson'),
                     replace(self.bank, text='Inte ' + self.bank.text)):
            self.assert_blocked(bank, self.state.notices)

    def test_gold_and_scenario_poison_cannot_change_public_inputs(self):
        world = load_verified('grund/kund-och-facit.json.gz')
        saved = load_verified('grund/AGENT_PA.json.gz')
        poisoned = deepcopy(world)
        for payment in poisoned['betalningar']:
            payment['facit'] = object()
            payment['typ'] = object()
        expected = project_public(world, saved)
        self.assertEqual(project_public(poisoned, saved), expected)
        old_notices, old_banks, changed = project(world, saved, False)
        self.assertFalse(changed)
        self.assertEqual(expected, (tuple(old_notices), old_banks))

    def test_opaque_ids_carry_no_scenario_answer(self):
        notices = (replace(self.notice, id='opaque-z', tenant='opaque-person', lease='opaque-lease'),)
        result = decide_surplus('opaque-bank', self.bank, notices)
        self.assertEqual(result.allocations, (('opaque-z', 10000),))
        self.assertEqual((result.credit.tenant, result.credit.bank_event), ('opaque-person', 'opaque-bank'))

    def test_no_network_needed_and_contract_pending_decisions_match(self):
        with patch('socket.socket', side_effect=AssertionError('Network forbidden')):
            _, result, _ = apply_event(self.state, 'event', self.bank)
        root = Path(__file__).resolve().parents[3]
        contract = json.loads((root/'docs/eval/overskottsprov/policy-v1.json').read_text())
        self.assertEqual(list(result.credit.pending_decisions), contract['creditPendingDecisions'])
        self.assertEqual(result.credit.policy, contract['policyVersion'])

    def test_missing_event_identity_cannot_create_credit(self):
        for event in ('', ' ', None):
            with self.assertRaises(ValueError):
                apply_event(self.state, event, self.bank)


if __name__ == '__main__':
    unittest.main(verbosity=2)
