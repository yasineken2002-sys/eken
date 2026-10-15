"""Independent business examples for the isolated credit/refund experiment.

Amounts are integer ore. These cases assert customer-money outcomes, not
production accounting, bank connectivity, or the implementation's query plan.
Only temporary local SQLite files and fictional return-account tokens are used.
"""
from dataclasses import replace
from pathlib import Path
from queue import SimpleQueue
import tempfile
from threading import Barrier, Thread
import unittest

from referensprov_credit import CreditStore
from referensprov_policy import Bank, Notice


class IndependentCreditCases(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='credit-cases-')
        self.path = str(Path(self.directory.name) / 'isolated.sqlite')
        self.store = CreditStore(self.path)
        self.october = Notice(
            'october', 'org-a', 'tenant-a', 'flat', 'Sara Svensson',
            'AVI-2026-10-0001', '00000000019', 2026, 10,
            '2026-09-30', '2026-09-15', 10000,
        )
        self.store.register_lease('register-flat', 'org-a', 'tenant-a', 'flat',
                                  carry_forward=True)
        self.store.issue('issue-october', self.october)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def bank(self, amount=12500, notice=None):
        notice = notice or self.october
        return Bank(notice.org, '2026-10-25', amount,
                    'Hyra ' + notice.number, notice.ocr)

    def hold(self, amount=12500):
        self.store.ingest('import-1', 'bank-1', 'fixture-1', self.bank(amount))

    def next_notice(self, **changes):
        return replace(self.october, id='november', number='AVI-2026-11-0001',
                       month=11, due='2026-10-31', issued='2026-11-01', **changes)

    def assert_balance(self, original=2500, available=2500, reserved=0,
                       applied=0, refunded=0, org='org-a', source='bank-1'):
        balance = self.store.balance(org, source)
        expected = dict(original=original, available=available, reserved=reserved,
                        applied=applied, refunded=refunded)
        self.assertEqual({key: balance[key] for key in expected}, expected)
        self.assertEqual(original, available + reserved + applied + refunded)

    def assert_rejected_unchanged(self, operation):
        before = self.store.snapshot()
        with self.assertRaises(ValueError):
            operation()
        self.assertEqual(self.store.snapshot(), before)

    def ready_for_refund(self):
        self.hold()
        self.store.close_lease('close-flat', 'org-a', 'flat', '2026-10-26')
        self.store.verify_return_account('verify-return', 'org-a', 'bank-1',
                                         'TEST-ACCOUNT-A', 'TEST-VERIFICATION-A')

    def request(self, event='refund-1', amount=2500):
        return self.store.request_refund(event, 'org-a', 'bank-1', amount,
                                         'TEST-ACCOUNT-A', '2026-10-27')

    def confirm(self, event='confirm-1', refund='refund-1', payment='bank-out-1',
                amount=2500, account='TEST-ACCOUNT-A'):
        return self.store.confirm_refund(event, 'org-a', refund, payment, amount,
                                         account, '2026-10-28')

    def test_explicit_october_payment_does_not_pay_september_arrears(self):
        september = replace(self.october, id='september', month=9,
                            number='AVI-2026-09-0001', due='2026-08-31',
                            issued='2026-08-15')
        self.store.issue('issue-september', september)
        self.hold()
        self.assertEqual(self.store.debt('org-a', 'october'), 0)
        self.assertEqual(self.store.debt('org-a', 'september'), 10000)
        self.assert_balance()
        self.store.verify()

    def test_next_invoice_consumes_credit_once_and_leaves_real_debt(self):
        self.hold()
        self.store.issue('issue-november', self.next_notice())
        self.assertEqual(self.store.apply_credit('use-1', 'org-a', 'november',
                                                '2026-11-02'), 2500)
        self.assertEqual(self.store.debt('org-a', 'november'), 7500)
        self.assert_balance(available=0, applied=2500)
        before = self.store.snapshot()
        self.assertEqual(self.store.apply_credit('use-1', 'org-a', 'november',
                                                '2026-11-02'), 2500)
        self.assertEqual(self.store.snapshot(), before)
        self.assertEqual(self.store.apply_credit('use-2', 'org-a', 'november',
                                                '2026-11-02'), 0)
        self.assertEqual(self.store.debt('org-a', 'november'), 7500)
        self.assert_balance(available=0, applied=2500)

    def test_limit_is_current_debt_after_a_separate_bank_payment(self):
        self.hold()
        november = self.next_notice()
        self.store.issue('issue-november', november)
        bank = Bank('org-a', '2026-11-02', 9000, 'Hyra ' + november.number,
                    november.ocr)
        self.store.ingest('partial-import', 'bank-partial', 'fixture-partial', bank)
        self.assertEqual(self.store.apply_credit('use-1', 'org-a', 'november',
                                                '2026-11-03'), 1000)
        self.assertEqual(self.store.debt('org-a', 'november'), 0)
        self.assert_balance(available=1500, applied=1000)

    def test_a_paid_invoice_cannot_consume_credit(self):
        self.hold()
        november = self.next_notice()
        self.store.issue('issue-november', november)
        payment = Bank('org-a', '2026-11-02', 10000, 'Hyra ' + november.number,
                       november.ocr)
        self.store.ingest('pay-november', 'bank-november', 'fixture-november', payment)
        self.assertEqual(self.store.apply_credit('use-paid', 'org-a', 'november',
                                                '2026-11-02'), 0)
        self.assert_balance()

    def test_same_tenant_parallel_lease_cannot_use_flat_credit(self):
        self.hold()
        self.store.register_lease('register-garage', 'org-a', 'tenant-a',
                                  'garage', carry_forward=True)
        garage = replace(self.next_notice(), id='garage-november', lease='garage',
                         number='AVI-2026-11-0002')
        self.store.issue('issue-garage', garage)
        self.assertEqual(self.store.apply_credit('use-garage', 'org-a', garage.id,
                                                '2026-11-02'), 0)
        self.assertEqual(self.store.debt('org-a', garage.id), 10000)
        self.assert_balance()
        self.store.issue('issue-november', self.next_notice())
        self.assertEqual(self.store.apply_credit('use-flat', 'org-a', 'november',
                                                '2026-11-02'), 2500)

    def test_organisation_identifiers_are_scoped_even_when_all_ids_collide(self):
        foreign = replace(self.october, org='org-b')
        self.store.register_lease('register-flat', 'org-b', 'tenant-a', 'flat',
                                  carry_forward=True)
        self.store.issue('issue-october', foreign)
        self.hold()
        self.store.ingest('import-1', 'bank-1', 'fixture-1',
                          replace(self.bank(), org='org-b', amount=11200))
        target = replace(self.next_notice(), org='org-b')
        self.store.issue('issue-november', target)
        self.assertEqual(self.store.apply_credit('use-1', 'org-b', 'november',
                                                '2026-11-02'), 1200)
        self.assertEqual(self.store.debt('org-b', 'november'), 8800)
        self.assert_balance()
        self.assert_balance(original=1200, available=0, applied=1200, org='org-b')

    def test_credit_cannot_move_to_another_tenant_in_the_same_organisation(self):
        self.hold()
        self.store.register_lease('register-other', 'org-a', 'tenant-b',
                                  'other-flat', carry_forward=True)
        other = replace(self.next_notice(), id='other-november', lease='other-flat',
                        tenant='tenant-b', name='Anna Andersson',
                        number='AVI-2026-11-0002', ocr='00000000028')
        self.store.issue('issue-other', other)
        self.assertEqual(self.store.apply_credit('use-other', 'org-a', other.id,
                                                '2026-11-02'), 0)
        self.assertEqual(self.store.debt('org-a', other.id), 10000)
        self.assert_balance()

    def test_older_and_same_period_debts_do_not_consume_future_rent_credit(self):
        self.hold()
        earlier = replace(self.october, id='earlier', month=9,
                          number='AVI-2026-09-0002')
        self.store.issue('issue-earlier', earlier)
        self.assertEqual(self.store.apply_credit('use-earlier', 'org-a', 'earlier',
                                                '2026-11-02'), 0)
        self.assertEqual(self.store.debt('org-a', 'earlier'), 10000)
        self.assertEqual(self.store.apply_credit('use-same-period', 'org-a', 'october',
                                                '2026-11-02'), 0)
        self.assert_balance()

    def test_prototype_refuses_two_invoices_for_one_lease_and_period(self):
        duplicate = replace(self.october, id='second-october',
                            number='AVI-2026-10-0002')
        self.assert_rejected_unchanged(lambda:
            self.store.issue('issue-second-october', duplicate))

    def test_unissued_future_invoice_waits_until_its_issue_date(self):
        self.hold()
        self.store.issue('issue-november', self.next_notice())
        self.assertEqual(self.store.apply_credit('use-too-early', 'org-a', 'november',
                                                '2026-10-31'), 0)
        self.assertEqual(self.store.debt('org-a', 'november'), 10000)
        self.assert_balance()
        self.assertEqual(self.store.apply_credit('use-on-issue', 'org-a', 'november',
                                                '2026-11-01'), 2500)

    def test_credit_cannot_precede_invoice_issue_when_offsets_hide_the_order(self):
        self.hold()
        november = replace(self.next_notice(), issued='2026-11-01T09:00:00Z')
        self.store.issue('issue-november', november)
        before = self.store.snapshot()
        # 10:00 at UTC+02 is 08:00 UTC, one hour before the invoice exists.
        self.assertEqual(self.store.apply_credit('use-before-issue', 'org-a',
                                                'november', '2026-11-01T10:00:00+02:00'), 0)
        after = self.store.snapshot()
        self.assertEqual({k: v for k, v in after.items() if k != 'events'},
                         {k: v for k, v in before.items() if k != 'events'})
        self.assertEqual(self.store.debt('org-a', 'november'), 10000)
        self.assert_balance()

    def test_bank_payment_before_issue_in_absolute_time_stays_unallocated(self):
        november = replace(self.next_notice(), issued='2026-11-01T09:00:00Z')
        self.store.issue('issue-november', november)
        bank = Bank('org-a', '2026-11-01T10:00:00+02:00', 12500,
                    'Hyra ' + november.number, november.ocr)
        result = self.store.ingest('import-before-issue', 'bank-before-issue',
                                   'fixture-before-issue', bank)
        self.assertEqual(result['unresolved'], 12500)
        self.assertEqual(self.store.debt('org-a', 'november'), 10000)
        self.assertEqual(self.store.debt('org-a', 'october'), 10000)
        state = self.store.snapshot()
        self.assertEqual(state['movements'], [])
        self.assertEqual(state['lots'], [])
        self.store.verify()

    def test_credit_cannot_be_used_before_its_source_payment_in_absolute_time(self):
        november = replace(self.next_notice(), issued='2026-11-01T07:00:00Z')
        self.store.issue('issue-november', november)
        source = replace(self.bank(), date='2026-11-01T08:30:00Z')
        self.store.ingest('import-1', 'bank-1', 'fixture-1', source)
        before = self.store.snapshot()
        # The source's 08:30 UTC is later than this operation's 08:00 UTC,
        # although the source string sorts before the operation's 10:00.
        self.assertEqual(self.store.apply_credit('use-before-source', 'org-a',
                                                'november', '2026-11-01T10:00:00+02:00'), 0)
        after = self.store.snapshot()
        self.assertEqual({k: v for k, v in after.items() if k != 'events'},
                         {k: v for k, v in before.items() if k != 'events'})
        self.assertEqual(self.store.debt('org-a', 'november'), 10000)
        self.assert_balance()

    def test_cannot_skip_an_earlier_open_issued_invoice(self):
        self.hold()
        november = self.next_notice(debt=1000)
        december = replace(november, id='december', month=12,
                           number='AVI-2026-12-0001', debt=10000,
                           issued='2026-11-15', due='2026-11-30')
        self.store.issue('issue-november', november)
        self.store.issue('issue-december', december)
        self.assertEqual(self.store.apply_credit('skip-november', 'org-a', 'december',
                                                '2026-12-01'), 0)
        self.assertEqual(self.store.debt('org-a', 'december'), 10000)
        self.assert_balance()
        self.assertEqual(self.store.apply_credit('use-november', 'org-a', 'november',
                                                '2026-12-01'), 1000)
        self.assertEqual(self.store.apply_credit('use-december', 'org-a', 'december',
                                                '2026-12-01'), 1500)
        self.assertEqual(self.store.debt('org-a', 'december'), 8500)
        self.assert_balance(available=0, applied=2500)

    def test_missing_intervening_month_requires_review_instead_of_skipping(self):
        self.hold()
        december = replace(self.next_notice(), id='december', month=12,
                           number='AVI-2026-12-0001', issued='2026-11-15',
                           due='2026-11-30')
        self.store.issue('issue-december', december)
        self.assertEqual(self.store.apply_credit('skip-missing-november', 'org-a',
                                                'december', '2026-12-01'), 0)
        self.assertEqual(self.store.debt('org-a', 'december'), 10000)
        self.assert_balance()

    def test_changed_bank_payload_and_reused_bank_identity_are_atomic_rejections(self):
        self.hold()
        for bank in (replace(self.bank(), amount=12501),
                     replace(self.bank(), text='Hyra'),
                     replace(self.bank(), reference=''),
                     replace(self.bank(), date='2026-10-26')):
            with self.subTest(bank=bank):
                self.assert_rejected_unchanged(lambda bank=bank:
                    self.store.ingest('import-1', 'bank-1', 'fixture-1', bank))
        self.assert_rejected_unchanged(lambda:
            self.store.ingest('import-new-event', 'bank-1', 'changed-fixture',
                              self.bank()))

    def test_unknown_organisation_cannot_create_a_receipt_or_money_movement(self):
        self.assert_rejected_unchanged(lambda:
            self.store.ingest('import-unknown-org', 'bank-unknown-org',
                              'fixture-unknown-org', replace(self.bank(), org='unknown-org')))
        self.assertEqual(self.store.debt('org-a', 'october'), 10000)
        self.store.verify()

    def test_duplicate_import_is_unchanged_after_reopening_database(self):
        self.hold()
        before = self.store.snapshot()
        self.store.close()
        self.store = CreditStore(self.path)
        self.assertEqual(self.store.snapshot(), before)
        self.hold()
        self.assertEqual(self.store.snapshot(), before)
        self.assert_balance()
        self.store.verify()

    def test_changed_issue_and_credit_application_event_are_rejected(self):
        self.hold()
        november = self.next_notice()
        self.store.issue('issue-november', november)
        self.assert_rejected_unchanged(lambda:
            self.store.issue('issue-november', replace(november, debt=9999)))
        self.store.apply_credit('use-1', 'org-a', 'november', '2026-11-02')
        self.assert_rejected_unchanged(lambda:
            self.store.apply_credit('use-1', 'org-a', 'november', '2026-11-03'))

    def test_an_active_lease_cannot_refund_even_a_verified_account(self):
        self.hold()
        self.store.verify_return_account('verify-return', 'org-a', 'bank-1',
                                         'TEST-ACCOUNT-A', 'TEST-VERIFICATION-A')
        self.assert_rejected_unchanged(self.request)
        self.assert_balance()

    def test_closed_lease_requires_exact_verified_return_account(self):
        self.hold()
        self.store.close_lease('close-flat', 'org-a', 'flat', '2026-10-26')
        self.assert_rejected_unchanged(self.request)
        self.store.verify_return_account('verify-return', 'org-a', 'bank-1',
                                         'TEST-ACCOUNT-A', 'TEST-VERIFICATION-A')
        self.assert_rejected_unchanged(lambda:
            self.store.request_refund('wrong-account', 'org-a', 'bank-1', 2500,
                                       'TEST-ACCOUNT-B', '2026-10-27'))
        self.assert_rejected_unchanged(lambda:
            self.store.verify_return_account('change-verified-account', 'org-a',
                                             'bank-1', 'TEST-ACCOUNT-B',
                                             'TEST-VERIFICATION-B'))
        self.assert_balance()

    def test_closing_a_different_lease_does_not_authorise_refund(self):
        self.hold()
        self.store.register_lease('register-garage', 'org-a', 'tenant-a',
                                  'garage', carry_forward=True)
        self.store.close_lease('close-garage', 'org-a', 'garage', '2026-10-26')
        self.store.verify_return_account('verify-return', 'org-a', 'bank-1',
                                         'TEST-ACCOUNT-A', 'TEST-VERIFICATION-A')
        self.assert_rejected_unchanged(self.request)

    def test_refund_waits_for_all_issued_debt_on_the_closed_lease(self):
        september = replace(self.october, id='september', month=9,
                            number='AVI-2026-09-0001', due='2026-08-31',
                            issued='2026-08-15', debt=1000)
        self.store.issue('issue-september-debt', september)
        self.ready_for_refund()
        self.assert_rejected_unchanged(self.request)
        self.assert_balance()

    def test_refund_cannot_predate_the_effective_lease_closure(self):
        self.ready_for_refund()
        self.assert_rejected_unchanged(lambda:
            self.store.request_refund('too-early-refund', 'org-a', 'bank-1', 2500,
                                       'TEST-ACCOUNT-A', '2026-10-25'))

    def test_pending_refund_reserves_money_and_confirmation_consumes_it_once(self):
        self.ready_for_refund()
        requested = self.request()
        self.assertEqual(requested['refund_id'], 'refund-1')
        self.assertEqual(requested['status'], 'PENDING')
        self.assert_balance(available=0, reserved=2500)
        before = self.store.snapshot()
        self.assertEqual(self.request(), requested)
        self.assertEqual(self.store.snapshot(), before)
        self.assert_rejected_unchanged(lambda: self.request('refund-too-many', 1))
        self.confirm()
        self.assert_balance(available=0, refunded=2500)
        before = self.store.snapshot()
        self.confirm()
        self.assertEqual(self.store.snapshot(), before)
        self.store.verify()

    def test_confirmation_requires_the_reserved_amount_and_verified_recipient(self):
        self.ready_for_refund()
        self.request()
        self.assert_rejected_unchanged(lambda: self.confirm(amount=2499))
        self.assert_rejected_unchanged(lambda: self.confirm(account='TEST-ACCOUNT-B'))
        self.assert_balance(available=0, reserved=2500)

    def test_definitive_bank_decline_releases_credit_and_late_success_is_rejected(self):
        self.ready_for_refund()
        self.request()
        self.store.fail_refund('decline-1', 'org-a', 'refund-1', 'BANK_FINAL_DECLINE')
        self.assert_balance()
        before = self.store.snapshot()
        self.store.fail_refund('decline-1', 'org-a', 'refund-1', 'BANK_FINAL_DECLINE')
        self.assertEqual(self.store.snapshot(), before)
        self.assert_rejected_unchanged(self.confirm)
        self.request('refund-retry')
        self.confirm(event='confirm-retry', refund='refund-retry', payment='bank-out-2')
        self.assert_balance(available=0, refunded=2500)

    def test_unknown_bank_result_keeps_refund_reserved_until_definitive_outcome(self):
        self.ready_for_refund()
        self.request()
        for reason in ('TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN', ''):
            with self.subTest(reason=reason):
                self.assert_rejected_unchanged(lambda reason=reason:
                    self.store.fail_refund('uncertain-outcome', 'org-a', 'refund-1',
                                            reason))
        self.assert_balance(available=0, reserved=2500)
        self.confirm()
        self.assert_balance(available=0, refunded=2500)

    def test_duplicate_bank_callback_under_new_event_does_not_pay_twice(self):
        self.ready_for_refund()
        self.request()
        self.confirm()
        before = self.store.snapshot()
        self.confirm(event='redelivered-bank-callback')
        after = self.store.snapshot()
        self.assertEqual({k: v for k, v in after.items() if k != 'events'},
                         {k: v for k, v in before.items() if k != 'events'})
        self.assert_balance(available=0, refunded=2500)

    def test_new_callback_event_cannot_change_the_confirmed_bank_payment_date(self):
        self.ready_for_refund()
        self.request()
        self.confirm()
        self.assert_rejected_unchanged(lambda:
            self.store.confirm_refund('redelivered-changed-date', 'org-a', 'refund-1',
                                      'bank-out-1', 2500, 'TEST-ACCOUNT-A', '2026-10-29'))
        self.assert_balance(available=0, refunded=2500)

    def test_foreign_organisation_cannot_verify_or_refund_a_source(self):
        self.ready_for_refund()
        self.assert_rejected_unchanged(lambda:
            self.store.verify_return_account('verify-return', 'org-b', 'bank-1',
                                             'TEST-ACCOUNT-A', 'TEST-VERIFICATION-A'))
        self.assert_rejected_unchanged(lambda:
            self.store.request_refund('refund-1', 'org-b', 'bank-1', 2500,
                                       'TEST-ACCOUNT-A', '2026-10-27'))
        self.assert_balance()

    def test_a_return_verification_does_not_authorise_another_source_payment(self):
        self.hold()
        november = self.next_notice()
        self.store.issue('issue-november', november)
        november_payment = Bank('org-a', '2026-11-25', 11200,
                                'Hyra ' + november.number, november.ocr)
        self.store.ingest('import-2', 'bank-2', 'fixture-2', november_payment)
        self.store.close_lease('close-flat', 'org-a', 'flat', '2026-11-26')
        self.store.verify_return_account('verify-first-source', 'org-a', 'bank-1',
                                         'TEST-ACCOUNT-A', 'TEST-VERIFICATION-A')
        self.assert_rejected_unchanged(lambda:
            self.store.request_refund('refund-unverified-source', 'org-a', 'bank-2',
                                       1200, 'TEST-ACCOUNT-A', '2026-11-27'))
        self.assert_balance()
        self.assert_balance(original=1200, available=1200, source='bank-2')

    def test_a_closed_lease_cannot_use_credit_on_a_later_invoice(self):
        self.hold()
        self.store.issue('issue-november', self.next_notice())
        self.store.close_lease('close-flat', 'org-a', 'flat', '2026-11-02')
        self.assert_rejected_unchanged(lambda:
            self.store.apply_credit('use-after-close', 'org-a', 'november', '2026-11-03'))
        self.assertEqual(self.store.debt('org-a', 'november'), 10000)
        self.assert_balance()

    def test_lease_closure_cannot_be_backdated_before_an_applied_credit(self):
        self.hold()
        self.store.issue('issue-november', self.next_notice())
        self.assertEqual(self.store.apply_credit('use-1', 'org-a', 'november',
                                                '2026-11-05'), 2500)
        self.assert_rejected_unchanged(lambda:
            self.store.close_lease('backdated-close', 'org-a', 'flat', '2026-11-04'))
        self.assertEqual(self.store.debt('org-a', 'november'), 7500)
        self.assert_balance(available=0, applied=2500)

    def test_actual_bank_payment_cannot_be_backdated_before_later_credit_use(self):
        self.hold()
        november = self.next_notice()
        self.store.issue('issue-november', november)
        self.assertEqual(self.store.apply_credit('use-1', 'org-a', 'november',
                                                '2026-11-05'), 2500)
        earlier_bank_payment = Bank('org-a', '2026-11-04', 1000,
                                    'Hyra ' + november.number, november.ocr)
        self.assert_rejected_unchanged(lambda:
            self.store.ingest('backdated-import', 'bank-backdated', 'fixture-backdated',
                              earlier_bank_payment))
        self.assertEqual(self.store.debt('org-a', 'november'), 7500)
        self.assert_balance(available=0, applied=2500)

    def test_changed_refund_request_or_confirmation_event_is_rejected(self):
        self.ready_for_refund()
        self.request()
        self.assert_rejected_unchanged(lambda: self.request(amount=2400))
        self.confirm()
        self.assert_rejected_unchanged(lambda: self.confirm(payment='different-bank-out'))
        self.assert_rejected_unchanged(lambda:
            self.store.fail_refund('decline-after-success', 'org-a', 'refund-1',
                                    'BANK_FINAL_DECLINE'))

    def test_bad_refund_amounts_cannot_reserve_or_remove_money(self):
        self.ready_for_refund()
        for amount in (True, 0, -1, 1.5, 2501):
            with self.subTest(amount=amount):
                self.assert_rejected_unchanged(lambda amount=amount:
                    self.request('invalid-refund', amount))
        self.assert_balance()

    def test_partial_use_and_final_refund_keep_complete_source_links(self):
        self.hold()
        self.store.issue('issue-november', self.next_notice(debt=1000))
        self.store.apply_credit('use-1', 'org-a', 'november', '2026-11-02')
        self.store.close_lease('close-flat', 'org-a', 'flat', '2026-11-03')
        self.store.verify_return_account('verify-return', 'org-a', 'bank-1',
                                         'TEST-ACCOUNT-A', 'TEST-VERIFICATION-A')
        self.store.request_refund('refund-1', 'org-a', 'bank-1', 1500,
                                  'TEST-ACCOUNT-A', '2026-11-04')
        self.store.confirm_refund('confirm-1', 'org-a', 'refund-1', 'bank-out-1',
                                  1500, 'TEST-ACCOUNT-A', '2026-11-05')
        self.assert_balance(available=0, applied=1000, refunded=1500)
        movements = self.store.snapshot()['movements']
        credit = [row for row in movements if row['kind'] == 'CREDIT']
        refund = [row for row in movements if row['kind'] == 'REFUND']
        self.assertEqual(len(credit), 1)
        self.assertEqual(len(refund), 1)
        for row in credit + refund:
            self.assertEqual((row['org'], row['source_bank_id'], row['fixture_id'],
                              row['source_notice_id']),
                             ('org-a', 'bank-1', 'fixture-1', 'october'))
        self.assertEqual((credit[0]['event_id'], credit[0]['target_notice_id'],
                          credit[0]['amount']), ('use-1', 'november', 1000))
        self.assertEqual((refund[0]['event_id'], refund[0]['target_notice_id'],
                          refund[0]['amount']), ('confirm-1', '', 1500))
        refund_record = self.store.snapshot()['refunds'][0]
        self.assertEqual((refund_record['org'], refund_record['id'],
                          refund_record['source_bank_id'], refund_record['amount'],
                          refund_record['account_token'], refund_record['settlement_id']),
                         ('org-a', 'refund-1', 'bank-1', 1500, 'TEST-ACCOUNT-A',
                          'bank-out-1'))
        self.store.verify()

    def test_multiple_sources_remain_individually_conserved_when_combined(self):
        self.hold()
        november = self.next_notice()
        self.store.issue('issue-november', november)
        november_payment = Bank('org-a', '2026-11-25', 11200,
                                'Hyra ' + november.number, november.ocr)
        self.store.ingest('import-2', 'bank-2', 'fixture-2', november_payment)
        december = replace(november, id='december', month=12, debt=3000,
                           number='AVI-2026-12-0001', issued='2026-11-15',
                           due='2026-11-30')
        self.store.issue('issue-december', december)
        self.assertEqual(self.store.apply_credit('use-combined', 'org-a', 'december',
                                                '2026-12-01'), 3000)
        self.assertEqual(self.store.debt('org-a', 'december'), 0)
        balances = [self.store.balance('org-a', source)
                    for source in ('bank-1', 'bank-2')]
        self.assertEqual([row['original'] for row in balances], [2500, 1200])
        self.assertEqual(sum(row['applied'] for row in balances), 3000)
        self.assertEqual(sum(row['available'] for row in balances), 700)
        movements = [row for row in self.store.snapshot()['movements']
                     if row['kind'] == 'CREDIT']
        self.assertEqual(sum(row['amount'] for row in movements), 3000)
        for source, fixture, origin in (('bank-1', 'fixture-1', 'october'),
                                        ('bank-2', 'fixture-2', 'november')):
            balance = self.store.balance('org-a', source)
            self.assertEqual(balance['original'], balance['available'] +
                             balance['reserved'] + balance['applied'] +
                             balance['refunded'])
            source_moves = [row for row in movements if row['source_bank_id'] == source]
            self.assertEqual(sum(row['amount'] for row in source_moves), balance['applied'])
            for row in source_moves:
                self.assertEqual((row['org'], row['fixture_id'], row['source_notice_id'],
                                  row['target_notice_id']),
                                 ('org-a', fixture, origin, 'december'))
        self.store.verify()

    def test_credit_application_failure_rolls_back_debt_money_and_replay_key(self):
        self.hold()
        self.store.issue('issue-november', self.next_notice())
        before = self.store.snapshot()
        self.store.fail_next = True
        with self.assertRaises(RuntimeError):
            self.store.apply_credit('use-1', 'org-a', 'november', '2026-11-02')
        self.assertEqual(self.store.snapshot(), before)
        self.assertEqual(self.store.apply_credit('use-1', 'org-a', 'november',
                                                '2026-11-02'), 2500)
        self.assert_balance(available=0, applied=2500)

    def test_refund_request_and_confirmation_each_commit_all_or_nothing(self):
        self.ready_for_refund()
        before = self.store.snapshot()
        self.store.fail_next = True
        with self.assertRaises(RuntimeError):
            self.request()
        self.assertEqual(self.store.snapshot(), before)
        self.request()
        before = self.store.snapshot()
        self.store.fail_next = True
        with self.assertRaises(RuntimeError):
            self.confirm()
        self.assertEqual(self.store.snapshot(), before)
        self.assert_balance(available=0, reserved=2500)
        self.store.close()
        self.store = CreditStore(self.path)
        self.assertEqual(self.store.snapshot(), before)
        self.confirm()
        self.assert_balance(available=0, refunded=2500)

    def test_failed_commit_of_definitive_decline_keeps_reservation_after_restart(self):
        self.ready_for_refund()
        self.request()
        before = self.store.snapshot()
        self.store.fail_next = True
        with self.assertRaises(RuntimeError):
            self.store.fail_refund('decline-1', 'org-a', 'refund-1', 'BANK_FINAL_DECLINE')
        self.assertEqual(self.store.snapshot(), before)
        self.store.close()
        self.store = CreditStore(self.path)
        self.assertEqual(self.store.snapshot(), before)
        self.assert_balance(available=0, reserved=2500)
        self.store.fail_refund('decline-1', 'org-a', 'refund-1', 'BANK_FINAL_DECLINE')
        self.assert_balance()

    def test_import_failure_does_not_leave_half_a_payment_or_credit(self):
        before = self.store.snapshot()
        self.store.fail_next = True
        with self.assertRaises(RuntimeError):
            self.hold()
        self.assertEqual(self.store.snapshot(), before)
        self.assertEqual(self.store.debt('org-a', 'october'), 10000)
        self.store.close()
        self.store = CreditStore(self.path)
        self.assertEqual(self.store.snapshot(), before)
        self.hold()
        self.assertEqual(self.store.debt('org-a', 'october'), 0)
        self.assert_balance()

    def test_second_connection_observes_spent_credit_and_cannot_spend_it_again(self):
        self.hold()
        self.store.issue('issue-november', self.next_notice())
        other = CreditStore(self.path)
        try:
            self.assertEqual(self.store.apply_credit('use-first-connection', 'org-a',
                                                    'november', '2026-11-02'), 2500)
            self.assertEqual(other.apply_credit('use-second-connection', 'org-a',
                                                'november', '2026-11-02'), 0)
            self.assertEqual(other.debt('org-a', 'november'), 7500)
            self.assertEqual(other.balance('org-a', 'bank-1')['applied'], 2500)
            other.verify()
        finally:
            other.close()

    def test_overlapping_refund_requests_cannot_reserve_the_same_money_twice(self):
        self.ready_for_refund()
        start = Barrier(2)
        outcomes = SimpleQueue()

        def request_from_separate_connection(event):
            connection = None
            try:
                connection = CreditStore(self.path)
                start.wait(timeout=5)
                result = connection.request_refund(event, 'org-a', 'bank-1', 2500,
                                                    'TEST-ACCOUNT-A', '2026-10-27')
                outcomes.put(('accepted', result))
            except ValueError as error:
                outcomes.put(('rejected', str(error)))
            except Exception as error:
                outcomes.put(('unexpected', repr(error)))
            finally:
                if connection is not None:
                    connection.close()

        workers = [Thread(target=request_from_separate_connection,
                          args=(f'refund-concurrent-{index}',)) for index in (1, 2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=10)
        self.assertFalse(any(worker.is_alive() for worker in workers),
                         'Concurrent refund requests must complete')
        results = [outcomes.get_nowait() for _ in workers]
        self.assertCountEqual([status for status, _ in results], ['accepted', 'rejected'],
                              results)
        self.assert_balance(available=0, reserved=2500)
        self.assertEqual(len(self.store.snapshot()['refunds']), 1)
        before = self.store.snapshot()
        self.store.close()
        self.store = CreditStore(self.path)
        self.assertEqual(self.store.snapshot(), before)
        self.assert_balance(available=0, reserved=2500)
        self.store.verify()

    def test_carry_forward_is_disabled_unless_explicitly_enabled(self):
        self.store.register_lease('register-no-carry', 'org-a', 'tenant-a', 'no-carry')
        october = replace(self.october, id='no-carry-october', lease='no-carry',
                          number='AVI-2026-10-0002')
        november = replace(self.next_notice(), id='no-carry-november', lease='no-carry',
                           number='AVI-2026-11-0002')
        self.store.issue('issue-no-carry-october', october)
        self.store.ingest('import-no-carry', 'bank-no-carry', 'fixture-no-carry',
                          self.bank(notice=october))
        self.store.issue('issue-no-carry-november', november)
        self.assert_rejected_unchanged(lambda:
            self.store.apply_credit('use-no-carry', 'org-a', 'no-carry-november',
                                     '2026-11-02'))
        self.assertEqual(self.store.debt('org-a', 'no-carry-november'), 10000)
        self.assert_balance(source='bank-no-carry')
        self.store.verify()


if __name__ == '__main__':
    unittest.main(verbosity=2)
