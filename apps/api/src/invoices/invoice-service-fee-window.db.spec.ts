/**
 * SERVICEAVGIFTSFÖNSTRET — mot RIKTIG POSTGRES (#665).
 *
 * ── VARFÖR DEN HÄR FILEN FINNS ──────────────────────────────────────────────
 *
 * Varje spärr behöver två kontroller: att samma anrop två gånger ger EN effekt,
 * och att två LEGITIMA anrop ger TVÅ. Den andra fångar en FÖR GROV nämnare —
 * och den går inte att köra mot en attrapp.
 *
 * Skälet är mekaniskt: en attrapp returnerar det den blev tillsagd att
 * returnera, oavsett `where`. Tappar avgränsningen ett fält ser attrappen ingen
 * skillnad. Uppmätt på just det här fönstret: med `total` och `dueDate`
 * borttagna ur frågan förblev det mockade provet GRÖNT, och bara en separat
 * assertion på `where`-satsens innehåll föll.
 *
 * Här utvärderas `where` av databasen. Då faller de två riktningarna ihop i ETT
 * prov: två fakturor som skiljer sig i **ett enda fält** ska ge två effekter, och
 * gör det bara om fältet finns i avgränsningen.
 *
 * ── VARJE PROV ISOLERAR ETT FÄLT — DET ÄR KANARIEFÅGELN ─────────────────────
 *
 * Proven nedan skiljer sig från det blockerande fallet i exakt en sak vardera:
 * `total`, `dueDate`, `leaseId`, `type`, `status`, `creditedInvoiceId`,
 * respektive ålder. Tas motsvarande fält bort ur signaturen blir just det provet
 * rött — nämnaren har då blivit för grov, och en verklig andra avgift hade
 * försvunnit. Det är den riktning attrappen aldrig kunde mäta.
 *
 * ── VAD PROVEN INTE SER ─────────────────────────────────────────────────────
 *
 * De mäter uppslaget, inte hela `create()`. Att en blockerad faktura verkligen
 * inte bokförs (`txCreate` aldrig anropad) ägs av `invoices.rent-dup-guard.spec.ts`,
 * som kör tjänstens väg med attrapp. De två filerna delar alltså inte ansvar —
 * de mäter olika saker om samma spärr.
 *
 * Riggen skapar sina EGNA förutsättningar och städar i FK-riktning. Den lånar
 * ingenting ur omgivningen.
 */
jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { computeInvoiceAmounts } from './invoice-amounts'
import { DUBBLETT_FAKTURA_FONSTER_MS } from './duplicate-invoice-window'
import { InvoicesService } from './invoices.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const FÖRFALL = '2026-06-30'

/** Raderna är desamma i alla prov — det som varieras står i DTO:n. */
const RADER = [{ description: 'Trappstädning', quantity: 1, unitPrice: 2_000, vatRate: 25 }]

/**
 * Beloppet räknas med SAMMA funktion som koden, inte med ett tal skrivet en
 * andra gång. Ett prov som upprepar talet slutar mäta att koden använder det.
 */
const TOTAL = computeInvoiceAmounts(RADER).total

