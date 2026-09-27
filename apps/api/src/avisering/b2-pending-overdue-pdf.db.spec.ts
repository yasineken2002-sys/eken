/**
 * B2 (sluträttning) — `OVERDUE` ÄR INGET BEVIS FÖR ATT AVIN SKICKATS.
 *
 * ── MOTEXEMPLET, KÖRT OCH INTE BARA HÄRLETT ─────────────────────────────────
 *
 * T1:s slutgranskning av `22319429` källhärledde kedjan men körde den inte. Den
 * körs här, i sin helhet, mot riktig Postgres och den riktiga templaten:
 *
 *   1. Organisationen saknar giltigt bankgiro, så K2:s grind hindrar utskicket
 *      och UI:t låser sändknapparna. Avin förblir `PENDING` med `sentAt = null`.
 *   2. Förfallodagen passerar.
 *   3. Hyresvärden öppnar avilistan → `findAll` → `checkAndMarkOverdue`, som
 *      väljer `status: { in: [PENDING, SENT] }` och skriver `OVERDUE`.
 *      **`PENDING` ingår** — en aldrig skickad avi blir alltså `OVERDUE`.
 *   4. Hon laddar ner PDF:en för att se vad som är fel.
 *
 * På `22319429` sa dokumentet då "Avin har skickats till hyresgästen". Det var
 * falskt: `sentAt` sätts på exakt ett ställe i hela `apps/api/src`, i samma
 * skrivning som `status: SENT` inne i `processNoticeSendJob`.
 *
 * ── DE TVÅ `OVERDUE`-FALLEN MÅSTE GÅ ATT SKILJA ÅT ──────────────────────────
 *
 * Provet räcker inte om det bara visar det nya fallet. En avi som FAKTISKT
 * skickats och därefter förfallit har `sentAt` satt, och för den ska texten
 * fortsätta säga att den skickats — även när målet rensas efteråt. Båda
 * riktningarna prövas, annars är rättningen oskiljbar från "säg aldrig att något
 * skickats".
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
const DYGN = 24 * 60 * 60 * 1000

medDb('B2 · utskicksbeviset i avins dokument', () => {
  let prisma: PrismaClient
  let service: AviseringService
  let orgId: string
  let tenantId: string
  let leaseId: string
  /** LOKAL FÅNGARE — inget utskick kan nå längre än hit. */
  const mejl: Array<{ to: string; pdfByte: number }> = []
  const koade: Array<{ organizationId: string; noticeId: string }> = []
  let raknare = 0

  const satMal = (bankgiro: string | null) =>
    prisma.organization.update({ where: { id: orgId }, data: { bankgiro } })

  /** Leveransfälten — det som en rendering aldrig får röra. */
  const leveransfalt = (id: string) =>
    prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { status: true, sentAt: true, sentTo: true, sendError: true },
    })

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
      service as unknown as { buildNoticePdfHtml: (n: unknown, o: unknown) => Promise<string> }
    ).buildNoticePdfHtml(notice, org)
  }

  /** Renderar OCH kräver att leveransfälten är oförändrade (B2:s DB-bindning). */
  const renderaUtanBieffekt = async (id: string): Promise<string> => {
    const fore = await leveransfalt(id)
    const html = await renderaUrDb(id)
    expect(await leveransfalt(id)).toEqual(fore)
    return html
  }

  const skapaAvi = async (over: Record<string, unknown> = {}) => {
    const nr = ++raknare
    const rad = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `B2S-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${4000000 + nr}`,
        month: ((nr - 1) % 12) + 1,
        year: 2050 + Math.floor((nr - 1) / 12),
        amount: 7500,
        totalAmount: 7500,
        // FÖRFALLEN, så den riktiga listvägen kan flippa den.
        dueDate: new Date(Date.now() - 3 * DYGN),
        status: 'PENDING',
        ...over,
      },
      select: { id: true },
    })
    return rad.id
  }

  const korKon = async () => {
    while (koade.length > 0) {
      const j = koade.shift()!
      await service.processNoticeSendJob(j.organizationId, j.noticeId)
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = Object.create(AviseringService.prototype) as AviseringService
    Object.assign(service, {
      prisma,
      ocrService: new OcrService(prisma as never),
      mailService: {
        sendRentNotice: async (a: { to: string; pdfBuffer: Buffer }) => {
          mejl.push({ to: a.to, pdfByte: a.pdfBuffer.length })
          return 'lokalt-mejljobb'
        },
      },
      pdfService: { generateFromHtml: async () => Buffer.from('%PDF-1.4 lokal') },
      storage: {},
      pdfQueue: {
        enqueue: async (j: { organizationId: string; noticeId: string }) => {
          koade.push({ organizationId: j.organizationId, noticeId: j.noticeId })
          return 'jobb'
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
        name: `b2s-${sfx}`,
        email: `b2s-${sfx}@example.invalid`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        bankgiro: null,
      },
      select: { id: true },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `b2s-t-${sfx}@example.invalid`,
        firstName: 'Alva',
        lastName: 'Provperson',
        street: 'Gatan 2',
        city: 'Stad',
        postalCode: '11111',
        personalNumberHash: `h-${sfx}`,
      },
      select: { id: true },
    })
    tenantId = tenant.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `B2S ${sfx}`,
        propertyDesignation: randomUUID(),
        type: 'RESIDENTIAL',
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: 'Provbostad 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 65,
        monthlyRent: 7500,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
        unitId: unit.id,
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

  // ══ B2-b: MOTEXEMPLET. Den riktiga listvägen, inget handskrivet statusfält. ══
  it('B2-b ALDRIG SKICKAD avi som den RIKTIGA listvägen gör OVERDUE: dokumentet påstår INTE leverans', async () => {
    await satMal(null)
    const id = await skapaAvi()
    expect((await leveransfalt(id)).status).toBe('PENDING')

    // DEN RIKTIGA VÄGEN: hyresvärden öppnar avilistan. `findAll` anropar
    // `checkAndMarkOverdue`, som flippar PENDING → OVERDUE. Ingen genväg.
    await service.findAll(orgId)

    const efterLista = await leveransfalt(id)
    expect(efterLista.status).toBe('OVERDUE')
    // AVGÖRANDE: ingen leverans har skett.
    expect(efterLista.sentAt).toBeNull()
    expect(efterLista.sentTo).toBeNull()
    expect(mejl).toHaveLength(0)
    expect(await prisma.rentNoticeEvent.count({ where: { rentNoticeId: id, type: 'SENT' } })).toBe(
      0,
    )

    const html = await renderaUtanBieffekt(id)
    // Det falska påståendet får inte finnas.
    expect(html).not.toContain('Avin har skickats')
    // Och det sanna ska finnas.
    expect(html).toContain('HAR INTE SKICKATS')
    expect(html).not.toContain('0000-0000')
    expect(html).not.toContain('#41#')
  }, 40_000)

  // ══ B2-c: DEN ANDRA RIKTNINGEN. Verkligt skickad avi som förfaller. ══
  it('B2-c FAKTISKT SKICKAD avi som förfaller: dokumentet påstår INTE att den aldrig skickats', async () => {
    mejl.length = 0
    await satMal(GILTIGT)
    const id = await skapaAvi()

    // Verkligt utskick genom tjänstens egen väg, till den lokala fångaren.
    const svar = await service.sendNotices(orgId, [id])
    expect(svar).toMatchObject({ queued: 1, blocked: 0 })
    await korKon()
    expect(mejl).toHaveLength(1)
    const skickad = await leveransfalt(id)
    expect(skickad.status).toBe('SENT')
    expect(skickad.sentAt).not.toBeNull()

    // Förfaller genom den riktiga listvägen.
    await service.findAll(orgId)
    const forfallen = await leveransfalt(id)
    expect(forfallen.status).toBe('OVERDUE')
    expect(forfallen.sentAt).toEqual(skickad.sentAt)

    // Målet rensas EFTERÅT — det är fallet granskningen ursprungligen fann.
    await satMal(null)
    const html = await renderaUtanBieffekt(id)
    expect(html).toContain('Avin har skickats')
    expect(html).not.toContain('HAR INTE SKICKATS')
    expect(html).not.toContain('0000-0000')
  }, 40_000)

  // ══ De två OVERDUE-fallen sida vid sida, i samma körning. ══
  it('de två OVERDUE-fallen går att SKILJA ÅT — annars vore rättningen en alltid-nekare', async () => {
    mejl.length = 0
    await satMal(GILTIGT)
    const skickadId = await skapaAvi()
    await service.sendNotices(orgId, [skickadId])
    await korKon()
    await satMal(null)
    const oskickadId = await skapaAvi()
    await service.findAll(orgId)

    const a = await leveransfalt(skickadId)
    const b = await leveransfalt(oskickadId)
    expect(a.status).toBe('OVERDUE')
    expect(b.status).toBe('OVERDUE')
    expect(a.sentAt).not.toBeNull()
    expect(b.sentAt).toBeNull()

    const htmlSkickad = await renderaUtanBieffekt(skickadId)
    const htmlOskickad = await renderaUtanBieffekt(oskickadId)
    // SAMMA status, MOTSATT besked. Det är hela poängen.
    expect(htmlSkickad).toContain('Avin har skickats')
    expect(htmlOskickad).not.toContain('Avin har skickats')
    expect(htmlOskickad).toContain('HAR INTE SKICKATS')
  }, 40_000)

  // ══ Bevarade fall ══
  it.each([
    ['B2-a PENDING utan utskick', { status: 'PENDING' }, false],
    ['B2-d FAILED utan utskick', { status: 'FAILED', sendError: 'Bankgiro saknas' }, false],
    ['B2-e PAID efter utskick', { status: 'PAID', sentAt: new Date(Date.now() - DYGN) }, true],
    [
      'B2-e CANCELLED efter utskick',
      { status: 'CANCELLED', sentAt: new Date(Date.now() - DYGN) },
      true,
    ],
  ])(
    '%s → påstår leverans: %s',
    async (_namn, over, skickad) => {
      await satMal(null)
      const id = await skapaAvi(over as Record<string, unknown>)
      const html = await renderaUtanBieffekt(id)
      expect(html.includes('Avin har skickats')).toBe(skickad)
      expect(html.includes('HAR INTE SKICKATS')).toBe(!skickad)
      expect(html).not.toContain('0000-0000')
    },
    40_000,
  )

  it('B2-f giltigt mål: dokumentet är betalbart oavsett status', async () => {
    await satMal(GILTIGT)
    for (const over of [
      { status: 'PENDING' },
      { status: 'OVERDUE', sentAt: null },
      { status: 'OVERDUE', sentAt: new Date(Date.now() - DYGN) },
    ]) {
      const id = await skapaAvi(over as Record<string, unknown>)
      const html = await renderaUtanBieffekt(id)
      expect(html).toContain('TILL BANKGIRO')
      expect(html).toContain(GILTIGT)
      expect(html).toContain('#41#')
      expect(html).not.toContain('BETALNINGSUPPGIFTER SAKNAS')
      expect(html).not.toContain('0000-0000')
    }
  }, 40_000)
})
