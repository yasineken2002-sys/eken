"""Independent edge cases; do not derive expectations from the matcher."""
from copy import deepcopy
from dataclasses import replace
import unittest

from referensprov_policy import Bank, Notice, checksum, decide, valid_ocr
from eval_referensprov import load_verified, project


def ref(number):
    base = str(number).zfill(10)
    return base + checksum(base)


class ReferenceDecisionTest(unittest.TestCase):
    def setUp(self):
        self.sep = Notice('sep', 'org', 'sara', 'flat', 'Sara Svensson', 'AVI-2026-09-0001',
                          ref(1), 2026, 9, '2026-08-31', '2026-08-15', 10000, ref(9001))
        self.oct = replace(self.sep, id='oct', number='AVI-2026-10-0001', month=10,
                           due='2026-09-30', issued='2026-09-15', unique_ref=ref(9002))
        self.other = replace(self.oct, id='other', tenant='anna', lease='other-flat',
                             name='Anna Andersson', number='AVI-2026-10-0002', ocr=ref(2), unique_ref=ref(9003))
        self.bank = Bank('org', '2026-10-25', 10000, 'Hyra Sara Svensson', ref(1))

    def test_explicit_current_invoice_over_old_debt(self):
        d = decide(replace(self.bank, text='Hyra AVI-2026-10-0001 Sara Svensson'), [self.sep, self.oct])
        self.assertEqual(d.allocations, (('oct', 10000),))

    def test_conflicting_paid_and_unpaid_ocr_owner_both_stop(self):
        for debt in (0, 10000):
            d = decide(replace(self.bank, text='Hyra AVI-2026-10-0001 Sara Svensson', reference=ref(2)),
                       [self.oct, replace(self.other, debt=debt)])
            self.assertEqual(d.reason, 'IDENTITETSKONFLIKT')

    def test_period_is_rent_period_not_due_date_or_bank_month(self):
        d = decide(replace(self.bank, text='Hyra oktober 2026 Sara Svensson', reference=''), [self.sep, self.oct])
        self.assertEqual(d.allocations, (('oct', 10000),))

    def test_no_bank_date_inference_for_missing_year(self):
        self.assertFalse(decide(replace(self.bank, text='Hyra oktober Sara Svensson'), [self.oct]).allocations)

    def test_name_without_period_never_amount_only_match(self):
        self.assertFalse(decide(replace(self.bank, reference=''), [self.oct]).allocations)

    def test_name_collision_including_paid_account_is_not_unique(self):
        for debt in (0, 10000):
            d = decide(replace(self.bank, text='Hyra oktober 2026 Sara Svensson', reference=''),
                       [self.oct, replace(self.other, name='Sara Svensson', debt=debt)])
            self.assertEqual(d.reason, 'IDENTITETSKONFLIKT')

    def test_shared_ocr_across_contracts_requires_invoice(self):
        garage = replace(self.oct, id='garage', lease='garage', number='AVI-2026-10-0003', unique_ref=ref(9004))
        self.assertFalse(decide(self.bank, [self.oct, garage]).allocations)
        self.assertFalse(decide(replace(self.bank, text='Hyra oktober 2026 Sara Svensson'), [self.oct, garage]).allocations)
        self.assertEqual(decide(replace(self.bank, reference=garage.unique_ref), [self.oct, garage]).allocations, (('garage', 10000),))

    def test_old_ocr_partial_and_combined_payments_still_work(self):
        self.assertEqual(decide(replace(self.bank, amount=4000), [self.sep, self.oct]).allocations, (('sep', 4000),))
        self.assertEqual(decide(replace(self.bank, amount=16000), [self.sep, self.oct]).allocations, (('sep', 10000), ('oct', 6000)))
        self.assertEqual(decide(replace(self.bank, amount=20000), [self.sep, self.oct]).allocations, (('sep', 10000), ('oct', 10000)))

    def test_explicit_overpayment_cannot_spill_into_old_debt(self):
        d = decide(replace(self.bank, amount=12500, text='AVI-2026-10-0001'), [self.sep, self.oct])
        self.assertEqual(d.reason, 'OVERSKOTT_KRAVER_HANTERING')

    def test_multiple_invoice_references_do_not_choose_first(self):
        for text in ('AVI-2026-09-0001 AVI-2026-10-0001', 'AVI-2026-10-0001 AVI-2026-09-0001'):
            self.assertFalse(decide(replace(self.bank, text=text), [self.sep, self.oct]).allocations)

    def test_explicit_reference_and_period_disagree(self):
        self.assertEqual(decide(replace(self.bank, text='AVI-2026-10-0001 september 2026'), [self.sep, self.oct]).reason, 'PERIODKONFLIKT')

    def test_other_organization_and_not_yet_issued_excluded(self):
        for n in (replace(self.oct, org='foreign'), replace(self.oct, issued='2026-11-01')):
            self.assertFalse(decide(self.bank, [n]).allocations)

    def test_year_that_passes_checksum_is_not_owned_ocr(self):
        self.assertTrue(valid_ocr('2026'))
        d = decide(replace(self.bank, reference='', text='Hyra oktober 2026 Sara Svensson'), [self.sep, self.oct])
        self.assertEqual(d.allocations, (('oct', 10000),))

    def test_unknown_valid_explicit_ocr_stops_even_with_good_name(self):
        d = decide(replace(self.bank, reference=ref(888), text='Hyra oktober 2026 Sara Svensson'), [self.oct])
        self.assertEqual(d.reason, 'OKAND_GILTIG_REFERENS')

    def test_single_bad_check_digit_requires_name_and_period(self):
        typo = ref(1)[:-1] + str((int(ref(1)[-1]) + 1) % 10)
        b = replace(self.bank, reference=typo, text='Hyra oktober 2026 Sara Svensson')
        self.assertEqual(decide(b, [self.oct]).allocations, (('oct', 10000),))
        self.assertFalse(decide(replace(b, text='Hyra'), [self.oct]).allocations)

    def test_unique_reference_retains_paid_identity_for_conflict(self):
        d = decide(replace(self.bank, reference=self.other.unique_ref), [self.oct, replace(self.other, debt=0)])
        self.assertEqual(d.reason, 'IDENTITETSKONFLIKT')

    def test_negated_intent_never_becomes_positive_reference(self):
        self.assertFalse(decide(replace(self.bank, text='Inte AVI-2026-10-0001'), [self.oct]).allocations)

    def test_unknown_reference_and_prefix_do_not_match(self):
        for text in ('AVI-2026-10-9999', 'AVI-2026-10-00010'):
            self.assertFalse(decide(replace(self.bank, text=text), [self.oct]).allocations)

    def test_invalid_amount_and_overfull_debt_stop(self):
        for amount in (-1, 0, 10001, 1.2, True):
            self.assertFalse(decide(replace(self.bank, amount=amount), [self.oct]).allocations)

    def test_legacy_without_period_explicitly_keeps_oldest_first_policy(self):
        self.assertEqual(decide(self.bank, [self.oct, self.sep]).allocations, (('sep', 10000),))

    def test_garage_ref_collision_does_not_silently_select_one(self):
        collision = replace(self.oct, id='collision', lease='garage')
        self.assertFalse(decide(replace(self.bank, reference=self.oct.unique_ref), [self.oct, collision]).allocations)

    def test_projection_never_reads_gold(self):
        world = load_verified('grund/kund-och-facit.json.gz')
        saved = load_verified('grund/AGENT_PA.json.gz')
        poisoned = deepcopy(world)
        for p in poisoned['betalningar']:
            p['facit'] = {'POISON': 'Must not reach matcher'}
        for mode in (False, True):
            self.assertEqual(project(world, saved, mode), project(poisoned, saved, mode))

    def test_unique_reference_selects_current_invoice_despite_old_debt(self):
        d = decide(replace(self.bank, reference=self.oct.unique_ref), [self.sep, self.oct])
        self.assertEqual(d.allocations, (('oct', 10000),))

    def test_partial_payment_for_explicit_current_invoice(self):
        d = decide(replace(self.bank, amount=4000, text='AVI-2026-10-0001'), [self.sep, self.oct])
        self.assertEqual(d.allocations, (('oct', 4000),))

    def test_unique_and_legacy_reference_namespace_collision_stops(self):
        collision = replace(self.other, unique_ref=self.oct.ocr)
        self.assertFalse(decide(self.bank, [self.oct, collision]).allocations)

    def test_name_substring_is_not_an_identity(self):
        d = decide(replace(self.bank, text='Hyra oktober 2026 Sara Svenssonsson', reference=''), [self.oct])
        self.assertFalse(d.allocations)

    def test_reference_and_name_contradiction_stops_without_ocr(self):
        d = decide(replace(self.bank, text='AVI-2026-10-0002 Sara Svensson', reference=''), [self.oct, self.other])
        self.assertEqual(d.reason, 'IDENTITETSKONFLIKT')

    def test_opaque_ids_do_not_encode_a_hidden_answer(self):
        b = replace(self.bank, text='Hyra oktober 2026 Sara Svensson', reference='')
        original = decide(b, [self.sep, self.oct])
        renamed = [replace(self.sep, id='random-a', tenant='unknown', lease='x'),
                   replace(self.oct, id='random-z', tenant='unknown', lease='x')]
        self.assertEqual(original.allocations, (('oct', 10000),))
        self.assertEqual(decide(b, renamed).allocations, (('random-z', 10000),))


if __name__ == '__main__':
    unittest.main(verbosity=2)
