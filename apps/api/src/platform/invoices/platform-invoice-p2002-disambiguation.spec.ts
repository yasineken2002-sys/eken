// PENGAR — P2002-disambiguering i generateInvoicesForPeriod:
//   • En P2002 på PERIOD-idempotens-indexet (platform_invoice_unique_period,
//     rått partiellt index → Prisma rapporterar STRÄNG/indexnamn) = benign race
//     → skipped, INGET larm (som B1c, FAR-godkänt).
//   • En P2002 på invoiceNumber-unikheten (schema-@unique → KOLUMN-ARRAY, eller
//     constraint-namn-STRÄNG) = nummer-race → får ALDRIG tyst skippas som "fanns
//     redan": failed + UI-rad + larm (via forEachOrgSafely).
// Bevisar båda err.meta.target-vägarna mot RIKTIGA generateInvoicesForPeriod.
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { captureException } from '@sentry/nestjs'
import { Prisma } from '@prisma/client'
import { PlatformInvoicesService } from './platform-invoices.service'

const mockedCapture = captureException as jest.Mock

function p2002(target: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError('unik krock', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  })
}

function makeService() {
  const prisma = {
    organization: {
      findMany: jest.fn().mockResolvedValue([{ id: 'org-A', name: 'A AB', planMonthlyFee: 390 }]),
    },
    platformInvoice: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  const config = {
    get: jest.fn((key: string, def?: string) =>
      key === 'AUTO_SEND_PLATFORM_INVOICES' ? 'false' : def,
    ),
  }
  const svc = new PlatformInvoicesService(
    prisma as never,
    {} as never,
    {} as never,
    config as never,
    {} as never,
  )
  ;(svc as unknown as { logger: unknown }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return svc
}

beforeEach(() => mockedCapture.mockClear())

describe('generateInvoicesForPeriod — P2002-disambiguering (pengar)', () => {
  it('PERIOD-index (kolumn-array, EMPIRISK Prisma-form) → skipped, INGET larm (benignt)', async () => {
    const svc = makeService()
    // Empiriskt verifierad form mot dev-Postgres (Prisma 5.19).
    jest
      .spyOn(svc, 'create')
      .mockRejectedValue(p2002(['organizationId', 'type', 'planPeriodStart']))

    const r = await svc.createMonthlyInvoices()

    expect(r.skipped).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.created).toBe(0)
    expect(mockedCapture).not.toHaveBeenCalled()
  })

  it('PERIOD-index (sträng-fallback, indexnamn) → skipped, INGET larm', async () => {
    const svc = makeService()
    jest.spyOn(svc, 'create').mockRejectedValue(p2002('platform_invoice_unique_period'))

    const r = await svc.createMonthlyInvoices()

    expect(r.skipped).toBe(1)
    expect(r.failed).toBe(0)
    expect(mockedCapture).not.toHaveBeenCalled()
  })

  it('invoiceNumber-@unique (kolumn-array) → INTE benign: failed + larm, ej tyst skip', async () => {
    const svc = makeService()
    jest.spyOn(svc, 'create').mockRejectedValue(p2002(['invoiceNumber']))

    const r = await svc.createMonthlyInvoices()

    // Får ALDRIG maskeras som benign period-skip:
    expect(r.skipped).toBe(0)
    expect(r.failed).toBe(1)
    expect(r.failures).toHaveLength(1)
    // Larmar (forEachOrgSafely) med org-tagg:
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [, ctx] = mockedCapture.mock.calls[0]
    expect((ctx as { tags: Record<string, string> }).tags).toEqual(
      expect.objectContaining({ cron: 'platform-invoices-monthly', org: 'org-A' }),
    )
  })

  it('invoiceNumber-constraint (sträng, ej period) → INTE benign: failed + larm', async () => {
    const svc = makeService()
    jest.spyOn(svc, 'create').mockRejectedValue(p2002('PlatformInvoice_invoiceNumber_key'))

    const r = await svc.createMonthlyInvoices()

    expect(r.skipped).toBe(0)
    expect(r.failed).toBe(1)
    expect(mockedCapture).toHaveBeenCalledTimes(1)
  })

  it('okänd/saknad target → fail-safe: INTE benign (hellre larm än tyst försvunnen faktura)', async () => {
    const svc = makeService()
    jest.spyOn(svc, 'create').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unik krock utan target', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    )

    const r = await svc.createMonthlyInvoices()

    expect(r.skipped).toBe(0)
    expect(r.failed).toBe(1)
    expect(mockedCapture).toHaveBeenCalledTimes(1)
  })
})
