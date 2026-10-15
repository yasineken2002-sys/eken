"""Independent bank-text regressions for the isolated reference experiment.

Expected allocations below are hand-written business outcomes.  This module
imports only the pure experiment API: no saved gold, database, or matcher parser.
The deliberately small accepted grammar must not turn other period language
into permission to pay an older invoice.
"""
from dataclasses import replace
import unittest

from referensprov_policy import Bank, Notice, decide


# Literal bank-message examples and literal outcomes, not generated from MONTHS
# or any normalization/period helper used by the implementation.
OCTOBER_TEXT = (
    ('full month', 'Hyra oktober 2026'),
    ('uppercase', 'HYRA OKTOBER 2026'),
    ('extra whitespace', '  Hyra\t oktober   2026  '),
    ('abbreviation', 'Hyra okt 2026'),
    ('abbreviation with stop', 'Hyra okt. 2026'),
    ('bank punctuation', '(HYRA: OKT. 2026)'),
    ('year-month dash', 'Hyra 2026-10'),
    ('year-month slash', 'Hyra 2026/10'),
    ('month-year slash', 'Hyra 10/2026'),
    ('period label', 'HYRA PERIOD 2026-10'),
    ('same period repeated', 'Hyra oktober 2026 (2026-10)'),
)

REVIEW_TEXT = (
    ('full month without year', 'Hyra oktober'),
    ('abbreviation without year', 'Hyra okt'),
    ('abbreviation stop without year', 'Hyra okt.'),
    ('two-digit named year', 'Hyra okt 26'),
    ('two-digit numeric year', 'Hyra 10/26'),
    ('two-digit year first', 'Hyra 26-10'),
    ('full ISO day', 'Hyra 2026-10-01'),
    ('slash day first', 'Hyra 01/10/2026'),
    ('slash year first day', 'Hyra 2026/10/01'),
    ('written day', 'Hyra 1 oktober 2026'),
    ('compact date', 'Hyra 202610'),
    ('unsupported month-year dash', 'Hyra 10-2026'),
    ('unsupported dotted date', 'Hyra 2026.10'),
    ('invalid month', 'Hyra 2026-13'),
    ('zero month', 'Hyra 00/2026'),
    ('year alone', 'Hyra 2026'),
    ('period label without a period', 'Hyra period'),
    ('month label without a period', 'Hyra för månad'),
    ('next month', 'Hyra nästa månad'),
    ('previous month', 'Hyra förra månaden'),
    ('current month', 'Hyra innevarande månad'),
    ('this month', 'Hyra denna månad'),
    ('quarter', 'Hyra Q4 2026'),
    ('season', 'Hyra hösten 2026'),
    ('misspelled month', 'Hyra oktoberr 2026'),
    ('negated period', 'Hyra ej oktober 2026'),
    ('negated payment', 'Ej hyra'),
    ('uncertain before period', 'Hyra kanske oktober 2026'),
    ('uncertain after period', 'Hyra oktober 2026, osäker'),
    ('uncertain without period', 'Kanske hyra'),
    ('questioned period', 'Hyra oktober 2026?'),
    ('unicode questioned period', 'Hyra oktober 2026❓'),
    ('uncertain symbol', 'Hyra oktober 2026 🤔'),
    ('two named months', 'Hyra september och oktober 2026'),
    ('two abbreviations', 'Hyra sep 2026 och okt 2026'),
    ('two numeric periods', 'Hyra 2026-09 och 2026-10'),
    ('two month-year periods', 'Hyra 09/2026, 10/2026'),
    ('two years', 'Hyra oktober 2025 och oktober 2026'),
    ('named range', 'Hyra september–oktober 2026'),
    ('numeric range', 'Hyra 2026-09–2026-10'),
    ('alternative periods', 'Hyra okt 2026 eller nov 2026'),
)


