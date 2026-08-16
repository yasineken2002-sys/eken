/**
 * M3 (del 1) — aktiveringsvägen skilde inte på VILKET unikhetsbrott det var.
 *
 * `createInitialNoticesForLease` fångade varje `P2002` som benign idempotens
 * ("någon annan hann skapa avin") och gjorde en `findFirst` på
 * `(leaseId, year, month, type)`. Kom felet i stället från
 * `@@unique(organizationId, noticeNumber)` hittade den sökningen ingenting,
 * `firstRentNotice` blev `null`, och aktiveringen returnerade
 * `{ firstRent: null, mailed: false }` som om allt gått bra.
 *
 * Hyresgästen fick aldrig sin första avi. Ingenting kastade, ingenting loggade.
 *
 * Specen bevakar BÅDA halvorna, för annars byter man en tyst defekt mot ett
 * falskt larm:
 *   1. ett avinummer-race SYNS nu hela vägen ut
 *   2. den benigna periodkollisionen passerar fortfarande tyst
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Prisma } from '@prisma/client'
import { AviseringService } from './avisering.service'

function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.19.0',
    meta: { target },
  })
}

/**
 * `createRejects` — felet `rentNotice.create` kastar när hyresavin skapas.
 * `befintlig` — vad `findFirst` svarar i den benigna grenen (null = "hittades ej").
 */
function rigg(opts: { createRejects?: unknown; befintlig?: unknown } = {}) {
  const startDate = new Date(new Date().getFullYear(), new Date().getMonth() + 2, 1)
  const lease = {
    id: 'lease-1',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    monthlyRent: 10_000,
    monthlyRentExcludingVat: false,
    depositAmount: 0,
    startDate,
    endDate: null,
    status: 'ACTIVE',
    tenant: { id: 'tenant-1', email: null, type: 'INDIVIDUAL' },
    unit: { id: 'unit-1', type: 'APARTMENT', voluntaryTaxLiability: false, name: 'Lgh 1', property: {} }, // prettier-ignore
  }

  const findFirst = jest.fn().mockResolvedValue(opts.befintlig ?? null)
  const create = opts.createRejects
    ? jest.fn().mockRejectedValue(opts.createRejects)
    : jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'rn-1', ...data }),
        )

  const prisma = {
    lease: { findUnique: jest.fn().mockResolvedValue(lease) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ daysBeforeMoveInForFirstPayment: 7 }),
    },
    rentNotice: { findMany: jest.fn().mockResolvedValue([]), findFirst, create },
    $transaction: (cb: (t: unknown) => unknown) => cb(prisma),
  }

  const service = new AviseringService(
    prisma as never,
    { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je-1' }) } as never,
    { attachRentNoticeLineCharges: jest.fn().mockResolvedValue(0) } as never,
    {} as never,
    { ensureDepositForNotice: jest.fn() } as never,
    {} as never,
  )
  return { service, prisma, findFirst }
}

describe('createInitialNoticesForLease — vilket P2002 var det?', () => {
  it('KÄRNAN: ett AVINUMMER-race sväljs INTE längre — det kastar', async () => {
    // Före ändringen returnerade det här `{ firstRent: null, mailed: false }`
    // utan fel och utan logg.
    const { service, findFirst } = rigg({
      createRejects: p2002(['organizationId', 'noticeNumber']),
    })

    await expect(service.createInitialNoticesForLease('lease-1', {})).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
    // Och den benigna vägen togs aldrig — ingen findFirst att maskera med.
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('MOTSATSEN: den benigna periodkollisionen passerar fortfarande tyst', async () => {
    // Utan det här testet hade man kunnat byta en tyst defekt mot ett falskt
    // larm och inte märkt det: idempotensen ÄR avsedd och måste överleva.
    const befintlig = { id: 'rn-befintlig', leaseId: 'lease-1' }
    const { service } = rigg({
      createRejects: p2002(['leaseId', 'year', 'month', 'type']),
      befintlig,
    })

    const resultat = await service.createInitialNoticesForLease('lease-1', {})
    expect(resultat.firstRent).toMatchObject({ id: 'rn-befintlig' })
  })

  it('benign kollision men INGEN rad hittas → larmar, returnerar aldrig null', async () => {
    // Premissen i den grenen är att raden FINNS. Håller den inte är det inte
    // idempotens vi råkat ut för, och `{ firstRent: null }` vore samma tystnad
    // en nivå upp.
    const { service } = rigg({
      createRejects: p2002(['leaseId', 'year', 'month', 'type']),
      befintlig: null,
    })

    await expect(service.createInitialNoticesForLease('lease-1', {})).rejects.toThrow(
      /ingen rad hittades/,
    )
  })

  it('okänd target är INTE benign — fail-closed hela vägen ut', async () => {
    const { service } = rigg({ createRejects: p2002(undefined) })
    await expect(service.createInitialNoticesForLease('lease-1', {})).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
  })

  it('ett icke-P2002-fel bubblar som förut', async () => {
    const { service } = rigg({ createRejects: new Error('DB nere') })
    await expect(service.createInitialNoticesForLease('lease-1', {})).rejects.toThrow('DB nere')
  })

  it('normalfallet oförändrat: ingen kollision → avin skapas', async () => {
    const { service, findFirst } = rigg()
    const resultat = await service.createInitialNoticesForLease('lease-1', {})
    expect(resultat.firstRent).toBeTruthy()
    expect(findFirst).not.toHaveBeenCalled()
  })
})