medDb('serviceavgiftsfönstret (#665)', () => {
  let prisma: PrismaClient
  let service: InvoicesService
  let orgId: string
  let tenantId: string
  let propertyId: string
  let leaseA: string
  let leaseB: string

  const dto = (over: { type?: string; dueDate?: string; unitPrice?: number } = {}) => ({
    type: over.type ?? 'SERVICE',
    issueDate: '2026-06-01',
    dueDate: over.dueDate ?? FÖRFALL,
    lines: over.unitPrice ? [{ ...RADER[0]!, unitPrice: over.unitPrice }] : RADER,
  })

  /** Skriver fakturan DIREKT — provet mäter uppslaget, inte tjänstens skrivväg. */
  const seedaFaktura = (
    over: {
      leaseId?: string
      type?: 'RENT' | 'SERVICE'
      total?: number
      dueDate?: string
      status?: 'SENT' | 'VOID' | 'DRAFT'
      creditedInvoiceId?: string
      createdAt?: Date
    } = {},
  ) =>
    prisma.invoice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId: over.leaseId ?? leaseA,
        invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
        type: over.type ?? 'SERVICE',
        issueDate: new Date('2026-06-01'),
        dueDate: new Date(over.dueDate ?? FÖRFALL),
        subtotal: over.total ?? TOTAL,
        vatTotal: 0,
        total: over.total ?? TOTAL,
        status: over.status ?? 'SENT',
        ...(over.creditedInvoiceId ? { creditedInvoiceId: over.creditedInvoiceId } : {}),
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      },
      select: { id: true },
    })

  /** Anropar PRODUKTIONENS uppslag. Kastar ConflictException om det blockerar. */
  const pröva = (over: Parameters<typeof dto>[0] = {}, leaseId?: string) =>
    (
      service as unknown as {
        assertNoDuplicateInvoice: (d: unknown, l: string) => Promise<void>
      }
    ).assertNoDuplicateInvoice(dto(over), leaseId ?? leaseA)

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = Object.create(InvoicesService.prototype) as InvoicesService
    Object.assign(service, { prisma })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `sf-${sfx}`,
        email: `sf-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const t = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `sf-t-${sfx}@example.se` },
      select: { id: true },
    })
    tenantId = t.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `SF ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id

    const leaseIds: string[] = []
    for (let i = 0; i < 2; i++) {
      const unit = await prisma.unit.create({
        data: {
          propertyId,
          name: `Lgh ${i}`,
          unitNumber: `${30 + i}`,
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
      leaseIds.push(lease.id)
    }
    leaseA = leaseIds[0]!
    leaseB = leaseIds[1]!
  })

  beforeEach(async () => {
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    // FK-riktning: fakturor före avtal, avtal före enheter, och så vidare.
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  // ── RIKTNING 1: samma anrop två gånger ger EN effekt ───────────────────────

  it('SAMMA anrop två gånger: en färsk identisk avgift BLOCKERAR', async () => {
    await seedaFaktura()
    await expect(pröva()).rejects.toBeInstanceOf(ConflictException)
  })

  it('utan någon tidigare faktura går den första igenom', async () => {
    await expect(pröva()).resolves.toBeUndefined()
  })

  // ── RIKTNING 2: två LEGITIMA anrop ger TVÅ ────────────────────────────────
  //
  // Varje prov varierar EXAKT ETT fält. Tas fältet bort ur signaturen blir just
  // det provet rött. Det är den för-grova riktningen, och den kan bara mätas
  // här — attrappen ser ingen skillnad på ett `where` den ändå ignorerar.

  it('ANNAT BELOPP → går igenom (fältet `total` bär sin del)', async () => {
    await seedaFaktura()
    await expect(pröva({ unitPrice: 3_000 })).resolves.toBeUndefined()
  })

  it('ANNAN FÖRFALLODAG → går igenom (fältet `dueDate` bär sin del)', async () => {
    await seedaFaktura()
    await expect(pröva({ dueDate: '2026-07-31' })).resolves.toBeUndefined()
  })

  it('ANNAT AVTAL → går igenom (fältet `leaseId` bär sin del)', async () => {
    await seedaFaktura({ leaseId: leaseA })
    await expect(pröva({}, leaseB)).resolves.toBeUndefined()
  })

  it('ANNAN TYP → går igenom (fältet `type` bär sin del)', async () => {
    await seedaFaktura({ type: 'SERVICE' })
    await expect(pröva({ type: 'OTHER' })).resolves.toBeUndefined()
  })

  it('MAKULERAD tidigare faktura → går igenom (`status: not VOID` bär sin del)', async () => {
    await seedaFaktura({ status: 'VOID' })
    await expect(pröva()).resolves.toBeUndefined()
  })

  it('KREDITNOTA räknas inte som dubblett (`creditedInvoiceId: null` bär sin del)', async () => {
    // Kreditnotan ärver typ, avtal, belopp och förfallodag från originalet. Utan
    // villkoret hade en kreditering i samma minut blockerat nästa riktiga avgift.
    // Originalet skiljer sig i FÖRFALLODAG, så det blockerar inte av egen kraft
    // — annars hade provet inte kunnat isolera `creditedInvoiceId`. Kreditnotan
    // matchar DTO:n exakt och får ändå inte blockera.
    const original = await seedaFaktura({ dueDate: '2026-08-31' })
    await seedaFaktura({ creditedInvoiceId: original.id })
    await expect(pröva()).resolves.toBeUndefined()
  })

  it('UTANFÖR FÖNSTRET → går igenom (`createdAt` bär sin del)', async () => {
    // Åldern räknas mot KONSTANTEN, inte mot 60000 skrivet en andra gång: ett
    // prov som upprepar talet slutar mäta att koden använder det.
    await seedaFaktura({
      createdAt: new Date(Date.now() - DUBBLETT_FAKTURA_FONSTER_MS - 5_000),
    })
    await expect(pröva()).resolves.toBeUndefined()
  })

  it('PRECIS INOM fönstret → blockerar fortfarande', async () => {
    await seedaFaktura({
      createdAt: new Date(Date.now() - DUBBLETT_FAKTURA_FONSTER_MS + 10_000),
    })
    await expect(pröva()).rejects.toBeInstanceOf(ConflictException)
  })
})
