/**
 * K-a — BETALNINGSMÅLETS SPÄRR OCH DEN SVENSKA DAGSREGELN, I KOMBINATIONEN.
 *
 * ── FELET UPPSTÅR FÖRST NÄR GRENARNA MÖTS ───────────────────────────────────
 *
 * #919 avgjorde om betalningsmålet blockerar nästa steg med bland annat
 * `notice.status === 'OVERDUE'`. #917 införde den svenska kalenderdagen: en avi
 * kan ha LAGRAD `OVERDUE` medan dess svenska förfallodag inte passerat, och
 * kravtrappans cron hoppar då över den (`daysOverdue <= 0`).
 *
 * Ingen av grenarna har felet ensam. I kombinationen hade panelen sagt
 * `BLOCKED_PAYMENT_TARGET` om ett hinder som inte finns — hyresvärden fyller i
 * bankgirot och ser ingen förändring.
 *
 * Integrationen låter `arPaminnelsekandidat` läsa samma `daysOverdue` som cronen,
 * alltså `swedishDaysBetween`. Ingen andra kalenderimplementation.
 *
 * ── VAD PROVET MÄTER ────────────────────────────────────────────────────────
 *
 * Riktig Postgres. `collectionStatus` tar `now` som argument och honorerar det,
 * så dygnsgränsen prövas på SEKUNDEN i två tidszoner. Cron-effekten mäts
 * separat, eftersom `escalateOverdueRentNotices` läser den riktiga klockan.
 *
 * Varje spärr har sin positiva motsvarighet i samma beskrivning — annars är en
 * spärr oskiljbar från en spärr som alltid spärrar.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient, type RentNoticeStatus } from '@prisma/client'
import { swedishDaysBetween } from '@eken/shared'

import { RentReminderService } from './rent-reminder.service'
import { RentDebtService } from './rent-debt.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentInterestService } from './rent-interest.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/**
 * ── KD-4: SERVERNS ZON BEVISAS I EN EGEN PROCESS, ALDRIG INNE I JEST ────────
 *
 * Tidigare tilldelade KD-4 `process.env.TZ = 'America/Los_Angeles'` inne i ett
 * test. Uppmätt (T2 och T3, processbunden sond): jest ger testet en KOPIA av
 * `process.env`, tilldelningen når inte Node, och fallet mätte UTC två gånger.
 *
 * Nu körs HELA filen en extra gång i ett eget CI-steg:
 *
 *   TZ=America/Los_Angeles KD4_KRAV_ZON=America/Los_Angeles jest <den här filen>
 *
 * och ankaret nedan kräver att processens verkliga zon — IANA-namn OCH offset
 * vid dygnsgränsen — är den begärda. I huvudsviten är `KD4_KRAV_ZON` osatt, och
 * då påstår inget fall en annan zon än processens egen.
 */
const KRAV_ZON = process.env.KD4_KRAV_ZON

/** Offset (minuter, som `getTimezoneOffset`) som zonen `zon` har vid `t`. */
function offsetI(zon: string, t: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zon,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  )
  const lokal = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!)
  return (t.getTime() - lokal) / 60_000
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))

  it('KD-4 ZONANKARE: processens verkliga zon och offset är den begärda (när KD4_KRAV_ZON är satt)', () => {
    const verklig = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!KRAV_ZON) {
      // Huvudsviten: ingen zon begärd. Ankaret registrerar bara processens zon.
      expect(typeof verklig).toBe('string')
      return
    }
    expect(verklig).toBe(KRAV_ZON)
    // Offset vid den svenska dygnsgränsen som provet använder, mätt på två sätt:
    // processens lokala tid (`getTimezoneOffset`) mot zonens IANA-regel.
    for (const t of [new Date('2026-07-01T21:59:59Z'), new Date('2026-07-01T22:00:00Z')]) {
      expect(t.getTimezoneOffset()).toBe(offsetI(KRAV_ZON, t))
    }
  })
})

const GILTIGT = '5050-1055'
const DYGN = 24 * 60 * 60 * 1000

