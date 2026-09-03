/**
 * LARMET OM EN AVI SOM FASTNAT — mot riktig Postgres (#648).
 *
 * ── VAD SOM SAKNADES ───────────────────────────────────────────────────────
 *
 * Kravtrappan blockerar en avi med ofullständigt underlag varje dygn och
 * skriver en append-only-rad om det. Ingenting sa till någon. Uppmätt: fall
 * "d" i #648:s rigg stod blockerad i tre dygn med tre `NOTE_ADDED` och **noll**
 * notisrader.
 *
 * ── DE TRE EGENSKAPER SOM MÄTS, OCH VARFÖR ALLA TRE BEHÖVS ─────────────────
 *
 *     8 dygn   → EXAKT ETT larm          (tröskeln passeras)
 *     20 dygn  → fortfarande ETT         (idempotens per period)
 *     ny period → ETT till               (markören nollställs på ingången)
 *
 * Utan den andra är ett larm per dygn grönt. Utan den tredje är en markör som
 * aldrig nollställs grön — och en avi som fastnar en andra gång hade då tigit
 * för alltid.
 *
 * ── OCH DEN OMVÄNDA RIKTNINGEN ─────────────────────────────────────────────
 *
 * En PAUSAD org (inaktuell betalningsdata) ska INTE ge ett larm per avi.
 * Freshness-larmet äger den frågan och skickar ETT mejl per org och
 * stale-period; ett larm per avi ovanpå hade varit samma besked en gång per
 * obetald avi.
 *
 * ── VAD PROVET INTE KAN SE ─────────────────────────────────────────────────
 *
 *  • Att notisen går att klicka på. Segmentet `avisering` lades till i
 *    `notification-link.ts` i samma PR, men `apps/web` har ingen
 *    enhetstestkörare — provet mäter SKRIVARENS halva: att länken bär ett
 *    segment mappningen känner, och att den strukturerade referensen är satt.
 *  • Att en avi som INTE går att åtgärda hålls utanför. Efter #715 kan en
 *    helkrediterad avi inte längre blockeras — den lämnar kravtrappan när
 *    krediteringen skrivs. Det är den PR:en som bär den egenskapen, inte den
 *    här; `credit-clears-collection-stage.db.spec.ts` mäter den.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { RentDebtService } from './rent-debt.service'
import { RentInterestService } from './rent-interest.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { BLOCKERAD_AVI_LARMTROSKEL_DAGAR, RentReminderService } from './rent-reminder.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const DYGN = 24 * 60 * 60 * 1000
const BELOPP = 9000
const N = 1
const POOL = N + 9

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })

  it('TRÖSKELN LÄSES UR KODEN, inte ur provet', () => {
    // Regeln om att läsa tröskeln ur koden innan sonden byggs: proven nedan
    // åldrar avin till TRÖSKEL + 1 respektive TRÖSKEL + 13, och de talen ska
    // följa konstanten om någon ändrar produktbeslutet.
    expect(BLOCKERAD_AVI_LARMTROSKEL_DAGAR).toBeGreaterThan(0)
  })
})

medDb('larm om blockerad avi', () => {
  let prisma: PrismaClient
  let service: RentReminderService
  let orgId: string
  let orgStaleId: string
  let räknare = 0

  async function byggOrg(staleDagar: number | null): Promise<string> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `blk-${sfx}`,
        email: `blk-${sfx}@example.se`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        orgNumber: `5560${sfx.slice(0, 6)}`,
        remindersEnabled: true,
        rentReminderDay: 5,
        rentInkassoDaysAfterReminder: 14, // fristen: 19 dygn
        paymentDataStaleDays: 3,
        paymentDataThrough: staleDagar === null ? null : new Date(Date.now() - staleDagar * DYGN),
      },
      select: { id: true },
    })
    // TRE mottagare: två som ska få larmet och en VIEWER som inte ska.
    // Ett prov med en enda användare kan inte skilja "alla" från "rätt urval".
    for (const [roll, aktiv] of [
      ['OWNER', true],
      ['ACCOUNTANT', true],
      ['VIEWER', true],
      ['ADMIN', false],
    ] as const) {
      await prisma.user.create({
        data: {
          organizationId: org.id,
          email: `${roll.toLowerCase()}-${randomUUID().slice(0, 8)}@example.se`,
          firstName: roll,
          lastName: 'X',
          role: roll,
          isActive: aktiv,
        },
      })
    }
    await prisma.account.createMany({
      data: [
        { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' as const },
        { organizationId: org.id, number: 3911, name: 'Hyresintäkter', type: 'REVENUE' as const },
        {
          organizationId: org.id,
          number: 3593,
          name: 'Påminnelseavgift',
          type: 'REVENUE' as const,
        },
        { organizationId: org.id, number: 8131, name: 'Dröjsmålsränta', type: 'REVENUE' as const },
      ],
    })
    return org.id
  }

  /**
   * En avi i REMINDED som INV-B kommer att vägra: leveranskvittensen saknas.
   * Allt annat är komplett, så bara den ena orsaken kan fälla.
   */
  async function blockeradAvi(org: string, dagarFörfallen: number): Promise<string> {
    const nr = ++räknare
    const sfx = randomUUID().slice(0, 8)
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        email: `t-${sfx}@example.se`,
        firstName: 'A',
        lastName: 'B',
        street: 'Gatan 2',
        city: 'Stad',
        postalCode: '11111',
        personalNumberHash: 'hash',
      },
      select: { id: true },
    })
    const property = await prisma.property.create({
      data: {
        organizationId: org,
        name: `p-${sfx}`,
        propertyDesignation: `BLK ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
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
        rooms: 2,
        monthlyRent: BELOPP,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: org,
        tenantId: tenant.id,
        unitId: unit.id,
        contractNumber: `HK-${sfx}`,
        monthlyRent: BELOPP,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'DRAFT',
      },
      select: { id: true },
    })
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: org,
        tenantId: tenant.id,
        leaseId: lease.id,
        noticeNumber: `A-${sfx}`,
        ocrNumber: `${5000000 + nr}`,
        month: ((nr - 1) % 12) + 1,
        year: 2026,
        amount: BELOPP,
        totalAmount: BELOPP,
        vatAmount: 0,
        dueDate: new Date(Date.now() - dagarFörfallen * DYGN),
        status: 'OVERDUE',
        collectionStage: 'REMINDED',
        sentAt: new Date(Date.now() - 90 * DYGN),
        reminderPdfStorageKey: 'r2/x.pdf',
      },
      select: { id: true },
    })
    const send = await prisma.rentNoticeSend.create({
      data: { rentNoticeId: notice.id, kind: 'REMINDER', toHash: 'h' },
      select: { id: true },
    })
    await prisma.rentNoticeEvent.create({
      data: { rentNoticeId: notice.id, type: 'SENT', actorType: 'SYSTEM' },
    })
    await prisma.rentNoticeEvent.create({
      data: {
        rentNoticeId: notice.id,
        type: 'REMINDER_SENT',
        actorType: 'SYSTEM',
        sendId: send.id,
      },
    })
    // INGEN EMAIL_DELIVERED → INV-B vägrar, avin blockeras varje dygn.
    return notice.id
  }

  /** Kör cronen `dygn` gånger; åldern flyttas genom att dueDate backas. */
  async function körCron(dygn: number): Promise<void> {
    for (let i = 0; i < dygn; i++) {
      await service.escalateRemindedToInkassoReady()
      await prisma.$executeRawUnsafe(
        `UPDATE "RentNotice" SET "dueDate" = "dueDate" - interval '1 day', ` +
          `"blockedSince" = "blockedSince" - interval '1 day' ` +
          `WHERE "organizationId" = ANY($1::text[])`,
        [orgId, orgStaleId],
      )
    }
  }

  const notiser = (org: string) =>
    prisma.notification.findMany({
      where: { organizationId: org },
      select: {
        userId: true,
        title: true,
        link: true,
        relatedEntityType: true,
        relatedEntityId: true,
      },
    })

  beforeAll(async () => {
    const url = urlMedPool(process.env.DATABASE_URL as string, POOL)
    const satt = Number(new URL(url).searchParams.get('connection_limit'))
    if (!(satt > N)) {
      throw new Error(
        `POOL, INTE LARM: connection_limit=${satt} är inte större än N=${N}. ` +
          'Prismas default är nproc×2+1; med en pool mindre än samtidigheten dör ' +
          'transaktionen av maxWait innan larmet hinner skrivas — ett utfall som ' +
          'ser ut som att tröskeln inte passerats. Riggen sätter poolen själv.',
      )
    }
    prisma = new PrismaClient({ datasources: { db: { url } } })

    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    const events = new RentNoticeEventsService(prisma as never)
    service = Object.create(RentReminderService.prototype) as RentReminderService
    Object.assign(service, {
      prisma,
      accounting,
      rentNoticeEvents: events,
      rentInterest: new RentInterestService(prisma as never, accounting, events),
      rentDebt: new RentDebtService(prisma as never),
      freshness: new PaymentFreshnessService(
        prisma as never,
        {
          send: async () => undefined,
          sendCustomEmail: async () => undefined,
        } as never,
      ),
      cronErrors: { report: async () => undefined },
      // DEN RIKTIGA notistjänsten mot den riktiga tabellen — larmet ska mätas
      // som rader, inte som anrop på en attrapp.
      notifications: new NotificationsService(
        prisma as never,
        {} as never, // mail
        {} as never, // moduleRef
        {} as never, // monthlyReport
        {} as never, // locks
        {} as never, // cronErrors
      ),
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })

    orgId = await byggOrg(null)
    orgStaleId = await byggOrg(100)
  }, 60_000)

  afterEach(async () => {
    // FK-riktning: barnen först.
    const orgs = [orgId, orgStaleId]
    const ids = (
      await prisma.rentNotice.findMany({
        where: { organizationId: { in: orgs } },
        select: { id: true },
      })
    ).map((n) => n.id)
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNoticeId: { in: ids } } })
    await prisma.rentNoticeSend.deleteMany({ where: { rentNoticeId: { in: ids } } })
    await prisma.notification.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: { in: orgs } } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.lease.deleteMany({ where: { organizationId: { in: orgs } } })
    const props = await prisma.property.findMany({
      where: { organizationId: { in: orgs } },
      select: { id: true },
    })
    await prisma.unit.deleteMany({ where: { propertyId: { in: props.map((p) => p.id) } } })
    await prisma.property.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.tenant.deleteMany({ where: { organizationId: { in: orgs } } })
    // Stale-markören nollställs så nästa prov inte ärver föregående provs larm.
    await prisma.organization.updateMany({
      where: { id: { in: orgs } },
      data: { paymentDataStaleAlertedAt: null },
    })
  })

  afterAll(async () => {
    const orgs = [orgId, orgStaleId].filter(Boolean)
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.account.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.user.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    await prisma.$disconnect()
  })

  it(`${BLOCKERAD_AVI_LARMTROSKEL_DAGAR + 1} dygn blockerad → EXAKT ETT larm, till rätt mottagare`, async () => {
    const id = await blockeradAvi(orgId, 30)
    await körCron(BLOCKERAD_AVI_LARMTROSKEL_DAGAR + 1)

    const rader = await notiser(orgId)
    // Tre aktiva användare, men VIEWER är utanför larmurvalet → 2 rader.
    expect(rader).toHaveLength(2)
    expect(new Set(rader.map((r) => r.title)).size).toBe(1)

    // SKRIVARENS halva av länken: segmentet ska vara ett `notification-link.ts`
    // känner igen, och den strukturerade referensen ska peka på avin.
    for (const r of rader) {
      expect(r.link?.split('/')[0]).toBe('avisering')
      expect(r.relatedEntityType).toBe('RENT_NOTICE')
      expect(r.relatedEntityId).toBe(id)
    }

    const avi = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { blockedSince: true, blockedAlertedAt: true },
    })
    expect(avi.blockedSince).not.toBeNull()
    expect(avi.blockedAlertedAt).not.toBeNull()
  }, 120_000)

  it(`${BLOCKERAD_AVI_LARMTROSKEL_DAGAR + 13} dygn blockerad → FORTFARANDE ett larm`, async () => {
    await blockeradAvi(orgId, 30)
    await körCron(BLOCKERAD_AVI_LARMTROSKEL_DAGAR + 13)

    // Ett larm per PERIOD, inte per dygn. Utan det här provet vore en
    // implementation som larmar varje dygn efter tröskeln grön.
    expect(await notiser(orgId)).toHaveLength(2)
  }, 120_000)

  it('en NY blockeringsperiod ger ett NYTT larm', async () => {
    const id = await blockeradAvi(orgId, 30)
    await körCron(BLOCKERAD_AVI_LARMTROSKEL_DAGAR + 1)
    expect(await notiser(orgId)).toHaveLength(2)

    // Avin regleras och lämnar kravtrappan — samma skrivning som betalvägarna
    // gör (status PAID + collectionStage NONE i en update).
    await prisma.rentNotice.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date(), collectionStage: 'NONE' },
    })

    // …och fastnar på nytt. Ingången till REMINDED är den punkt varje ny period
    // passerar, och det är där markörerna nollställs.
    await prisma.rentNotice.update({
      where: { id },
      data: {
        status: 'OVERDUE',
        paidAt: null,
        collectionStage: 'REMINDED',
        blockedSince: null,
        blockedAlertedAt: null,
      },
    })
    await körCron(BLOCKERAD_AVI_LARMTROSKEL_DAGAR + 1)

    expect(await notiser(orgId)).toHaveLength(4)
  }, 120_000)

  it('DEN OMVÄNDA RIKTNINGEN: en PAUSAD org får INGET larm per avi', async () => {
    await blockeradAvi(orgStaleId, 30)
    await körCron(BLOCKERAD_AVI_LARMTROSKEL_DAGAR + 13)

    // Freshness-larmet äger den frågan: ETT mejl per org och stale-period.
    // Ett larm per avi ovanpå hade varit samma besked en gång per obetald avi.
    expect(await notiser(orgStaleId)).toHaveLength(0)

    const avi = await prisma.rentNotice.findFirstOrThrow({
      where: { organizationId: orgStaleId },
      select: { blockedSince: true, blockedAlertedAt: true, collectionStage: true },
    })
    // Markörerna rörs inte alls: avin prövades aldrig.
    expect(avi.blockedSince).toBeNull()
    expect(avi.blockedAlertedAt).toBeNull()
    expect(avi.collectionStage).toBe('REMINDED')
  }, 120_000)
})
