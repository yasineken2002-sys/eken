/**
 * #73 — depositionens återbetalnings-flagga (REFUND_PENDING) sätts vid FAKTISK
 * utflytt (terminateExpiredNoticeLeases, endDate passerad → TERMINATED), INTE vid
 * uppsägning (terminate/notice-date). Säkerheten hålls under hela uppsägningstiden.
 *
 * (terminate()-sidan — att den INTE längre triggar refund — bevisas i
 * leases-termination-floor.spec.ts.)
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { LeasesService } from './leases.service'

describe('#73 · terminateExpiredNoticeLeases triggar refund-pending vid utflytt', () => {
  it('lease vars endDate passerat → TERMINATED + markRefundPendingForLease körs', async () => {
    // status ACTIVE speglar findMany-filtret (where status:'ACTIVE') — krävs av
    // statusmaskin-gaten (assertLeaseTransition ACTIVE→TERMINATED, #60/T1.2).
    const dueLease = { id: 'lease-1', organizationId: 'org-1', unitId: 'unit-1', status: 'ACTIVE' }
    const txMock = {
      lease: { update: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
      unit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = {
      lease: { findMany: jest.fn().mockResolvedValue([dueLease]) },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
    }
    const deposits = { markRefundPendingForLease: jest.fn().mockResolvedValue(undefined) }
    const noop = {} as never
    const service = new LeasesService(
      prisma as never,
      noop, // notifications
      deposits as never,
      noop,
      noop,
      noop,
      noop,
      noop,
    )

    // Privat cron-hjälpare — anropa direkt.
    const n = await (
      service as unknown as { terminateExpiredNoticeLeases: (d: Date) => Promise<number> }
    ).terminateExpiredNoticeLeases(new Date('2026-12-01'))

    expect(n).toBe(1)
    // Lease flippades → TERMINATED.
    expect(txMock.lease.update.mock.calls[0]![0].data).toMatchObject({ status: 'TERMINATED' })
    // #73: NU (vid utflytt) flyttas depositionen till REFUND_PENDING.
    expect(deposits.markRefundPendingForLease).toHaveBeenCalledWith('lease-1', 'org-1')
  })
})
