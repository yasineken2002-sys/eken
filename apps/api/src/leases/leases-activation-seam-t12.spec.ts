/**
 * T1.2 — delad aktiverings-seam + statusmaskin (#60).
 *
 * Två vägar aktiverar ett avtal; T1.2 gör dem till EN seam parametriserad på
 * ursprung, så att succession (renew/autoRenew) får samma efterled som manuell
 * aktivering utom det som är fel för en förnyelse:
 *   manuell     → PDF + välkomstmejl + initial-avier (deposition + första avi)
 *   succession  → PDF + gap-avi (skipDeposit) + INGEN välkomstmejl
 *
 * Bevisar:
 *   A) transitionStatus(DRAFT→ACTIVE) dispatchar origin:'manual' — PDF, välkomst,
 *      initial-avier (skipDeposit=false).
 *   B) Statusmaskinen (assertLeaseTransition) nekar en ogiltig övergång.
 *   C) renew() dispatchar origin:'succession' — PDF + gap-avi (skipDeposit=true),
 *      INGEN välkomst; gammalt→EXPIRED, nytt→ACTIVE.
 *   D) autoRenewExpiredFixedTerm() dispatchar likadant (succession).
 *   E) createInitialNoticesForLease(skipDeposit) hoppar deposition-avin.
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { isValidLeaseTransition } from '@eken/shared'
import { LeasesService } from './leases.service'

function makeQueue() {
  return {
    enqueueGenerateContract: jest.fn().mockResolvedValue('job-pdf'),
    enqueueWelcomeMail: jest.fn().mockResolvedValue('job-mail'),
    enqueueInitialNotices: jest.fn().mockResolvedValue('job-notices'),
  }
}

function txClient(created: Record<string, unknown> = {}) {
  return {
    lease: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue(created),
      count: jest.fn().mockResolvedValue(1),
    },
    unit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
}

// ── A + B: transitionStatus ────────────────────────────────────────────────────
function makeForTransition(leaseStatus: string) {
  const activationQueue = makeQueue()
  const tx = txClient()
  // transitionStatus dispatchar på tx.lease.update-resultatet (den uppdaterade raden).
  tx.lease.update.mockResolvedValue({
    id: 'lease-1',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    unit: { type: 'APARTMENT' },
  })
  const prisma = {
    lease: {
      // findOne (1) → leaset; describeActiveBlocker (2) → ingen blockerare
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'lease-1',
          status: leaseStatus,
          organizationId: 'org-1',
          unitId: 'unit-1',
          tenantId: 'tenant-1',
          contractNumber: null,
          unit: { type: 'APARTMENT', name: 'A1', property: { name: 'F1' } },
        })
        .mockResolvedValueOnce(null),
      update: jest
        .fn()
        .mockResolvedValue({ id: 'lease-1', organizationId: 'org-1', tenantId: 'tenant-1' }),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const contractNumbers = { allocate: jest.fn().mockResolvedValue('KONT-2026-0001') }
  const noop = {} as never
  const service = new LeasesService(
    prisma as never,
    noop, // notifications
    noop, // deposits
    noop, // rentIncreases
    noop, // tenantAuth
    noop, // contracts
    contractNumbers as never,
    activationQueue as never,
  )
  return { service, activationQueue }
}

describe('T1.2 · transitionStatus(DRAFT→ACTIVE) dispatchar origin:manual', () => {
  it('PDF + välkomstmejl + initial-avier (skipDeposit=false)', async () => {
    const { service, activationQueue } = makeForTransition('DRAFT')
    await service.transitionStatus('lease-1', 'ACTIVE', 'org-1', 'user-9')

    expect(activationQueue.enqueueGenerateContract).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueGenerateContract.mock.calls[0]![0]).toMatchObject({
      leaseId: 'lease-1',
      organizationId: 'org-1',
      actorUserId: 'user-9',
    })
    expect(activationQueue.enqueueWelcomeMail).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueInitialNotices).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueInitialNotices.mock.calls[0]![0]).toMatchObject({
      leaseId: 'lease-1',
      skipDeposit: false,
    })
  })
})

describe('T1.2 · statusmaskin nekar ogiltig övergång', () => {
  it('EXPIRED→ACTIVE → "Ogiltig statusövergång", ingen aktivering', async () => {
    const { service, activationQueue } = makeForTransition('EXPIRED')
    await expect(service.transitionStatus('lease-1', 'ACTIVE', 'org-1')).rejects.toThrow(
      /Ogiltig statusövergång/,
    )
    expect(activationQueue.enqueueGenerateContract).not.toHaveBeenCalled()
  })

  it('LEASE_STATUS_TRANSITIONS: giltiga vs ogiltiga', () => {
    expect(isValidLeaseTransition('DRAFT', 'ACTIVE')).toBe(true)
    expect(isValidLeaseTransition('ACTIVE', 'EXPIRED')).toBe(true)
    expect(isValidLeaseTransition('ACTIVE', 'TERMINATED')).toBe(true)
    expect(isValidLeaseTransition('EXPIRED', 'ACTIVE')).toBe(false)
    expect(isValidLeaseTransition('TERMINATED', 'ACTIVE')).toBe(false)
  })
})

// ── C: renew ────────────────────────────────────────────────────────────────────
describe('T1.2 · renew() dispatchar origin:succession', () => {
  it('PDF + gap-avi (skipDeposit=true), INGEN välkomst; gammalt→EXPIRED, nytt→ACTIVE', async () => {
    const activationQueue = makeQueue()
    const created = {
      id: 'lease-2',
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      unitId: 'unit-1',
    }
    const tx = txClient(created)
    const prisma = {
      lease: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lease-1',
          status: 'ACTIVE',
          leaseType: 'FIXED_TERM',
          organizationId: 'org-1',
          unitId: 'unit-1',
          tenantId: 'tenant-1',
          endDate: new Date('2026-12-31'),
          monthlyRent: 10000,
          depositAmount: 0,
          renewalPeriodMonths: 12,
          noticePeriodMonths: 3,
          tenancyRegime: 'TENANCY_ACT',
          indexClause: false,
          unit: { type: 'APARTMENT' },
        }),
      },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    }
    const contractNumbers = { allocate: jest.fn().mockResolvedValue('KONT-2026-0002') }
    const noop = {} as never
    const service = new LeasesService(
      prisma as never,
      noop,
      noop,
      noop,
      noop,
      noop,
      contractNumbers as never,
      activationQueue as never,
    )

    const result = await service.renew('lease-1', {} as never, 'org-1')

    // Gammalt → EXPIRED, nytt → ACTIVE
    expect(tx.lease.update.mock.calls[0]![0]).toMatchObject({
      where: { id: 'lease-1' },
      data: { status: 'EXPIRED' },
    })
    expect(tx.lease.create.mock.calls[0]![0].data).toMatchObject({ status: 'ACTIVE' })
    expect(result).toBe(created)

    // Succession-dispatch: PDF + gap-avi (skipDeposit), INGEN välkomst
    expect(activationQueue.enqueueGenerateContract).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueWelcomeMail).not.toHaveBeenCalled()
    expect(activationQueue.enqueueInitialNotices).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueInitialNotices.mock.calls[0]![0]).toMatchObject({
      leaseId: 'lease-2',
      skipDeposit: true,
    })
  })
})

// ── D: autoRenewExpiredFixedTerm ────────────────────────────────────────────────
describe('T1.2 · autoRenewExpiredFixedTerm() dispatchar origin:succession', () => {
  it('PDF + gap-avi (skipDeposit=true), INGEN välkomst', async () => {
    const activationQueue = makeQueue()
    const created = { id: 'lease-3', organizationId: 'org-1', tenantId: 'tenant-1' }
    const tx = txClient(created)
    const candidate = {
      id: 'lease-1',
      status: 'ACTIVE',
      leaseType: 'FIXED_TERM',
      organizationId: 'org-1',
      unitId: 'unit-1',
      tenantId: 'tenant-1',
      endDate: new Date('2026-01-01'),
      monthlyRent: 10000,
      depositAmount: 0,
      renewalPeriodMonths: 12,
      noticePeriodMonths: 3,
      tenancyRegime: 'TENANCY_ACT',
      indexClause: false,
    }
    const prisma = {
      lease: { findMany: jest.fn().mockResolvedValue([candidate]) },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    }
    const contractNumbers = { allocate: jest.fn().mockResolvedValue('KONT-2026-0003') }
    const noop = {} as never
    const service = new LeasesService(
      prisma as never,
      noop,
      noop,
      noop,
      noop,
      noop,
      contractNumbers as never,
      activationQueue as never,
    )

    const n = await (
      service as unknown as { autoRenewExpiredFixedTerm: (d: Date) => Promise<number> }
    ).autoRenewExpiredFixedTerm(new Date('2026-06-01'))

    expect(n).toBe(1)
    expect(activationQueue.enqueueGenerateContract).toHaveBeenCalledTimes(1)
    expect(activationQueue.enqueueWelcomeMail).not.toHaveBeenCalled()
    expect(activationQueue.enqueueInitialNotices.mock.calls[0]![0]).toMatchObject({
      leaseId: 'lease-3',
      skipDeposit: true,
    })
  })
})
