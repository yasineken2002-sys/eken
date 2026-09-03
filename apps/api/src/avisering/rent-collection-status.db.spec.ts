/**
 * VARFÖR STÅR DEN HÄR AVIN STILL? — mot riktig Postgres.
 *
 * ── DEN NEGATIVA KONTROLLEN SOM BÄR HELA FILEN ──────────────────────────────
 *
 * En avi vars påminnelse STUDSAT måste se annorlunda ut än en som VÄNTAR. Går
 * de inte att skilja åt har vyn byggts som ett fönster mot samma tystnad den
 * skulle ta bort. Provet "STUDSAD och VÄNTANDE går att skilja åt" jämför de två
 * fallen mot varandra i stället för att kontrollera dem var för sig — två prov
 * som var för sig är gröna kan ändå ge samma svar.
 *
 * ── VAD MÄTNINGEN VISADE, OCH VARFÖR METODEN FINNS ──────────────────────────
 *
 * `escalateOverdueToInkassoReady` går vidare på tre sätt och bara ETT lämnar ett
 * spår i avins logg:
 *
 *     daysOverdue < tröskeln        `skipped`       INGET event
 *     INV-B saknar något            NOTE_ADDED      ett event per dygn
 *     betalningsdatan inaktuell     `pausedStale`   INGET event
 *
 * Två av tre tillstånd är alltså osynliga för den som bara läser händelserna.
 *
 * ── VAD PROVEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Om cronet faktiskt körde. `collectionStatus` räknar ut vad som skulle hända om
 * det kördes nu; står jobbet still av ett skäl utanför de tre ovan svarar den
 * ändå WAITING. Den frågan ägs av cron-felsänkan.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { RentReminderService } from './rent-reminder.service'
import { RentDebtService } from './rent-debt.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'

import type { RentNoticeEventType } from '@prisma/client'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

// FAST, och det går nu att vara det.
//
// Historien i två steg, eftersom mellansteget ser ut som lösningen och inte var
// det. `NU` var hårdkodad till 2026-09-02T12:00Z. Specen INJICERADE den —
// `collectionStatus(id, orgId, NU)` — men tjänsten räknade `daysOverdue` med
// `this.daysSince(dueDate)`, som läste `Date.now()`. Injektionen var
// HALVDRAGEN: `freshness.evaluate(org, now)` honorerade den, åldern inte.
//
// Utfallet var en tidsbomb. `daysUntilEvaluation` gick 14 → 13 exakt när
// klockan passerade 2026-09-03T12:00Z; två CI-körningar på samma testkod, 40
// minuter isär, gav 11:50Z grön och 12:30Z röd. Ingen flake — den small en gång
// och fällde sedan varje körning.
//
// #690 gjorde `NU` RELATIV (`new Date()`). Det tog bort symptomet genom att ge
// upp injektionen: det injicerade värdet blev ungefär den riktiga klockan, så
// de sammanföll. Provet slutade driva men slutade också mäta något.
//
// Nu är `daysSince(date, now)` obligatorisk hela vägen, så en fast tidpunkt är
// det RIKTIGA valet: provet blir deterministiskt i stället för att bara slippa
// drifta. `injektionen styr åldern`-provet nedan är det som håller den
// egenskapen på plats.
const NU = new Date('2026-09-02T12:00:00.000Z')
const DYGN = 24 * 60 * 60 * 1000

medDb('collectionStatus', () => {
  let prisma: PrismaClient
  let service: RentReminderService
  let orgId: string
  let tenantId: string
  let leaseId: string
  let propertyId: string
  let räknare = 0

  /**
   * En avi i REMINDED med valfri ålder och valfria händelser.
   *
   * `komplett` lägger in allt INV-B kräver utom det provet vill ta bort — så
   * varje prov mäter EN sak. Utan den hade "saknar leveranskvittens" varit sant
   * i varje fall och proven hade inte kunnat skilja orsakerna åt.
   */
  const avi = async (opts: {
    dagarSedanFörfall: number
    händelser?: RentNoticeEventType[]
    komplett?: boolean
  }) => {
    const nr = ++räknare
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${1000000 + nr}`,
        // PERIODEN VARIERAS, INTE DATUMET. `@@unique([leaseId, year, month, type])`
        // gör att två avier på samma avtal och månad krockar; åldern styrs av
        // `dueDate` och är oberoende av perioden, så riggen kan variera fritt.
        month: ((nr - 1) % 12) + 1,
        year: 2026 + Math.floor((nr - 1) / 12),
        amount: 9000,
        totalAmount: 9000,
        dueDate: new Date(NU.getTime() - opts.dagarSedanFörfall * DYGN),
        status: 'OVERDUE',
        collectionStage: 'REMINDED',
        ...(opts.komplett === false
          ? {}
          : { sentAt: new Date(NU.getTime() - 40 * DYGN), reminderPdfStorageKey: 'r2/x.pdf' }),
      },
      select: { id: true },
    })
    for (const type of opts.händelser ?? []) {
      await prisma.rentNoticeEvent.create({
        data: { rentNoticeId: notice.id, type, actorType: 'SYSTEM' },
      })
    }
    return notice.id
  }

  const status = (id: string) => service.collectionStatus(id, orgId, NU)

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = Object.create(RentReminderService.prototype) as RentReminderService
    Object.assign(service, {
      prisma,
      rentDebt: new RentDebtService(prisma as never),
      freshness: new PaymentFreshnessService(
        prisma as never,
        { send: async () => undefined } as never,
      ),
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `kra-${sfx}`,
        email: `kra-${sfx}@example.se`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        orgNumber: '556000-0001',
        remindersEnabled: true,
        rentReminderDay: 5,
        rentInkassoDaysAfterReminder: 14,
      },
      select: { id: true },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `kra-t-${sfx}@example.se`,
        firstName: 'A',
        lastName: 'B',
        street: 'Gatan 2',
        city: 'Stad',
        postalCode: '11111',
        personalNumberHash: 'hash',
      },
      select: { id: true },
    })
    tenantId = tenant.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `KRA ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
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
        rooms: 2,
        monthlyRent: 9000,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
        unitId: unit.id,
        contractNumber: `HK-${sfx}`,
        monthlyRent: 9000,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'DRAFT',
      },
      select: { id: true },
    })
    leaseId = lease.id
  }, 30_000)

  beforeEach(async () => {
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: null, remindersEnabled: true },
    })
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  // ── DEN NEGATIVA KONTROLLEN ───────────────────────────────────────────────

  it('NEGATIVKONTROLL: en STUDSAD påminnelse går att skilja från en som VÄNTAR', async () => {
    // Det här provet är hela vyns existensberättigande. Ger de två fallen samma
    // svar är fönstret ett fönster mot samma tystnad.
    const väntar = await avi({
      dagarSedanFörfall: 5,
      händelser: ['SENT', 'REMINDER_SENT', 'EMAIL_DELIVERED'],
    })
    const studsat = await avi({
      dagarSedanFörfall: 40,
      händelser: ['SENT', 'REMINDER_SENT', 'EMAIL_BOUNCED'],
    })

    const a = await status(väntar)
    const b = await status(studsat)

    expect(a.state).toBe('WAITING')
    expect(b.state).toBe('BLOCKED')
    expect(a.state).not.toBe(b.state)

    // Och skillnaden går att LÄSA, inte bara jämföra.
    expect(b.missing).toEqual(expect.arrayContaining([expect.stringContaining('studsade')]))
    expect(a.missing).not.toEqual(expect.arrayContaining([expect.stringContaining('studsade')]))
    expect(b.delivery.reminderBouncedAt).not.toBeNull()
    expect(a.delivery.reminderBouncedAt).toBeNull()
  })

  // ── DE TRE VÄGARNA VIDARE ─────────────────────────────────────────────────

  it('VÄNTAR: under tröskeln, med ett datum i stället för tystnad', async () => {
    const id = await avi({ dagarSedanFörfall: 5, händelser: ['SENT', 'EMAIL_DELIVERED'] })
    const s = await status(id)
    expect(s.state).toBe('WAITING')
    expect(s.thresholdDays).toBe(19) // rentReminderDay 5 + rentInkassoDaysAfterReminder 14
    expect(s.daysUntilEvaluation).toBe(14)
  })

  // ── ATT INJEKTIONEN FAKTISKT STYR ÅLDERN ──────────────────────────────────
  //
  // Det här provet är hela filens förutsättning, och det var RÖTT före
  // #694-fixen: `collectionStatus` tog emot ett `now` men räknade `daysOverdue`
  // med `Date.now()`, så båda anropen nedan fick samma ålder och differensen
  // blev 0 i stället för 10.
  //
  // Utan det här provet kan `NU` ovan tystnadsvis sluta betyda något igen —
  // och då är varje tal i filen ett tal om den maskin som råkar köra den.
  it('INJEKTIONEN STYR ÅLDERN: samma avi, två tidpunkter, tio dygns skillnad', async () => {
    const id = await avi({ dagarSedanFörfall: 5, händelser: ['SENT', 'EMAIL_DELIVERED'] })

    const vid = async (när: Date) => service.collectionStatus(id, orgId, när)
    const nu = await vid(NU)
    const senare = await vid(new Date(NU.getTime() + 10 * DYGN))

    expect(senare.daysOverdue - nu.daysOverdue).toBe(10)
    // Och åt andra hållet i samma storhet: fönstret krymper lika mycket.
    expect(nu.daysUntilEvaluation - senare.daysUntilEvaluation).toBe(10)
    // Tröskeln är en organisationsinställning och ska INTE röra sig med tiden —
    // annars kunde differensen ovan komma från fel håll.
    expect(senare.thresholdDays).toBe(nu.thresholdDays)
  })

  it('PAUSAD: inaktuell betalningsdata — cronets tysta väg vidare', async () => {
    // Den här vägen skriver INGET event. Utan metoden är den osynlig.
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: new Date(NU.getTime() - 60 * DYGN) },
    })
    const id = await avi({ dagarSedanFörfall: 40, händelser: ['SENT', 'EMAIL_DELIVERED'] })
    const s = await status(id)
    expect(s.state).toBe('PAUSED_STALE')
    expect(s.freshness.stale).toBe(true)
    expect(s.freshness.ageDays).toBe(60)
  })

  it('AVSTÄNGDA PÅMINNELSER är ett eget svar, inte "väntar för alltid"', async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { remindersEnabled: false } })
    const id = await avi({ dagarSedanFörfall: 40, händelser: ['SENT', 'EMAIL_DELIVERED'] })
    expect((await status(id)).state).toBe('REMINDERS_OFF')
  })

  it('REDO: inget saknas — nästa körning flyttar fram den', async () => {
    const id = await avi({
      dagarSedanFörfall: 40,
      händelser: ['SENT', 'REMINDER_SENT', 'EMAIL_DELIVERED'],
    })
    const s = await status(id)
    expect(s.missing).toEqual([])
    expect(s.state).toBe('READY')
  })

  // ── #651: DE TVÅ LEVERANSERNA FÅR ALDRIG BLANDAS IHOP ─────────────────────

  it('AVINS leverans uppfyller INTE påminnelsens grind', async () => {
    // Det skarpaste provet i filen. Hade NOTICE_EMAIL_DELIVERED räknats som
    // leveransbevis kunde ett krav gått till inkasso på beviset att den
    // URSPRUNGLIGA avin kom fram — inte påminnelsen.
    const id = await avi({
      dagarSedanFörfall: 40,
      händelser: ['SENT', 'REMINDER_SENT', 'NOTICE_EMAIL_DELIVERED'],
    })
    const s = await status(id)
    expect(s.delivery.noticeDeliveredAt).not.toBeNull()
    expect(s.delivery.reminderDeliveredAt).toBeNull()
    expect(s.missing).toEqual(
      expect.arrayContaining([expect.stringContaining('påminnelsens leverans')]),
    )
    expect(s.state).toBe('BLOCKED')
  })

  // ── missing FYLLS ALLTID ──────────────────────────────────────────────────

  it('en avi som VÄNTAR visar ändå sina brister — adressen ska hinna rättas', async () => {
    // Poängen med #656: ingen kan rätta en adress hen inte vet är fel. Väntas
    // det till tröskeln passerats är felet redan ett stopp.
    const id = await avi({
      dagarSedanFörfall: 3,
      händelser: ['SENT', 'REMINDER_SENT', 'EMAIL_BOUNCED'],
    })
    const s = await status(id)
    expect(s.state).toBe('WAITING')
    expect(s.missing).toEqual(expect.arrayContaining([expect.stringContaining('studsade')]))
  })

  it('BLOCKERINGENS ÅLDER räknas ur loggen — hur länge har det stått still?', async () => {
    const id = await avi({ dagarSedanFörfall: 40, händelser: ['SENT'] })
    await prisma.rentNoticeEvent.create({
      data: {
        rentNoticeId: id,
        type: 'NOTE_ADDED',
        actorType: 'SYSTEM',
        payload: { action: 'inkasso-ready-blocked', missing: ['x'] },
        createdAt: new Date(NU.getTime() - 12 * DYGN),
      },
    })
    const s = await status(id)
    expect(s.lastBlockedAt).not.toBeNull()
    expect(s.blockedDays).toBeGreaterThanOrEqual(11)
  })

  it('en avi som inte är i REMINDED har ingen eskalering att vänta på', async () => {
    const id = await avi({ dagarSedanFörfall: 40 })
    await prisma.rentNotice.update({ where: { id }, data: { collectionStage: 'NONE' } })
    expect((await status(id)).state).toBe('NOT_APPLICABLE')
  })

  it('SEND_FAILED hindrar INTE inkassogrinden — den är upplysning, inte beslut', async () => {
    // Kön skriver numera SEND_FAILED på avin när ett utskick ger upp (#648-följd).
    // INV-B läser SENT, EMAIL_DELIVERED och EMAIL_BOUNCED. Skulle grinden börja
    // läsa SEND_FAILED vore det ett nytt hinder ingen beslutat om — och den
    // upplysning som skulle förklara ett stopp hade blivit stoppet.
    const id = await avi({
      dagarSedanFörfall: 40,
      händelser: ['SENT', 'REMINDER_SENT', 'EMAIL_DELIVERED', 'SEND_FAILED'],
    })
    const s = await status(id)
    expect(s.missing).toEqual([])
    expect(s.state).toBe('READY')
    // …och raden finns, så provet mäter inte en tom mängd.
    expect(s.delivery.sendFailedAt).not.toBeNull()
  })
})