class BankTextRegressionTest(unittest.TestCase):
    def setUp(self):
        # Shared tenant OCR deliberately cannot distinguish the two debts.
        self.sep = Notice(
            'sep', 'org', 'sara', 'flat', 'Sara Svensson',
            'AVI-2026-09-0001', '00000000019', 2026, 9,
            '2026-08-31', '2026-08-15', 10000, '00000090010',
        )
        self.oct = replace(
            self.sep, id='oct', number='AVI-2026-10-0001', month=10,
            due='2026-09-30', issued='2026-09-15', unique_ref='00000090029',
        )
        self.notices = [self.sep, self.oct]
        self.bank = Bank('org', '2026-10-25', 10000, 'Hyra', self.oct.ocr)

    def assert_review(self, decision):
        self.assertEqual(decision.allocations, (), decision.reason)
        self.assertNotEqual(decision.reason, 'AUTOMATISK')

    def test_supported_bank_text_selects_october_over_september(self):
        for label, text in OCTOBER_TEXT:
            with self.subTest(style=label):
                decision = decide(replace(self.bank, text=text), self.notices)
                self.assertEqual(decision.reason, 'AUTOMATISK')
                self.assertEqual(decision.allocations, (('oct', 10000),))

    def test_supported_bank_text_and_name_work_without_ocr(self):
        for label, text in OCTOBER_TEXT:
            with self.subTest(style=label):
                bank = replace(self.bank, text=text + ' Sara Svensson', reference='')
                self.assertEqual(decide(bank, self.notices).allocations, (('oct', 10000),))

    def test_unsupported_or_ambiguous_text_never_falls_back_to_september(self):
        for label, text in REVIEW_TEXT:
            with self.subTest(style=label):
                self.assert_review(decide(replace(self.bank, text=text), self.notices))

    def test_unsupported_text_cannot_be_overridden_by_an_explicit_invoice(self):
        for label, text in REVIEW_TEXT:
            with self.subTest(style=label):
                bank = replace(self.bank, text=text + ' AVI-2026-10-0001')
                self.assert_review(decide(bank, self.notices))

    def test_unsupported_text_cannot_be_overridden_by_unique_reference(self):
        for label, text in REVIEW_TEXT:
            with self.subTest(style=label):
                bank = replace(self.bank, text=text, reference=self.oct.unique_ref)
                self.assert_review(decide(bank, self.notices))

    def test_supported_period_is_not_inferred_from_bank_date(self):
        for label, text in OCTOBER_TEXT:
            with self.subTest(style=label):
                bank = replace(self.bank, date='2026-11-25', text=text)
                self.assertEqual(decide(bank, self.notices).allocations, (('oct', 10000),))

    def test_period_disabled_does_not_erase_explicit_period_intent(self):
        for label, text in OCTOBER_TEXT:
            with self.subTest(style=label):
                bank = replace(self.bank, text=text)
                self.assert_review(decide(bank, self.notices, period_support=False))

    def test_conflicting_period_and_october_invoice_stop_in_either_order(self):
        for period in ('september 2026', 'sep 2026', 'sept. 2026', '2026-09', '2026/09', '09/2026'):
            for text in (period + ' AVI-2026-10-0001', 'AVI-2026-10-0001 ' + period):
                with self.subTest(text=text):
                    self.assert_review(decide(replace(self.bank, text=text), self.notices))

    def test_multiple_explicit_invoices_stop_in_either_order(self):
        for text in (
            'Hyra AVI-2026-09-0001 AVI-2026-10-0001',
            'Hyra AVI-2026-10-0001 AVI-2026-09-0001',
        ):
            for september_debt in (0, 10000):
                with self.subTest(text=text, september_debt=september_debt):
                    notices = [replace(self.sep, debt=september_debt), self.oct]
                    self.assert_review(decide(replace(self.bank, text=text), notices))

    def test_paid_october_never_redirects_period_payment_to_september(self):
        for label, text in OCTOBER_TEXT:
            with self.subTest(style=label):
                notices = [self.sep, replace(self.oct, debt=0)]
                self.assert_review(decide(replace(self.bank, text=text), notices))

    def test_parallel_contract_counts_even_when_paid(self):
        garage = replace(
            self.oct, id='garage', lease='garage', number='AVI-2026-10-0003',
            unique_ref='00000090047',
        )
        for debt in (0, 10000):
            for text in ('Hyra oktober 2026', 'Hyra okt 2026', 'Hyra 2026-10', 'Hyra 10/2026'):
                with self.subTest(debt=debt, text=text):
                    notices = self.notices + [replace(garage, debt=debt)]
                    self.assert_review(decide(replace(self.bank, text=text), notices))

    def test_explicit_october_reference_handles_partial_payment_without_spill(self):
        for amount, expected in ((4000, (('oct', 4000),)), (10000, (('oct', 10000),))):
            for text in ('Hyra okt 2026', 'Hyra 2026-10', 'Hyra 10/2026'):
                with self.subTest(amount=amount, text=text):
                    bank = replace(self.bank, amount=amount, text=text)
                    self.assertEqual(decide(bank, self.notices).allocations, expected)
        for text in ('Hyra oktober 2026', 'Hyra okt 2026', 'Hyra 2026-10'):
            with self.subTest(overpayment_text=text):
                self.assert_review(decide(replace(self.bank, amount=16000, text=text), self.notices))

    def test_plain_hyra_known_ocr_preserves_oldest_first_partial_and_combined(self):
        cases = (
            (4000, (('sep', 4000),)),
            (10000, (('sep', 10000),)),
            (16000, (('sep', 10000), ('oct', 6000))),
            (20000, (('sep', 10000), ('oct', 10000))),
        )
        for amount, expected in cases:
            for notices in (self.notices, list(reversed(self.notices))):
                with self.subTest(amount=amount, order=tuple(n.id for n in notices)):
                    bank = replace(self.bank, amount=amount)
                    self.assertEqual(decide(bank, notices).allocations, expected)

    def test_same_tenant_legacy_and_invoice_reference_namespace_collision_stops(self):
        # A future unique invoice reference must not hijack a legacy tenant OCR,
        # even when both meanings belong to the same tenant and lease.
        for debt in (0, 10000):
            collision = replace(self.oct, unique_ref=self.sep.ocr, debt=debt)
            for notices in ([self.sep, collision], [collision, self.sep]):
                with self.subTest(debt=debt, order=tuple(n.id for n in notices)):
                    self.assert_review(decide(self.bank, notices))

    def test_same_tenant_duplicate_invoice_number_never_selects_last_record(self):
        for debt in (0, 10000):
            collision = replace(self.oct, id='garage', lease='garage', unique_ref='00000090047', debt=debt)
            for notices in ([self.sep, self.oct, collision], [collision, self.oct, self.sep]):
                with self.subTest(debt=debt, order=tuple(n.id for n in notices)):
                    bank = replace(self.bank, text='Hyra AVI-2026-10-0001')
                    self.assert_review(decide(bank, notices))


if __name__ == '__main__':
    unittest.main(verbosity=2)
