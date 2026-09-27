/**
 * B2 + F5 — AVINS LIVSCYKEL MOT RIKTIG DATABAS, MED LOKAL FÅNGARE.
 *
 * ── DE TVÅ SAKER SOM SAKNADE BEVIS ──────────────────────────────────────────
 *
 * B2: PDF-texten påstod "HAR INTE SKICKATS" för varje avi i en org vars bankgiro
 * just nu fattas — även en som gått ut. Granskningen kunde härleda det ur
 * källan men inte fånga det, eftersom villkoret saknade varje beroende av avin.
 * Här återskapas hela vägen: giltigt mål → verkligt utskick → rensat mål → ny
 * rendering av SAMMA rad.
 *
 * F5: påståendet "en redan skickad avi nedgraderas inte" fanns bara som prosa i
 * en rapport. Här är det en mätning: `status` och `sentAt` läses ur databasen
 * före och efter varje rendering och efter ett blockerat omutskick.
 *
 * ── ISOLERING MOT LEVERANTÖRER (F3) ─────────────────────────────────────────
 *
 * Riggen har ingen Resend-klient och ingen `MailService`. Mejlvägen är en LOKAL
 * FÅNGARE som lägger utskicket i en array, och PDF-tjänsten fångar HTML i stället
 * för att starta Chromium. Ingen nyckel, ingen socket, inget jobb i Redis. Det är
 * konstruktionen som ger isoleringen, inte en ogiltig nyckel — en ogiltig nyckel
 * är ingen nätspärr, vilket är hela lärdomen bakom F3.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { AviseringService } from './avisering.service'
import { OcrService } from '../common/ocr/ocr.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from './rent-notice-events.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

const GILTIGT = '5050-1055'

medDb('B2/F5 · betalningsmålet genom avins livscykel', () => {
  let prisma: PrismaClient
  let service: AviseringService
  let orgId: string
  let tenantId: string
  let leaseId: string
  let propertyId: string
  let unitId: string

  /** LOKAL FÅNGARE. Varje utskick hamnar här och ingen annanstans. */
  const mejl: Array<{ to: string; noticeNumber: string; pdfByte: number }> = []
  const renderadHtml: string[] = []
  const koade: Array<{ organizationId: string; noticeId: string }> = []

  const satMal = (bankgiro: string | null) =>
    prisma.organization.update({ where: { id: orgId }, data: { bankgiro } })

  const dbRad = (id: string) =>
    prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { status: true, sentAt: true, sentTo: true, sendError: true, totalAmount: true },
    })

  /** Renderar avins dokument ur den RIKTIGA raden — samma väg som PDF-endpointen. */
  const renderaUrDb = async (id: string): Promise<string> => {
    const notice = await prisma.rentNotice.findFirstOrThrow({
      where: { id, organizationId: orgId },
      include: {
        tenant: true,
        lease: { include: { unit: { include: { property: true } } } },
        lines: true,
        credits: { select: { amount: true } },
      },
    })
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
    return (
      service as unknown as {
        buildNoticePdfHtml: (n: unknown, o: unknown) => Promise<string>
      }
    ).buildNoticePdfHtml(notice, org)
  }

  /** Kör kön som Bull gör: köade jobb → workern. */
  const korKon = async () => {
    while (koade.length > 0) {
      const jobb = koade.shift()!
      await service.processNoticeSendJob(jobb.organizationId, jobb.noticeId)
    }
  }

  let raknare = 0
  const skapaAvi = async () => {
    const nr = ++raknare
    const rad = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `B2-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${3000000 + nr}`,
        month: ((nr - 1) % 12) + 1,
        year: 2040 + Math.floor((nr - 1) / 12),
        amount: 7500,
        totalAmount: 7500,
        dueDate: new Date('2026-07-01T00:00:00Z'),
        status: 'PENDING',
      },
      select: { id: true },
    })
    return rad.id
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = Object.create(AviseringService.prototype) as AviseringService
    Object.assign(service, {
      prisma,
      ocrService: new OcrService(prisma as never),
      mailService: {
        sendRentNotice: async (a: { to: string; noticeNumber: string; pdfBuffer: Buffer }) => {
          mejl.push({ to: a.to, noticeNumber: a.noticeNumber, pdfByte: a.pdfBuffer.length })
          return 'lokalt-mejljobb'
        },
      },
      pdfService: {
        generateFromHtml: async (html: string) => {
          renderadHtml.push(html)
          return Buffer.from('%PDF-1.4 lokal provbuffert')
        },
      },
      storage: {},
      pdfQueue: {
        enqueue: async (j: { organizationId: string; noticeId: string }) => {
          koade.push({ organizationId: j.organizationId, noticeId: j.noticeId })
          return `jobb-${koade.length}`
        },
      },
      accounting: new AccountingService(
        prisma as never,
        new VerifikationsnummerService(prisma as never),
      ),
      consumption: { attachRentNoticeLineCharges: async () => 0 },
      miscCharges: { attachMiscChargesToRentNotice: async () => 0 },
      deposits: { ensureDepositForNotice: async () => ({ created: false }) },
      rentNoticeEvents: new RentNoticeEventsService(prisma as never),
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `b2-${sfx}`,
        email: `b2-${sfx}@example.invalid`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        bankgiro: GILTIGT,
      },
      select: { id: true },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `b2-t-${sfx}@example.invalid`,
        firstName: 'Alva',
        lastName: 'Provperson',
        street: 'Gatan 2',
        city: 'Stad',
        postalCode: '11111',
        personalNumberHash: `hash-${sfx}`,
      },
      select: { id: true },
    })
    tenantId = tenant.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `B2 ${sfx}`,
        propertyDesignation: randomUUID(),
        type: 'RESIDENTIAL',
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id
    const unit = await prisma.unit.create({
      data: {
        propertyId,
        name: 'Provbostad 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 65,
        monthlyRent: 7500,
      },
      select: { id: true },
    })
    unitId = unit.id
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
        unitId,
        contractNumber: randomUUID(),
        monthlyRent: 7500,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    leaseId = lease.id
  }, 40_000)

  afterAll(async () => {
    if (!prisma) return
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('B2.1/B2.4/B2.5/F5 hela kedjan: skicka → rensa mål → hämta igen → återställ', async () => {
    mejl.length = 0
    renderadHtml.length = 0
    await satMal(GILTIGT)
    const id = await skapaAvi()

    // ── 1. VERKLIGT UTSKICK genom tjänstens egen väg ───────────────────────
    const svar = await service.sendNotices(orgId, [id])
    expect(svar).toMatchObject({ queued: 1, failed: 0, blocked: 0, blockedReason: null })
    await korKon()

    // Lokal fångare: ett mejl med PDF-bilaga, till hyresgästen.
    expect(mejl).toHaveLength(1)
    expect(mejl[0]!.pdfByte).toBeGreaterThan(0)
    // Och dokumentet som mejlades var betalbart.
    expect(renderadHtml).toHaveLength(1)
    expect(renderadHtml[0]!).toContain(GILTIGT)
    expect(renderadHtml[0]!).toContain('#41#')
    expect(renderadHtml[0]!).not.toContain('BETALNINGSUPPGIFTER SAKNAS')

    // DB-KVITTOT (F5): avin är skickad.
    const efterUtskick = await dbRad(id)
    expect(efterUtskick.status).toBe('SENT')
    expect(efterUtskick.sentAt).not.toBeNull()
    expect(efterUtskick.sentTo).toBe(mejl[0]!.to)

    // ── 2. MÅLET RENSAS — uttryckligen tillåtet ────────────────────────────
    await satMal(null)
    const fore = await dbRad(id)

    // ── 3. NY RENDERING av SAMMA rad ur databasen ──────────────────────────
    const utan = await renderaUrDb(id)
    expect(utan).not.toContain('HAR INTE SKICKATS')
    expect(utan).toContain('BETALNINGSUPPGIFTER SAKNAS I DEN HÄR KOPIAN')
    expect(utan).toContain('Avin har skickats till hyresgästen')
    // Inget påhittat mål, ingen maskinläsbar giro-rad.
    expect(utan).not.toContain('0000-0000')
    expect(utan).not.toContain('#41#')
    // F5/B2.5: renderingen skriver ingenting.
    expect(await dbRad(id)).toEqual(fore)

    // ── 4. BLOCKERAT OMUTSKICK nedgraderar inte den skickade avin (F5) ─────
    const omSvar = await service.sendNotices(orgId, [id])
    expect(omSvar.queued).toBe(0)
    expect(omSvar.blocked).toBe(1)
    expect(omSvar.blockedReason).toMatch(/[Bb]ankgiro/)
    const efterBlockerat = await dbRad(id)
    expect(efterBlockerat.status).toBe('SENT')
    expect(efterBlockerat.sentAt).toEqual(fore.sentAt)
    expect(efterBlockerat.sendError).toBeNull()
    expect(mejl).toHaveLength(1)

    // ── 5. ÅTERSTÄLLT MÅL → dokumentet är betalbart igen (B2.4) ────────────
    await satMal(GILTIGT)
    const igen = await renderaUrDb(id)
    expect(igen).toContain(GILTIGT)
    expect(igen).toContain('#41#')
    expect(igen).not.toContain('BETALNINGSUPPGIFTER SAKNAS')
    expect(await dbRad(id)).toEqual(fore)
  }, 40_000)

  it('OSKICKAD avi i org utan mål: FAILED, inget mejl, och texten får säga det', async () => {
    mejl.length = 0
    renderadHtml.length = 0
    await satMal(null)
    const id = await skapaAvi()

    const svar = await service.sendNotices(orgId, [id])
    expect(svar).toMatchObject({ queued: 0, blocked: 1 })
    await korKon()
    expect(mejl).toHaveLength(0)

    const rad = await dbRad(id)
    expect(rad.status).toBe('FAILED')
    expect(rad.sentAt).toBeNull()
    expect(rad.sendError).toMatch(/[Bb]ankgiro/)

    const html = await renderaUrDb(id)
    expect(html).toContain('HAR INTE SKICKATS')
    expect(html).not.toContain('0000-0000')
  }, 40_000)

  it('ISOLERING: riggen har ingen leverantörsklient — utskicket kan bara nå fångaren', () => {
    // Konstruktionen ÄR beviset: tjänstens `mailService` är den lokala fångaren,
    // och det finns ingen Resend-klient i objektet. Ett försök att nå ut hade
    // krävt en annan `mailService` än den riggen injicerar.
    const injicerad = (service as unknown as Record<string, unknown>)['mailService']
    expect(typeof injicerad).toBe('object')
    expect(Object.keys(injicerad as object)).toEqual(['sendRentNotice'])
    expect(process.env.RESEND_API_KEY ?? '').toBe('')
  })
})