/**
 * Förfallodagen är 1 juli 2026, lagrad som UTC-midnatt — den konvention #917
 * uttryckligen ska klara. Svensk sommartid är UTC+2, så det svenska dygnet
 * slutar 2026-07-01T21:59:59Z och nästa börjar 22:00:00Z.
 */
const FORFALLODAG = new Date('2026-07-01T00:00:00Z')
const SISTA_SEKUNDEN = new Date('2026-07-01T21:59:59Z')
const FORSTA_EFTER = new Date('2026-07-01T22:00:00Z')

medDb('K-a · betalningsmålet mot den svenska dygnsgränsen', () => {
  let prisma: PrismaClient
  let service: RentReminderService
  let orgId: string
  let tenantId: string
  let leaseId: string
  const koadePaminnelser: string[] = []
  let raknare = 0

  const satMal = (bankgiro: string | null) =>
    prisma.organization.update({ where: { id: orgId }, data: { bankgiro } })
  const satPaminnelser = (pa: boolean) =>
    prisma.organization.update({ where: { id: orgId }, data: { remindersEnabled: pa } })

  const avi = async (opts: {
    stage: 'NONE' | 'REMINDED'
    dueDate?: Date
    status?: RentNoticeStatus
    paminnelsePdf?: boolean
  }) => {
    const nr = ++raknare
    const rad = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `KA-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${5000000 + nr}`,
        month: ((nr - 1) % 12) + 1,
        year: 2060 + Math.floor((nr - 1) / 12),
        amount: 9000,
        totalAmount: 9000,
        dueDate: opts.dueDate ?? FORFALLODAG,
        // LAGRAD status. Att den kan vara `OVERDUE` innan den svenska dagen
        // passerat är hela radklassen K-a handlar om.
        status: opts.status ?? 'OVERDUE',
        collectionStage: opts.stage,
        sentAt: new Date('2026-06-01T09:00:00Z'),
        ...(opts.paminnelsePdf ? { reminderPdfStorageKey: 'r2/p.pdf' } : {}),
      },
      select: { id: true },
    })
    return rad.id
  }

  const status = (id: string, nu: Date) => service.collectionStatus(id, orgId, nu)

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
      // LOKAL FÅNGARE: köandet registreras här och når aldrig Redis.
      pdfQueue: {
        enqueue: async (j: { noticeId: string }) => {
          koadePaminnelser.push(j.noticeId)
          return 'lokalt'
        },
      },
      mailService: {
        sendRentNoticeReminder: async () => {
          throw new Error('K-a: mejlvägen anropades oväntat')
        },
      },
      rentDebt: new RentDebtService(prisma as never),
      freshness,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      cronErrors: {
        report: async (f: unknown) => {
          throw f
        },
      },
      notifications: { create: jest.fn() },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `ka-${sfx}`,
        email: `ka-${sfx}@example.invalid`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        remindersEnabled: true,
        rentReminderDay: 5,
        rentInkassoDaysAfterReminder: 14,
        reminderFeeSek: 60,
        bankgiro: GILTIGT,
      },
      select: { id: true },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `ka-t-${sfx}@example.invalid`,
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
        name: `KA ${sfx}`,
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

  afterEach(async () => {
    await satPaminnelser(true)
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: null },
    })
  })

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

  // ── Förutsättningen: dagsregeln ÄR den som mäts ────────────────────────────
  it('riggens dygnsgräns stämmer med den delade dagsregeln', () => {
    expect(swedishDaysBetween(FORFALLODAG, SISTA_SEKUNDEN)).toBe(0)
    expect(swedishDaysBetween(FORFALLODAG, FORSTA_EFTER)).toBe(1)
  })

  // ── KD-1 / KD-2 / KD-3: dygnsgränsen, lagrad för tidig OVERDUE ────────────
  it('KD-1+KD-2 lagrad OVERDUE, saknat mål: INGET hinder sista sekunden, hinder första sekunden efter', async () => {
    await satMal(null)
    const id = await avi({ stage: 'NONE' })

    const sista = await status(id, SISTA_SEKUNDEN)
    // Formatdiagnosen står kvar — målet ÄR ogiltigt.
    expect(sista.paymentTarget.ok).toBe(false)
    // Men cronen hoppar över avin, så målet blockerar ingenting ännu.
    expect(sista.daysOverdue).toBe(0)
    expect(sista.paymentTarget.blockerarNastaSteg).toBe(false)
    expect(sista.state).toBe('NOT_APPLICABLE')

    const efter = await status(id, FORSTA_EFTER)
    expect(efter.daysOverdue).toBe(1)
    // Tröskeln (rentReminderDay 5) är ännu inte nådd — men kandidaturvalet
    // kräver bara att dagen passerat; cron-loopens tröskelgrind är separat.
    expect(efter.paymentTarget.blockerarNastaSteg).toBe(true)
    expect(efter.state).toBe('BLOCKED_PAYMENT_TARGET')
  }, 40_000)

  it('KD-4 samma utfall i processens zon — zonen är serverns, regeln är svensk (LA: eget CI-steg)', async () => {
    // Regeln läser Europe/Stockholm ur den delade kalendern, inte processens zon.
    // Vilken zon processen har avgörs UTANFÖR provet (se ZONANKARET överst):
    // huvudsviten kör runnerns zon, CI-steget "KD-4 i America/Los_Angeles" kör
    // hela filen med TZ satt före processtart och ankaret bundet.
    await satMal(null)
    const id = await avi({ stage: 'NONE' })
    expect((await status(id, SISTA_SEKUNDEN)).state).toBe('NOT_APPLICABLE')
    expect((await status(id, FORSTA_EFTER)).state).toBe('BLOCKED_PAYMENT_TARGET')
  }, 40_000)

  it('KD-3 ingen ekonomisk effekt vid sista sekunden: avgift, verifikat och kö orörda', async () => {
    await satMal(null)
    koadePaminnelser.length = 0
    const id = await avi({ stage: 'NONE' })
    await status(id, SISTA_SEKUNDEN)
    const rad = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true, reminderFeeAmount: true, status: true },
    })
    expect(rad.collectionStage).toBe('NONE')
    expect(Number(rad.reminderFeeAmount)).toBe(0)
    expect(rad.status).toBe('OVERDUE')
    expect(koadePaminnelser).toHaveLength(0)
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: orgId, sourceId: `reminder-fee:${id}` },
      }),
    ).toBe(0)
  }, 40_000)

  // ── Positiv motsvarighet: giltigt mål ────────────────────────────────────
  it('POSITIV KONTROLL giltigt mål: inget målskäl vid någon av tidpunkterna', async () => {
    await satMal(GILTIGT)
    const id = await avi({ stage: 'NONE' })
    for (const nu of [SISTA_SEKUNDEN, FORSTA_EFTER]) {
      const s = await status(id, nu)
      expect(s.paymentTarget.ok).toBe(true)
      expect(s.paymentTarget.blockerarNastaSteg).toBe(false)
      expect(s.state).toBe('NOT_APPLICABLE')
    }
  }, 40_000)

  // ── KD-6: påminnelser AV vid BÅDA tidpunkterna ───────────────────────────
  it('KD-6 påminnelser AV: aldrig BLOCKED_PAYMENT_TARGET vid någon tidpunkt', async () => {
    await satMal(null)
    await satPaminnelser(false)
    const id = await avi({ stage: 'NONE' })
    for (const nu of [SISTA_SEKUNDEN, FORSTA_EFTER]) {
      const s = await status(id, nu)
      expect(s.paymentTarget.ok).toBe(false)
      expect(s.paymentTarget.blockerarNastaSteg).toBe(false)
      expect(s.state).toBe('NOT_APPLICABLE')
    }
  }, 40_000)

  // ── Stage REMINDED prövas SEPARAT: där finns ingen dagsgrind ─────────────
  it('REMINDED med utskick kvar: målet blockerar oavsett dagsregeln — avgiften är redan tagen', async () => {
    await satMal(null)
    const id = await avi({ stage: 'REMINDED' })
    // Även vid sista sekunden: det återstående steget är påminnelsens UTSKICK,
    // som `processReminderSendJob` grindar utan dagsvillkor.
    const s = await status(id, SISTA_SEKUNDEN)
    expect(s.paymentTarget.blockerarNastaSteg).toBe(true)
    expect(s.state).toBe('BLOCKED_PAYMENT_TARGET')
  }, 40_000)

  it('REMINDED med påminnelsen utskickad: målet stoppar inte inkassosteget, och statusen påstår det inte', async () => {
    await satMal(null)
    const id = await avi({ stage: 'REMINDED', paminnelsePdf: true })
    const s = await status(id, FORSTA_EFTER)
    expect(s.paymentTarget.ok).toBe(false)
    expect(s.paymentTarget.blockerarNastaSteg).toBe(false)
    expect(s.state).not.toBe('BLOCKED_PAYMENT_TARGET')
  }, 40_000)

  it('REMINDED med påminnelser AV: REMINDERS_OFF behåller prioriteten', async () => {
    await satMal(null)
    await satPaminnelser(false)
    const id = await avi({ stage: 'REMINDED' })
    expect((await status(id, FORSTA_EFTER)).state).toBe('REMINDERS_OFF')
  }, 40_000)

  it('PAUSED_STALE går före målskälet även efter dygnsgränsen', async () => {
    await satMal(null)
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: new Date('2026-05-01T00:00:00Z'), paymentDataStaleDays: 3 },
    })
    const id = await avi({ stage: 'REMINDED' })
    expect((await status(id, FORSTA_EFTER)).state).toBe('PAUSED_STALE')
  }, 40_000)

  // ── VERKLIG CRON-EFFEKT: statusen och cronen ska vara överens ────────────
  //
  // `escalateOverdueRentNotices` läser den RIKTIGA klockan, så dessa avier får
  // förfallodagar relativa till nu. Tidpunkten injiceras i statusanropet så de
  // två jämförs på samma grund.
  it('CRON: dagen EJ passerad → cronen avstår OCH statusen säger inget hinder', async () => {
    await satMal(null)
    koadePaminnelser.length = 0
    const nu = new Date()
    // Förfallodagen är I DAG i svensk tid → daysOverdue = 0.
    const id = await avi({ stage: 'NONE', dueDate: nu })
    const s = await status(id, nu)
    expect(s.daysOverdue).toBe(0)
    expect(s.paymentTarget.blockerarNastaSteg).toBe(false)

    const summering = await service.escalateOverdueRentNotices()
    const rad = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true, reminderFeeAmount: true },
    })
    expect(rad.collectionStage).toBe('NONE')
    expect(Number(rad.reminderFeeAmount)).toBe(0)
    expect(koadePaminnelser).not.toContain(id)
    expect(summering.reminded).toBe(0)
  }, 60_000)

  it('CRON POSITIV KONTROLL: tröskeln passerad + giltigt mål → cronen eskalerar faktiskt', async () => {
    await satMal(GILTIGT)
    koadePaminnelser.length = 0
    const nu = new Date()
    const id = await avi({ stage: 'NONE', dueDate: new Date(nu.getTime() - 10 * DYGN) })
    const summering = await service.escalateOverdueRentNotices()
    const rad = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true },
    })
    expect(rad.collectionStage).toBe('REMINDED')
    expect(koadePaminnelser).toContain(id)
    expect(summering.reminded).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('CRON: tröskeln passerad men mål saknas → cronen avstår OCH statusen säger hinder', async () => {
    await satMal(null)
    koadePaminnelser.length = 0
    const nu = new Date()
    const id = await avi({ stage: 'NONE', dueDate: new Date(nu.getTime() - 10 * DYGN) })
    const s = await status(id, nu)
    expect(s.paymentTarget.blockerarNastaSteg).toBe(true)
    expect(s.state).toBe('BLOCKED_PAYMENT_TARGET')

    await service.escalateOverdueRentNotices()
    const rad = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true, reminderFeeAmount: true },
    })
    expect(rad.collectionStage).toBe('NONE')
    expect(Number(rad.reminderFeeAmount)).toBe(0)
    expect(koadePaminnelser).not.toContain(id)
  }, 60_000)
})
