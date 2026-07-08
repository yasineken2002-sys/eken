/**
 * #65/#66 — uppsägningstidens golv gäller ALLA vägar.
 *
 * #66: terminate() saknade golv HELT (bara "inte i förflutet") och default-datumet
 *      rundades inte till månadsskifte → systematiskt för kort uppsägning.
 * #65: AI + HTTP /status sa upp via transitionStatus(TERMINATED) = rå flip →
 *      kringgick golvet i terminate() fullständigt.
 *
 * Bevisar:
 *   A) endOfNoticePeriod (delad @eken/shared-helper): månadsskiftesrundning,
 *      inkl. Qasa-fallet (12 aug + 1 mån → 30 sep) och #46-exemplet (7 jul + 3 → 31 okt).
 *   B) terminate(): för kort effectiveDate JUSTERAS UPP till golvet; utan datum =
 *      golvet; senare datum respekteras; DRAFT saknar golv (avbryt utkast).
 *   C) transitionStatus(ACTIVE→TERMINATED) DELEGERAR till terminate() (golvat
 *      endDate, ingen rå TERMINATED-flip) → AI/HTTP /status kan INTE kringgå golvet.
 *      DRAFT→TERMINATED flippar fortfarande direkt (oförändrat).
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { endOfNoticePeriod } from '@eken/shared'
import { LeasesService } from './leases.service'

// ── A. Delad helper — månadsskiftesrundning ────────────────────────────────────
describe('#66 · endOfNoticePeriod — rundar upp till månadsskifte', () => {
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  it('Qasa: 12 aug + 1 mån → 30 sep', () => {
    expect(ymd(endOfNoticePeriod(new Date(2026, 7, 12), 1))).toBe('2026-09-30')
  })
  it('#46: 7 jul + 3 mån (bostad) → 31 okt', () => {
    expect(ymd(endOfNoticePeriod(new Date(2026, 6, 7), 3))).toBe('2026-10-31')
  })
  it('månadsdrift: 31 aug + 1 mån → 30 sep (inte 31 okt)', () => {
    expect(ymd(endOfNoticePeriod(new Date(2026, 7, 31), 1))).toBe('2026-09-30')
  })
  it('lokal: 7 jul + 9 mån → 30 apr nästa år', () => {
    expect(ymd(endOfNoticePeriod(new Date(2026, 6, 7), 9))).toBe('2027-04-30')
  })
})

// ── Gemensam harness för LeasesService ─────────────────────────────────────────
function makeService(leaseOverrides: Record<string, unknown> = {}) {
  const lease = {
    id: 'lease-1',
    status: 'ACTIVE',
    organizationId: 'org-1',
    unitId: 'unit-1',
    tenantId: 'tenant-1',
    noticePeriodMonths: 3,
    monthlyRent: 10000,
    depositAmount: 0,
    endDate: new Date('2027-01-01'),
    terminatedAt: null,
    unit: { type: 'APARTMENT', name: 'A1', property: { name: 'Fastighet 1' } },
    ...leaseOverrides,
  }

  const txMock = {
    lease: {
      update: jest.fn().mockResolvedValue({ id: 'lease-1', unit: lease.unit }),
      count: jest.fn().mockResolvedValue(0),
    },
    unit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }

  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue(lease),
      update: jest.fn().mockResolvedValue({ id: 'lease-1', unit: lease.unit }),
      count: jest.fn().mockResolvedValue(0),
    },
    unit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }

  const deposits = { markRefundPendingForLease: jest.fn().mockResolvedValue(undefined) }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  const contractNumbers = { allocate: jest.fn().mockResolvedValue('KONT-2026-0001') }
  const noop = {} as never

  const service = new LeasesService(
    prisma as never,
    notifications as never,
    deposits as never,
    noop, // rentIncreases
    noop, // tenantAuth
    noop, // contracts
    contractNumbers as never,
    noop, // activationQueue
  )
  return { service, prisma, txMock, deposits }
}

const ymd = (d: Date | string) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

// ── B. terminate() — golvet ────────────────────────────────────────────────────
describe('#45/#66 · terminate() golvar och rundar', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-08-12T09:00:00Z')))
  afterEach(() => jest.useRealTimers())

  it('för kort effectiveDate (imorgon) → JUSTERAS UPP till golvet (31 nov→30 nov, 3 mån bostad)', async () => {
    const { service, prisma } = makeService()
    await service.terminate('lease-1', { effectiveDate: '2026-08-13' }, 'org-1')

    const data = (prisma.lease.update.mock.calls[0]![0] as { data: { endDate: Date } }).data
    // golv = endOfNoticePeriod(2026-08-12, 3) = 2026-11-30 — INTE det inskickade 2026-08-13.
    expect(ymd(data.endDate)).toBe('2026-11-30')
  })

  it('utan effectiveDate → golvet (månadsskiftesrundat)', async () => {
    const { service, prisma } = makeService()
    await service.terminate('lease-1', {}, 'org-1')
    const data = (prisma.lease.update.mock.calls[0]![0] as { data: { endDate: Date } }).data
    expect(ymd(data.endDate)).toBe('2026-11-30')
  })

  it('effectiveDate EFTER golvet → respekteras (parterna får avtala längre)', async () => {
    const { service, prisma } = makeService()
    await service.terminate('lease-1', { effectiveDate: '2027-06-15' }, 'org-1')
    const data = (prisma.lease.update.mock.calls[0]![0] as { data: { endDate: Date } }).data
    expect(ymd(data.endDate)).toBe('2027-06-15')
  })

  it('lokal (9 mån) golvas till rätt, längre datum', async () => {
    const { service, prisma } = makeService({
      unit: { type: 'COMMERCIAL', name: 'L1', property: { name: 'F1' } },
      noticePeriodMonths: 9,
    })
    await service.terminate('lease-1', { effectiveDate: '2026-09-01' }, 'org-1')
    const data = (prisma.lease.update.mock.calls[0]![0] as { data: { endDate: Date } }).data
    // endOfNoticePeriod(2026-08-12, 9) = 2027-05-31
    expect(ymd(data.endDate)).toBe('2027-05-31')
  })

  it('DRAFT: inget golv — avslutas direkt (idag) utan datum', async () => {
    const { service, prisma } = makeService({ status: 'DRAFT' })
    await service.terminate('lease-1', {}, 'org-1')
    const data = (prisma.lease.update.mock.calls[0]![0] as { data: { endDate: Date } }).data
    expect(ymd(data.endDate)).toBe('2026-08-12')
  })
})

// ── C. transitionStatus — delegering (stänger AI/HTTP-kringgåendet) ────────────
describe('#65 · transitionStatus(ACTIVE→TERMINATED) delegerar till terminate()', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-08-12T09:00:00Z')))
  afterEach(() => jest.useRealTimers())

  it('ACTIVE→TERMINATED → golvat endDate, INGEN rå TERMINATED-flip', async () => {
    const { service, prisma, txMock, deposits } = makeService()

    await service.transitionStatus('lease-1', 'TERMINATED', 'org-1', 'user-1')

    // Gick via terminate(): prisma.lease.update (inte tx-flip) med golvat endDate + terminatedAt.
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
    const data = (
      prisma.lease.update.mock.calls[0]![0] as {
        data: { endDate: Date; terminatedAt: Date; status?: string }
      }
    ).data
    expect(ymd(data.endDate)).toBe('2026-11-30')
    expect(data.terminatedAt).toBeInstanceOf(Date)
    // INGEN rå flip: status sätts INTE till TERMINATED (kontraktet löper ACTIVE till endDate).
    expect(data.status).toBeUndefined()
    // Rå-flip-vägens $transaction/unit-sync användes ALDRIG.
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(txMock.lease.update).not.toHaveBeenCalled()
    // #73: depositionen flyttas INTE till REFUND_PENDING vid uppsägning (notice-date) —
    // det sker först vid faktisk utflytt (terminateExpiredNoticeLeases, endDate passerad).
    expect(deposits.markRefundPendingForLease).not.toHaveBeenCalled()
  })

  it('DRAFT→TERMINATED → rå flip (avbryt utkast), oförändrat', async () => {
    const { service, prisma, txMock } = makeService({ status: 'DRAFT' })

    await service.transitionStatus('lease-1', 'TERMINATED', 'org-1', 'user-1')

    // Delegeras INTE — går via $transaction och flippar status direkt.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(txMock.lease.update).toHaveBeenCalledTimes(1)
    const data = (txMock.lease.update.mock.calls[0]![0] as { data: { status: string } }).data
    expect(data.status).toBe('TERMINATED')
    // terminate()-vägen (prisma.lease.update) användes INTE.
    expect(prisma.lease.update).not.toHaveBeenCalled()
  })
})

// ── D. Fjärde vägen: update() får inte ändra endDate på ACTIVE (hyresjurist-fynd) ─
describe('#65/#66 · update() blockerar endDate-ändring på ACTIVE (fjärde bypass-vägen)', () => {
  it('ACTIVE + ändrat endDate → NEKAS (ingen tyst golv-kringgång), INGEN skrivning', async () => {
    const { service, prisma } = makeService()
    await expect(
      service.update('lease-1', { endDate: '2026-08-13' } as never, 'org-1'),
    ).rejects.toThrow(/[Ss]lutdatum kan inte ändras/)
    expect(prisma.lease.update).not.toHaveBeenCalled()
  })

  it('ACTIVE + OFÖRÄNDRAT endDate (web återsänder samma) → tillåts (ingen falsk blockering)', async () => {
    const { service, prisma } = makeService()
    // Samma datum + samma hyra som harnessens existing (2027-01-01 / 10000) — en
    // äkta web-resubmit av oförändrade värden får INTE blockeras (varken av
    // endDate-guarden eller T1.1a edit-låset).
    await service.update('lease-1', { endDate: '2027-01-01', monthlyRent: 10000 } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('ACTIVE utan endDate i payload (bara oförändrad hyra) → tillåts', async () => {
    const { service, prisma } = makeService()
    await service.update('lease-1', { monthlyRent: 10000 } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('DRAFT + ändrat endDate → tillåts (inget aktivt hyresförhållande att skydda)', async () => {
    const { service, prisma } = makeService({ status: 'DRAFT' })
    await service.update('lease-1', { endDate: '2026-08-13' } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })
})
