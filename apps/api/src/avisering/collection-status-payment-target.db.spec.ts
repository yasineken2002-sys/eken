/**
 * F4 — KRAVSTATUSEN SKA FÖRKLARA SAMMA HINDER SOM STOPPAR CRON/WORKERN.
 *
 * ── DEFEKTEN, OCH VAD DEN INTE VAR ──────────────────────────────────────────
 *
 * Granskningen av #919 (T1) fann att `collectionStatus` räknar `state` ur
 * `remindersEnabled`, färskhet, `daysOverdue` och `checkInkassoReadiness` — utan
 * betalningsmålet — medan cron-loopen avstår tyst när målet fattas.
 *
 * Mätt före rättningen, och det styr designen: `READY` kunde inte överlova.
 * `READY` kräver tom `missing`, och en påminnelse som stoppats av målet saknar
 * `reminderPdfStorageKey`, vilket fyller `missing`. Defekten var alltså att
 * SKÄLET var osynligt (stage NONE → `NOT_APPLICABLE`) eller fel (stage REMINDED
 * → symtom som hyresvärden inte kan åtgärda), inte att statusen lovade för
 * mycket. Rättningen ger orsaken; den flyttar inte `READY`.
 *
 * ── VAD PROVET MÄTER ────────────────────────────────────────────────────────
 *
 * Riktig Postgres. Samma `checkPaymentTarget` som grindarna, mätt genom att
 * cron-loopen och statusen får svara på SAMMA tre måltillstånd i samma körning,
 * och genom att det giltiga fallet faktiskt eskalerar (positiv kontroll).
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { RentReminderService } from './rent-reminder.service'
import { RentDebtService } from './rent-debt.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentInterestService } from './rent-interest.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

/**
 * KLOCKAN ÄR DEN RIKTIGA, OCH DET ÄR ETT VAL — inte slarv.
 *
 * `collectionStatus` tar `now` som argument och honorerar det. `escalateOverdue
 * RentNotices` gör det INTE: den är en cron-metod utan klockparameter och läser
 * `new Date()`. Provet mäter att de två är överens, så de måste se samma tid.
 *
 * En fast `NU` hade gett ett prov där statusen svarade om 2026-09-02 medan
 * cronen svarade om i dag. Uppmätt när jag försökte: `paymentDataThrough` blev
 * tre veckor gammal räknat från den riktiga klockan, färskhetsgrinden pausade
 * hela körningen, och den POSITIVA kontrollen gav `reminded: 0` — alltså grönt
 * för spärren och tyst för att den inte kunde skilja sig från en alltid-spärr.
 *
 * Ankaret tas EN gång, så båda halvorna av varje prov ser samma tidpunkt.
 */
const NU = new Date()
const DYGN = 24 * 60 * 60 * 1000
const GILTIGT = '5050-1055'

/** De tre måltillstånden uppdraget kräver. */
const MAL: Array<[string, string | null, boolean]> = [
  ['SAKNAT', null, false],
  ['OGILTIGT (0000-0000)', '0000-0000', false],
  ['GILTIGT', GILTIGT, true],
]

