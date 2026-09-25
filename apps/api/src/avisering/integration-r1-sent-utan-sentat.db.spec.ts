/**
 * R-1 — `SENT` UTAN `sentAt`: STATUS ÄR INGET UTSKICKSBEVIS.
 *
 * ── VÄGEN, KÖRD OCH INTE BARA HÄRLEDD ───────────────────────────────────────
 *
 * T1:s återgranskning av #919 fann att `status = 'SENT'` skrivs på ett ställe
 * till, UTAN `sentAt`: bankavstämningens avmatchning återöppnar en avi med
 * kvarvarande restskuld (`reconciliation.service.ts`, `reopen`-grenen). Kedjan
 * kördes inte av granskaren. Den körs här, hela vägen:
 *
 *   1. Avi skapas `PENDING` med `sentAt = null` — den har ALDRIG skickats.
 *   2. Två bankbetalningar med matchande OCR importeras och automatchas. Båda
 *      accepteras även för `PENDING`, så avin blir `PAID` med `sentAt` kvar null.
 *   3. Operatören avmatchar EN av dem. Restskuld kvarstår → `reopen` sätter
 *      `status: 'SENT'` och rör inte `sentAt`.
 *   4. Dokumentet renderas utan giltigt betalningsmål.
 *
 * Före härdningen sa texten "Avin har skickats till hyresgästen" om en avi som
 * aldrig gått ut. `harSkickats` vilar nu enbart på `sentAt`.
 *
 * ── AVGRÄNSNING ─────────────────────────────────────────────────────────────
 *
 * Roten ligger i basen och rättas INTE här: ingen ändring i bokföring eller i
 * avstämningens statusmodell. `SENT` får förbli ett internt tillstånd. Det som
 * mäts är att DOKUMENTET slutat läsa leverans ur det — och att en verkligt
 * skickad avi fortfarande får rätt besked.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient, RentNoticeType } from '@prisma/client'

import { AviseringService } from './avisering.service'
import { OcrService } from '../common/ocr/ocr.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { färskhetsdubbel } from '../payment-freshness/payment-freshness.test-double'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

const GILTIGT = '5050-1055'
const BELOPP = 9000

medDb('R-1 · dokumentets utskicksbevis mot avmatchningens återöppning', () => {
  let prisma: PrismaClient
  let avisering: AviseringService
  let recon: ReconciliationService
  let orgId: string
  let tenantId: string
  let leaseId: string
  let userId: string
  const mejl: string[] = []
  const koade: Array<{ organizationId: string; noticeId: string }> = []
  let raknare = 0

  const satMal = (bankgiro: string | null) =>
    prisma.organization.update({ where: { id: orgId }, data: { bankgiro } })

  /** Leveransfälten + händelseantalet — det renderingen aldrig får röra. */
  const leverans = async (id: string) => ({
    rad: await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { status: true, sentAt: true, sentTo: true, sendError: true },
    }),
    handelser: await prisma.rentNoticeEvent.count({ where: { rentNoticeId: id } }),
  })

  const renderaUtanBieffekt = async (id: string): Promise<string> => {
    const fore = await leverans(id)
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
    const html = await (
      avisering as unknown as { buildNoticePdfHtml: (n: unknown, o: unknown) => Promise<string> }
    ).buildNoticePdfHtml(notice, org)
    // Renderingen skriver ingen leveranshistorik.
    expect(await leverans(id)).toEqual(fore)
    return html
  }

  const avi = async (opts: { ocr: string; status?: 'PENDING'; belopp?: number }) => {
    const nr = ++raknare
    const belopp = opts.belopp ?? BELOPP
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `R1-${randomUUID().slice(0, 8)}`,
        ocrNumber: opts.ocr,
        month: ((nr - 1) % 12) + 1,
        year: 2070 + Math.floor((nr - 1) / 12),
        amount: belopp,
        totalAmount: belopp,
        dueDate: new Date(Date.UTC(2026, 6, 1)),
        // ALDRIG SKICKAD: `PENDING` och `sentAt = null`.
        status: opts.status ?? 'PENDING',
        collectionStage: 'NONE',
        type: RentNoticeType.RENT,
      },
      select: { id: true, noticeNumber: true, year: true, month: true },
    })
    const acc = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    // Fordran bokförs som produkten gör det — annars finns inget 1510 att
    // avmatchningens reversering kan arbeta mot.
    await acc.createJournalEntryForRentNotice(
      {
        id: n.id,
        noticeNumber: n.noticeNumber,
        leaseId,
        type: RentNoticeType.RENT,
        amount: belopp,
        vatAmount: 0,
        totalAmount: belopp,
        year: n.year,
        month: n.month,
      },
      orgId,
      null,
    )
    return n.id
  }

  const bt = (ocr: string, belopp: number) =>
    prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        date: new Date(Date.UTC(2026, 6, 2)),
        amount: belopp,
        rawOcr: ocr,
        description: 'r1-rigg',
        status: 'UNMATCHED',
      },
      select: { id: true },
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    const events = new RentNoticeEventsService(prisma as never)
    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )

    avisering = Object.create(AviseringService.prototype) as AviseringService
    Object.assign(avisering, {
      prisma,
      ocrService: new OcrService(prisma as never),
      // LOKAL FÅNGARE — ingen leverantör, ingen kö.
      mailService: {
        sendRentNotice: async (a: { to: string }) => {
          mejl.push(a.to)
          return 'lokalt'
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
      accounting,
      consumption: { attachRentNoticeLineCharges: async () => 0 },
      miscCharges: { attachMiscChargesToRentNotice: async () => 0 },
      deposits: { ensureDepositForNotice: async () => ({ created: false }) },
      rentNoticeEvents: events,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    })

    recon = Object.create(ReconciliationService.prototype) as ReconciliationService
    Object.assign(recon, {
      prisma,
      accounting,
      rentNoticeEvents: events,
      invoices: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('invoices orört')
          },
        },
      ),
      events: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('events orört')
          },
        },
      ),
      freshness: färskhetsdubbel(),
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      betalningsSkugga: { enqueue: async () => 'jobb' },
      betalningsFacit: {
        skrivFacitMatchad: async () => undefined,
        skrivFacitIngen: async () => undefined,
        nollstallFacit: async () => undefined,
      },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `r1-${sfx}`,
        email: `r1-${sfx}@example.invalid`,
        street: 'Gatan 1',
        city: 'Stockholm',
        postalCode: '11111',
        bankgiro: null,
      },
      select: { id: true },
    })
    orgId = org.id
    await prisma.account.createMany({
      data: [
        { organizationId: orgId, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: orgId, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: orgId, number: 3911, name: 'Hyresintäkter bostad', type: 'REVENUE' },
      ],
    })
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `r1-u-${sfx}@example.invalid`,
        passwordHash: 'x',
        firstName: 'R1',
        lastName: 'Rigg',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `r1-t-${sfx}@example.invalid`,
        firstName: 'Alva',
        lastName: 'Provperson',
        street: 'Gatan 2',
        city: 'Stockholm',
        postalCode: '11111',
        personalNumberHash: `h-${sfx}`,
      },
      select: { id: true },
    })
    tenantId = tenant.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `R1 ${sfx}`,
        propertyDesignation: randomUUID(),
        type: 'RESIDENTIAL',
        street: 'Gatan 1',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: 'Lgh 1',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: BELOPP,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
        unitId: unit.id,
        contractNumber: randomUUID(),
        monthlyRent: BELOPP,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    leaseId = lease.id
  }, 60_000)

  afterAll(async () => {
    if (!prisma) return
    await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  // ══ R1-1: DEN VERKLIGA VÄGEN ═══════════════════════════════════════════════
  it('R1-1 aldrig skickad avi → matcha två betalningar → avmatcha en → SENT utan sentAt', async () => {
    await satMal(null)
    mejl.length = 0
    const ocr = '7700001'
    const id = await avi({ ocr })
    const fore = await leverans(id)
    expect(fore.rad.status).toBe('PENDING')
    expect(fore.rad.sentAt).toBeNull()

    const tx1 = await bt(ocr, BELOPP / 2)
    const tx2 = await bt(ocr, BELOPP / 2)
    const match = await recon.autoMatchAll(orgId)
    expect(match.matched).toBeGreaterThanOrEqual(1)

    const efterMatch = await leverans(id)
    // Matchningen accepterar PENDING, så avin blir betald utan att ha skickats.
    expect(efterMatch.rad.sentAt).toBeNull()

    // AVMATCHNINGEN — den verkliga operatörshandlingen.
    await recon.unmatchTransaction(tx1.id, orgId, userId, 'r1-riggens avmatchning')
    const efterUnmatch = await leverans(id)

    // Det HÄR är R-1:s förutsättning. Uppstår den inte har vägen ändrats, och
    // då ska provet säga det i stället för att tiga.
    expect(efterUnmatch.rad.status).toBe('SENT')
    expect(efterUnmatch.rad.sentAt).toBeNull()
    expect(mejl).toHaveLength(0)

    // OCH DOKUMENTET: ingen påstådd leverans.
    const html = await renderaUtanBieffekt(id)
    expect(html).not.toContain('Avin har skickats')
    expect(html).toContain('HAR INTE SKICKATS')
    expect(html).not.toContain('0000-0000')
    expect(html).not.toContain('#41#')
    void tx2
  }, 120_000)

  // ══ R1-2: POSITIVA MOTSVARIGHETEN ══════════════════════════════════════════
  it('R1-2 verkligt skickad avi: kvarvarande sentAt ger rätt besked även efter rensat mål', async () => {
    await satMal(GILTIGT)
    mejl.length = 0
    const id = await avi({ ocr: '7700002' })
    const svar = await avisering.sendNotices(orgId, [id])
    expect(svar).toMatchObject({ queued: 1, blocked: 0 })
    while (koade.length > 0) {
      const j = koade.shift()!
      await avisering.processNoticeSendJob(j.organizationId, j.noticeId)
    }
    expect(mejl).toHaveLength(1)
    const skickad = await leverans(id)
    expect(skickad.rad.status).toBe('SENT')
    expect(skickad.rad.sentAt).not.toBeNull()

    await satMal(null)
    const html = await renderaUtanBieffekt(id)
    expect(html).toContain('Avin har skickats')
    expect(html).not.toContain('HAR INTE SKICKATS')
  }, 120_000)

  // ══ Invarianten, direkt: SENT utan sentAt är aldrig bevis ══════════════════
  it('INVARIANT: samma status, motsatt besked — sentAt är det som skiljer', async () => {
    await satMal(null)
    const utan = await avi({ ocr: '7700003' })
    await prisma.rentNotice.update({ where: { id: utan }, data: { status: 'SENT' } })
    const med = await avi({ ocr: '7700004' })
    await prisma.rentNotice.update({
      where: { id: med },
      data: { status: 'SENT', sentAt: new Date('2026-06-01T09:00:00Z') },
    })

    const a = await leverans(utan)
    const b = await leverans(med)
    expect(a.rad.status).toBe('SENT')
    expect(b.rad.status).toBe('SENT')
    expect(a.rad.sentAt).toBeNull()
    expect(b.rad.sentAt).not.toBeNull()

    expect(await renderaUtanBieffekt(utan)).not.toContain('Avin har skickats')
    expect(await renderaUtanBieffekt(med)).toContain('Avin har skickats')
  }, 60_000)

  // ══ Ingen ändring i bokföring eller avstämningsstatus ══════════════════════
  it('R-1 rör INTE bokföringen: verifikat och bankradens status är avstämningens egna', async () => {
    await satMal(null)
    const ocr = '7700005'
    const id = await avi({ ocr })
    const tx1 = await bt(ocr, BELOPP / 2)
    await bt(ocr, BELOPP / 2)
    await recon.autoMatchAll(orgId)
    const verifikatEfterMatch = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'PAYMENT' },
    })
    await recon.unmatchTransaction(tx1.id, orgId, userId, 'r1-bokforingskontroll')

    // Avmatchningen reverserar sitt verifikat — det är avstämningens beteende och
    // det är OFÖRÄNDRAT av R-1. Renderingen nedan ändrar ingenting alls.
    const verifikatEfterUnmatch = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'PAYMENT' },
    })
    const bankrad = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: tx1.id },
      select: { status: true },
    })
    expect(bankrad.status).toBe('UNMATCHED')

    await renderaUtanBieffekt(id)
    expect(
      await prisma.journalEntry.count({ where: { organizationId: orgId, source: 'PAYMENT' } }),
    ).toBe(verifikatEfterUnmatch)
    expect(verifikatEfterMatch).toBeGreaterThan(0)
    expect(
      await prisma.bankTransaction.findUniqueOrThrow({
        where: { id: tx1.id },
        select: { status: true },
      }),
    ).toEqual(bankrad)
  }, 120_000)
})
