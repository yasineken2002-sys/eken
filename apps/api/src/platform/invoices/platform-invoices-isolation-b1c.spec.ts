// T5 B1c — bevisar PENGA-invarianterna för plattforms-månadsfakturering:
//  (1) idempotens PER ORG: kör createMonthlyInvoices två gånger → ingen
//      dubbelfaktura (andra körningen hoppar via findFirst).
//  (2) isolering: ett org-fel avbryter INTE andra orgars fakturering + larmar.
//  (3) P2002 (race på unika indexet) → skipped, benignt (inget larm).
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))
// PlatformInvoicesService → PdfService/pdf.queue-grafen drar transitivt in
// storage.service (AWS SDK, ESM) som jest inte kan parsa. Stubbas — samma
// mönster som övriga specar som transitivt rör storage.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { captureException } from '@sentry/nestjs'
import { Prisma } from '@prisma/client'
import { PlatformInvoicesService } from './platform-invoices.service'

const mockedCapture = captureException as jest.Mock

type OrgRow = { id: string; name: string; planMonthlyFee: number }

function makeService(orgs: OrgRow[]) {
  const findFirst = jest.fn()
  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue(orgs) },
    platformInvoice: { findFirst },
  }
  // AUTO_SEND av → generateInvoicesForPeriod hoppar send()-vägen (renodlar
  // create-idempotensen), speglar AUTO_SEND_PLATFORM_INVOICES=false.
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
  return { svc, findFirst }
}

beforeEach(() => mockedCapture.mockClear())

describe('PlatformInvoicesService — B1c idempotens + isolering (pengar)', () => {
  it('kör två gånger → ingen dubbelfaktura (idempotens per org)', async () => {
    const orgs: OrgRow[] = [
      { id: 'org-A', name: 'A AB', planMonthlyFee: 390 },
      { id: 'org-B', name: 'B AB', planMonthlyFee: 590 },
    ]
    const { svc, findFirst } = makeService(orgs)

    // Stateful idempotens: en org som fått faktura hittas av findFirst nästa varv.
    const created = new Set<string>()
    findFirst.mockImplementation(async ({ where }: { where: { organizationId: string } }) =>
      created.has(where.organizationId) ? { id: 'existing' } : null,
    )
    const createSpy = jest
      .spyOn(svc, 'create')
      .mockImplementation(async ({ organizationId }: { organizationId: string }) => {
        created.add(organizationId)
        return { id: `inv-${organizationId}`, invoiceNumber: `PLT-${organizationId}` } as never
      })

    const r1 = await svc.createMonthlyInvoices()
    expect(r1.created).toBe(2)
    expect(r1.skipped).toBe(0)

    const r2 = await svc.createMonthlyInvoices()
    expect(r2.created).toBe(0)
    expect(r2.skipped).toBe(2)

    // create() anropades TOTALT bara två gånger (första körningen) — ingen
    // dubbelfaktura trots två körningar.
    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(mockedCapture).not.toHaveBeenCalled()
  })

  it('ett org-fel avbryter INTE andra orgars fakturering + larmar (org-tagg)', async () => {
    const orgs: OrgRow[] = [
      { id: 'org-A', name: 'A AB', planMonthlyFee: 390 },
      { id: 'org-B', name: 'B AB', planMonthlyFee: 590 },
      { id: 'org-C', name: 'C AB', planMonthlyFee: 790 },
    ]
    const { svc, findFirst } = makeService(orgs)
    findFirst.mockResolvedValue(null)
    const createSpy = jest
      .spyOn(svc, 'create')
      .mockImplementation(async ({ organizationId }: { organizationId: string }) => {
        if (organizationId === 'org-B') throw new Error('create DB-fel för B')
        return { id: `inv-${organizationId}`, invoiceNumber: `PLT-${organizationId}` } as never
      })

    const r = await svc.createMonthlyInvoices()

    // A och C fakturerades trots att B kraschade mitt i:
    expect(createSpy).toHaveBeenCalledTimes(3) // alla tre försöktes
    expect(r.created).toBe(2)
    expect(r.failed).toBe(1)

    // B larmade — INTE tyst — med org-tagg:
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [sentryErr, ctx] = mockedCapture.mock.calls[0]
    expect((sentryErr as Error).message).not.toContain('DB-fel för B') // skrubbat
    expect((ctx as { tags: Record<string, string> }).tags).toEqual(
      expect.objectContaining({ cron: 'platform-invoices-monthly', org: 'org-B' }),
    )
  })

  it('idempotens-kollen (findFirst) kastar → org räknas som failed + UI-rad + larm, INTE tyst bortglömd', async () => {
    // FAR-fynd (T5 B1c): findFirst låg utanför try:et → en transient blipp där
    // isolerades av forEachOrgSafely men FÖLL UR summary. GenerationResult ska
    // vara identiskt kontrakt: created+sent+skipped+failed = antal orgar.
    const orgs: OrgRow[] = [
      { id: 'org-A', name: 'A AB', planMonthlyFee: 390 },
      { id: 'org-B', name: 'B AB', planMonthlyFee: 590 },
      { id: 'org-C', name: 'C AB', planMonthlyFee: 790 },
    ]
    const { svc, findFirst } = makeService(orgs)
    findFirst.mockImplementation(async ({ where }: { where: { organizationId: string } }) => {
      if (where.organizationId === 'org-B') throw new Error('findFirst DB-blipp för B')
      return null
    })
    const createSpy = jest
      .spyOn(svc, 'create')
      .mockImplementation(
        async ({ organizationId }: { organizationId: string }) =>
          ({ id: `inv-${organizationId}`, invoiceNumber: `PLT-${organizationId}` }) as never,
      )

    const r = await svc.createMonthlyInvoices()

    // A och C fakturerades trots att B:s idempotens-koll kraschade:
    expect(r.created).toBe(2)
    // B räknas som failed (föll INTE ur summary) → kontraktet summerar:
    expect(r.failed).toBe(1)
    expect(r.created + r.sent + r.skipped + r.failed).toBe(orgs.length)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('B AB')
    // create() anropades ALDRIG för B (findFirst kastade före):
    expect(createSpy).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-B' }))
    // B larmade med org-tagg:
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [, ctx] = mockedCapture.mock.calls[0]
    expect((ctx as { tags: Record<string, string> }).tags).toEqual(
      expect.objectContaining({ cron: 'platform-invoices-monthly', org: 'org-B' }),
    )
  })

  it('P2002 på PERIOD-indexet (race) → skipped, INGET larm (benignt)', async () => {
    const orgs: OrgRow[] = [{ id: 'org-A', name: 'A AB', planMonthlyFee: 390 }]
    const { svc, findFirst } = makeService(orgs)
    findFirst.mockResolvedValue(null) // app-koll missar racet...
    jest.spyOn(svc, 'create').mockRejectedValue(
      // ...periodindexet fångar det istället. meta.target = kolumn-arrayen
      // (EMPIRISKT verifierad Prisma-form) → disambigueras som benign.
      new Prisma.PrismaClientKnownRequestError('unik krock', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['organizationId', 'type', 'planPeriodStart'] },
      }),
    )

    const r = await svc.createMonthlyInvoices()
    expect(r.skipped).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.created).toBe(0)
    expect(mockedCapture).not.toHaveBeenCalled()
  })
})