medDb('F4 · collectionStatus och betalningsmålet', () => {
  let prisma: PrismaClient
  let service: RentReminderService
  let orgId: string
  let tenantId: string
  let leaseId: string
  let propertyId: string
  const skickadePaminnelser: string[] = []
  let raknare = 0

  const satMal = (bankgiro: string | null) =>
    prisma.organization.update({ where: { id: orgId }, data: { bankgiro } })

  const avi = async (opts: {
    dagarSedanForfall: number
    stage: 'NONE' | 'REMINDED'
    /** Sätt för att simulera att påminnelsens utskick redan gjorts. */
    paminnelsePdf?: boolean
  }) => {
    const nr = ++raknare
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `F4-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${2000000 + nr}`,
        month: ((nr - 1) % 12) + 1,
        year: 2030 + Math.floor((nr - 1) / 12),
        amount: 9000,
        totalAmount: 9000,
        dueDate: new Date(NU.getTime() - opts.dagarSedanForfall * DYGN),
        status: 'OVERDUE',
        collectionStage: opts.stage,
        sentAt: new Date(NU.getTime() - 40 * DYGN),
        ...(opts.paminnelsePdf ? { reminderPdfStorageKey: 'r2/paminnelse.pdf' } : {}),
      },
      select: { id: true },
    })
    return notice.id
  }

  const status = (id: string) => service.collectionStatus(id, orgId, NU)

  beforeAll(async () => {
    prisma = new PrismaClient()
    const events = new RentNoticeEventsService(prisma as never)
    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    const freshness = new PaymentFreshnessService(
      prisma as never,
      { send: async () => undefined, sendCustomEmail: async () => undefined } as never,
    )
    service = Object.create(RentReminderService.prototype) as RentReminderService
    Object.assign(service, {
      prisma,
      accounting,
      rentNoticeEvents: events,
      rentInterest: new RentInterestService(prisma as never, accounting, events, freshness),
      // LOKAL FÅNGARE: köandet registreras här och når aldrig Redis eller en
      // leverantör. "Ingen påminnelse skickades" mäts på den här listan.
      pdfQueue: {
        enqueue: async (job: { noticeId: string }) => {
          skickadePaminnelser.push(job.noticeId)
          return 'lokalt-jobb'
        },
      },
      mailService: {
        sendRentNoticeReminder: async () => {
          throw new Error('F4: mejlvägen anropades oväntat')
        },
      },
      rentDebt: new RentDebtService(prisma as never),
      freshness,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      cronErrors: {
        report: async (fel: unknown) => {
          throw fel
        },
      },
      notifications: { create: jest.fn() },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `f4-${sfx}`,
        email: `f4-${sfx}@example.invalid`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        orgNumber: `556000-${(1000 + raknare).toString().slice(-4)}`,
        remindersEnabled: true,
        rentReminderDay: 5,
        rentInkassoDaysAfterReminder: 14,
        reminderFeeSek: 60,
        bankgiro: GILTIGT,
        // Färsk betalningsdata, så `PAUSED_STALE` inte maskerar det vi mäter.
        paymentDataThrough: new Date(NU.getTime() - DYGN),
      },
      select: { id: true },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `f4-t-${sfx}@example.invalid`,
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
        name: `F4 ${sfx}`,
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
        name: 'Lgh 1',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 9000,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
        unitId: unit.id,
        contractNumber: randomUUID(),
        monthlyRent: 9000,
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
    // Städa i FK-riktning.
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

  // ── F4.1 + F4.2: SAMMA REGEL, SAMMA TRE MÅLTILLSTÅND ──────────────────────
  it.each(MAL)(
    'F4.1/F4.2 stage NONE, %s mål: status och cron är överens',
    async (_namn, bankgiro, malOk) => {
      await satMal(bankgiro)
      skickadePaminnelser.length = 0
      // 10 dygn förfallen mot rentReminderDay 5 → cronen prövar avin i dag.
      const id = await avi({ dagarSedanForfall: 10, stage: 'NONE' })

      const s = await status(id)
      expect(s.paymentTarget.ok).toBe(malOk)
      expect(s.paymentTarget.blockerarNastaSteg).toBe(!malOk)
      expect(s.state).toBe(malOk ? 'NOT_APPLICABLE' : 'BLOCKED_PAYMENT_TARGET')
      if (!malOk) {
        // Ett skäl en människa kan agera på — och VÄGEN dit.
        expect(s.paymentTarget.reason).toMatch(/[Bb]ankgiro/)
        expect(s.paymentTarget.reason).toMatch(/Inställningar/)
        expect(s.paymentTarget.code).toBe(
          bankgiro === null ? 'PAYMENT_TARGET_MISSING' : 'PAYMENT_TARGET_INVALID',
        )
      } else {
        expect(s.paymentTarget.reason).toBeNull()
        expect(s.paymentTarget.code).toBeNull()
      }

      // CRONEN på samma avi, samma måltillstånd. F4.3 respektive F4.4.
      const sammanstallning = await service.escalateOverdueRentNotices()
      const efter = await prisma.rentNotice.findUniqueOrThrow({
        where: { id },
        select: { collectionStage: true, reminderFeeAmount: true },
      })
      const verifikat = await prisma.journalEntry.count({
        where: { organizationId: orgId, sourceId: `reminder-fee:${id}` },
      })
      if (malOk) {
        // POSITIV KONTROLL: spärren är inte en alltid-spärr.
        expect(sammanstallning.reminded).toBeGreaterThanOrEqual(1)
        expect(efter.collectionStage).toBe('REMINDED')
        expect(skickadePaminnelser).toContain(id)
      } else {
        expect(efter.collectionStage).toBe('NONE')
        expect(Number(efter.reminderFeeAmount)).toBe(0)
        expect(verifikat).toBe(0)
        expect(skickadePaminnelser).not.toContain(id)
      }
    },
    40_000,
  )

  // ── F4.5: PRIORITETSORDNINGEN ─────────────────────────────────────────────
  it('F4.5 REMINDERS_OFF går före betalningsmålet', async () => {
    await satMal(null)
    await prisma.organization.update({ where: { id: orgId }, data: { remindersEnabled: false } })
    const id = await avi({ dagarSedanForfall: 30, stage: 'REMINDED' })
    expect((await status(id)).state).toBe('REMINDERS_OFF')
    await prisma.organization.update({ where: { id: orgId }, data: { remindersEnabled: true } })
  })

  it('F4.5 PAUSED_STALE går före betalningsmålet', async () => {
    await satMal(null)
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: new Date(NU.getTime() - 60 * DYGN) },
    })
    const id = await avi({ dagarSedanForfall: 30, stage: 'REMINDED' })
    expect((await status(id)).state).toBe('PAUSED_STALE')
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: new Date(NU.getTime() - DYGN) },
    })
  })

  // ── Målet stoppar INTE inkasso-steget, och statusen påstår inte det ────────
  it('REMINDED med utskickad påminnelse: målet stoppar ingenting, och det syns', async () => {
    await satMal(null)
    const id = await avi({ dagarSedanForfall: 30, stage: 'REMINDED', paminnelsePdf: true })
    const s = await status(id)
    // Mätt i källan: `escalateNoticeToInkassoReady` läser inte betalningsmålet.
    expect(s.paymentTarget.ok).toBe(false)
    expect(s.paymentTarget.blockerarNastaSteg).toBe(false)
    expect(s.state).not.toBe('BLOCKED_PAYMENT_TARGET')
    // Bristen syns ändå, så hyresvärden kan rätta den innan den blir ett stopp.
    expect(s.paymentTarget.reason).toMatch(/[Bb]ankgiro/)
  })

  it('REMINDED utan utskickad påminnelse: målet stoppar utskicket', async () => {
    await satMal(null)
    const id = await avi({ dagarSedanForfall: 30, stage: 'REMINDED' })
    const s = await status(id)
    expect(s.paymentTarget.blockerarNastaSteg).toBe(true)
    expect(s.state).toBe('BLOCKED_PAYMENT_TARGET')
  })

  // ── F4-a: PÅMINNELSER AV → målet blockerar ingenting ─────────────────────
  //
  // Cron-loopens urval filtrerar på `organization: { remindersEnabled: true }`.
  // Utan den termen i `arPaminnelsekandidat` fick en avi i stage NONE i en org
  // som stängt av påminnelser skälet `BLOCKED_PAYMENT_TARGET` — ett hinder som
  // inte finns, eftersom cronen aldrig plockar avin.
  //
  // BÅDA riktningarna mäts i samma beskrivning: AV ska ge NOT_APPLICABLE, PÅ
  // ska ge BLOCKED_PAYMENT_TARGET. Bara det första hade varit oskiljbart från
  // en gren som alltid säger NOT_APPLICABLE.
  describe('F4-a · remindersEnabled hör till kandidaturvalet', () => {
    const satPaminnelser = (pa: boolean) =>
      prisma.organization.update({ where: { id: orgId }, data: { remindersEnabled: pa } })

    afterEach(async () => {
      await satPaminnelser(true)
    })

    it('F4a-1 stage NONE, påminnelser AV, mål saknas: NOT_APPLICABLE och inget hinder', async () => {
      await satMal(null)
      await satPaminnelser(false)
      const id = await avi({ dagarSedanForfall: 10, stage: 'NONE' })
      const s = await status(id)
      // Formatdiagnosen står kvar — målet ÄR ogiltigt.
      expect(s.paymentTarget.ok).toBe(false)
      expect(s.paymentTarget.reason).toMatch(/[Bb]ankgiro/)
      // Men det blockerar inget steg, och statusbeskedet säger inte att det gör det.
      expect(s.paymentTarget.blockerarNastaSteg).toBe(false)
      expect(s.state).toBe('NOT_APPLICABLE')
    })

    it('F4a-2 POSITIV MOTSVARIGHET: samma avi med påminnelser PÅ blockeras', async () => {
      await satMal(null)
      await satPaminnelser(true)
      const id = await avi({ dagarSedanForfall: 10, stage: 'NONE' })
      const s = await status(id)
      expect(s.paymentTarget.ok).toBe(false)
      expect(s.paymentTarget.blockerarNastaSteg).toBe(true)
      expect(s.state).toBe('BLOCKED_PAYMENT_TARGET')
    })

    it('F4a-3 stage REMINDED med påminnelser AV: REMINDERS_OFF behåller prioriteten', async () => {
      await satMal(null)
      await satPaminnelser(false)
      const id = await avi({ dagarSedanForfall: 30, stage: 'REMINDED' })
      expect((await status(id)).state).toBe('REMINDERS_OFF')
    })

    it('F4a-4 stage REMINDED med påminnelser PÅ och utskick kvar: blockeras', async () => {
      await satMal(null)
      await satPaminnelser(true)
      const id = await avi({ dagarSedanForfall: 30, stage: 'REMINDED' })
      const s = await status(id)
      expect(s.paymentTarget.blockerarNastaSteg).toBe(true)
      expect(s.state).toBe('BLOCKED_PAYMENT_TARGET')
    })

    it('F4a AVGIFT OCH UTSKICK oförändrade: påminnelser AV → cronen gör ingenting', async () => {
      await satMal(null)
      await satPaminnelser(false)
      skickadePaminnelser.length = 0
      const id = await avi({ dagarSedanForfall: 30, stage: 'NONE' })
      await service.escalateOverdueRentNotices()
      const efter = await prisma.rentNotice.findUniqueOrThrow({
        where: { id },
        select: { collectionStage: true, reminderFeeAmount: true },
      })
      expect(efter.collectionStage).toBe('NONE')
      expect(Number(efter.reminderFeeAmount)).toBe(0)
      expect(skickadePaminnelser).not.toContain(id)
      expect(
        await prisma.journalEntry.count({
          where: { organizationId: orgId, sourceId: `reminder-fee:${id}` },
        }),
      ).toBe(0)
    }, 40_000)
  })

  // ── Ett tillstånd som INTE ska få betalningsmålsskäl ──────────────────────
  it('BETALD avi i org utan mål: NOT_APPLICABLE, inget skäl om nästa steg', async () => {
    await satMal(null)
    const id = await avi({ dagarSedanForfall: 30, stage: 'NONE' })
    await prisma.rentNotice.update({ where: { id }, data: { status: 'PAID' } })
    const s = await status(id)
    // Cronens urval kräver status OVERDUE, så en betald avi prövas inte.
    // `blockerarNastaSteg` får därför inte vara sant — men bristen visas.
    expect(s.state).toBe('NOT_APPLICABLE')
    expect(s.paymentTarget.ok).toBe(false)
  })
})
