/**
 * EN HYRESFAKTURA PER AVTAL OCH PERIOD — mot riktig Postgres.
 *
 * ── VAD SOM BLEV DB-ENFORCERAT, OCH VAD SOM INTE KUNDE BLI DET ──────────────
 *
 * Dubbelfaktureringsspärren var en LÄSNING FÖRE en skrivning, eftersom perioden
 * bars av två tabeller. `Invoice` bär den nu explicit
 * (`rentPeriodYear`/`rentPeriodMonth`), och `invoice_rent_period_unique` gör
 * faktura-mot-faktura omöjlig — även för två samtidiga anrop.
 *
 * Faktura-mot-AVI kunde inte bli det: ett unikt villkor spänner en tabell. Den
 * halvan står som en känd gräns vid uppslaget i `invoices.service.ts`, med
 * villkoret för när den blir verklig och vad den riktiga lösningen vore.
 *
 * ── PREDIKATET ÄR KONSTRUKTIONEN, OCH KREDITNOTAN ÄR DESS SKARPASTE PROV ────
 *
 * `credit-note.service` skriver `type: original.type`, så en kreditnota på en
 * hyresfaktura är SJÄLV `type='RENT'` med samma `leaseId` och `issueDate = idag`.
 * Utan `creditedInvoiceId IS NULL` i predikatet krockar en faktura med sin egen
 * kreditnota i samma månad — och att kreditera i samma månad är NORMALFALLET.
 *
 * Provet "kreditnota tillåts" faller om någon förenklar villkoret. Det är den
 * negativa kontroll som betyder mest här.
 *
 * ── VARFÖR EN LAGRAD KOLUMN OCH INTE EN GENERERAD ──────────────────────────
 *
 * `GENERATED ALWAYS AS (EXTRACT(...)) STORED` fungerar i Postgres (prövat) men
 * kan bara härleda ur det LAGRADE värdet, och `issueDate` är en DATE — tidszonen
 * är redan borta. Uppslaget mot RentNotice använder svensk civil tid, och de två
 * härledningarna är oense för tidsstämplar mellan 22:00 UTC och midnatt. Det
 * hade blivit två sanningar i stället för en drift. Se `rent-period.ts`.
 *
 * Priset är att uppdateringsvägen MÅSTE räkna om värdet — och det har ett eget
 * prov längst ned, inte en kommentar.
 */
jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import { InvoicesService } from './invoices.service'
import { rentPeriodFalt } from './rent-period'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const JUNI = '2026-06-01'
const TOTAL = 10_000

medDb('invoice_rent_period_unique', () => {
  let prisma: PrismaClient
  let service: InvoicesService
  let orgId: string
  let tenantId: string
  let leaseA: string
  let leaseB: string
  let propertyId: string

  /** Skriver direkt mot databasen — provet mäter VILLKORET, inte tjänstens väg. */
  const faktura = (
    over: {
      leaseId?: string
      issueDate?: string
      type?: 'RENT' | 'SERVICE'
      creditedInvoiceId?: string
      status?: 'SENT' | 'VOID' | 'DRAFT'
    } = {},
  ) => {
    const typ = over.type ?? 'RENT'
    const datum = over.issueDate ?? JUNI
    return prisma.invoice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId: over.leaseId ?? leaseA,
        invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
        type: typ,
        issueDate: new Date(datum),
        dueDate: new Date(datum),
        subtotal: TOTAL,
        vatTotal: 0,
        total: TOTAL,
        status: over.status ?? 'SENT',
        ...(over.creditedInvoiceId ? { creditedInvoiceId: over.creditedInvoiceId } : {}),
        ...rentPeriodFalt(typ, datum),
      },
      select: { id: true },
    })
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = Object.create(InvoicesService.prototype) as InvoicesService
    Object.assign(service, {
      prisma,
      eventsService: { record: async () => undefined },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `per-${sfx}`,
        email: `per-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const t = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `per-t-${sfx}@example.se` },
      select: { id: true },
    })
    tenantId = t.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `PER ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const unit = await prisma.unit.create({
        data: {
          propertyId,
          name: `Lgh ${i}`,
          unitNumber: `${20 + i}`,
          type: 'APARTMENT',
          area: 50,
          rooms: 2,
          monthlyRent: TOTAL,
        },
        select: { id: true },
      })
      const lease = await prisma.lease.create({
        data: {
          organizationId: orgId,
          tenantId,
          unitId: unit.id,
          contractNumber: `HK-${sfx}-${i}`,
          monthlyRent: TOTAL,
          depositAmount: 0,
          startDate: new Date('2026-01-01'),
          tenancyStartDate: new Date('2026-01-01'),
          status: 'DRAFT',
        },
        select: { id: true },
      })
      ids.push(lease.id)
    }
    leaseA = ids[0]!
    leaseB = ids[1]!
  }, 30_000)

  beforeEach(async () => {
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const antal = () => prisma.invoice.count({ where: { organizationId: orgId } })

  it('TVÅ IDENTISKA hyresfakturor för samma avtal och period → EN', async () => {
    await faktura()
    await expect(faktura({ issueDate: '2026-06-15' })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
    expect(await antal()).toBe(1)
  })

  it('EN HYRESFAKTURA OCH DESS KREDITNOTA samma månad → BÅDA tillåtna', async () => {
    // Provet som faller om någon "förenklar" predikatet. Kreditnotan ärver
    // `type: 'RENT'` och samma leaseId, och krediteras normalt samma månad.
    const original = await faktura()
    await expect(
      faktura({ issueDate: '2026-06-20', creditedInvoiceId: original.id }),
    ).resolves.toBeDefined()
    expect(await antal()).toBe(2)
  })

  it('MOTPROV: nästa månad är en annan period', async () => {
    await faktura({ issueDate: JUNI })
    await faktura({ issueDate: '2026-07-01' })
    expect(await antal()).toBe(2)
  })

  it('MOTPROV: en ICKE-RENT-faktura samma månad krockar inte', async () => {
    await faktura()
    await faktura({ type: 'SERVICE', issueDate: '2026-06-10' })
    expect(await antal()).toBe(2)
  })

  it('MOTPROV: en MAKULERAD faktura gör inte längre anspråk på perioden', async () => {
    await faktura({ status: 'VOID' })
    await expect(faktura()).resolves.toBeDefined()
    expect(await antal()).toBe(2)
  })

  it('MOTPROV: ett annat AVTAL samma månad krockar inte', async () => {
    await faktura({ leaseId: leaseA })
    await faktura({ leaseId: leaseB })
    expect(await antal()).toBe(2)
  })

  it('UPPDATERINGSVÄGEN räknar om perioden — annars gäller spärren fel månad', async () => {
    // DET HÄR ÄR PROVET SOM ERSÄTTER EN KOMMENTAR. Glöms omräkningen i
    // `update()` fortsätter fakturan göra anspråk på juni efter att ha flyttats
    // till juli, och en ny junifaktura blockeras av en faktura som inte längre
    // hör till juni.
    // DRAFT: `update()` tillåter bara utkast. Ett utkast gör ändå anspråk på
    // perioden — predikatet utesluter bara VOID — så provet mäter rätt sak.
    const första = await faktura({ issueDate: JUNI, status: 'DRAFT' })
    await service.update(första.id, orgId, 'user-1', { issueDate: '2026-07-05' } as never)

    const efter = await prisma.invoice.findUniqueOrThrow({
      where: { id: första.id },
      select: { rentPeriodYear: true, rentPeriodMonth: true },
    })
    expect(efter).toEqual({ rentPeriodYear: 2026, rentPeriodMonth: 7 })

    // Och konsekvensen, som är det som faktiskt betyder något:
    await expect(faktura({ issueDate: JUNI })).resolves.toBeDefined()
  })

  it('konfliktens FORM är den som disambigueringen läser', async () => {
    await faktura()
    const fel = await faktura({ issueDate: '2026-06-15' }).then(
      () => null,
      (e: unknown) => e,
    )
    const target = ((fel as Prisma.PrismaClientKnownRequestError).meta as { target?: unknown })
      .target
    expect(target as string[]).toEqual(
      expect.arrayContaining(['leaseId', 'rentPeriodYear', 'rentPeriodMonth']),
    )
  })
})
