/**
 * EN HELKREDITERAD AVI LÄMNAR KRAVTRAPPAN — mot riktig Postgres.
 *
 * ── VAD SOM MÄTTES, OCH VARFÖR DET INTE VAR EN SMAKSAK ──────────────────────
 *
 * Krediteringen rörde tidigare varken `status` eller `collectionStage`, med
 * motiveringen att skulden är ett BERÄKNAT tillstånd. Den motiveringen är rätt
 * om `status` och fel om `collectionStage`: steget säger inte hur stor skulden
 * är, utan var i kravtrappan ärendet står.
 *
 * Uppmätt (#648), cronen körd tre dygn på en fullt krediterad avi i REMINDED:
 *
 *     stage REMINDED · tre NOTE_ADDED ("ingen utestående skuld att driva in")
 *     · state=BLOCKED i /collection-status
 *
 * Och ingen väg ut: INV-B faller på steg 10 (ocrOutstanding <= 0), så
 * eskaleringen sker aldrig; kundförlust-cronen plockar bara
 * `collectionStage: 'INKASSO_READY'`, så avskrivningen sker aldrig; och
 * `cancelNotice` matchar bara rader med `credits: { none: {} }`, så avin går
 * inte ens att annullera. Ärendet blockeras varje dygn, för alltid.
 *
 * ── DE BÅDA RIKTNINGARNA, OCH VARFÖR BÅDA MÅSTE PRÖVAS ──────────────────────
 *
 * En spärr som släpper ut för mycket är lika fel som en som släpper ut för
 * lite. Filen mäter därför BÅDA:
 *
 *     HELKREDIT  ocrOutstanding = 0  → stage NONE, cronen ser den inte
 *     DELKREDIT  skuld kvar          → stage OFÖRÄNDRAT, kravtrappan fortsätter
 *
 * Utan det andra provet hade en implementation som nollar steget vid VARJE
 * kreditering varit grön — och en delvis krediterad hyresskuld hade tyst
 * lämnat kravtrappan.
 *
 * ── VAD FILEN INTE KAN SE ───────────────────────────────────────────────────
 *
 *  • De andra vägarna som nollar skulden. Betalvägarna och annulleringen
 *    sätter redan NONE i sin egen update; att de gör det ägs av deras egna
 *    prov, inte av det här.
 *  • Att kravtrappans cron körs. Provet anropar den direkt.
 *  • Momsbärande krediteringar. Grinden avvisar dem redan
 *    (`assessRentNoticeCreditability`), och fixturen är momsfri.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { RentDebtService } from './rent-debt.service'
import { RentInterestService } from './rent-interest.service'
import { RentNoticeCreditService } from './rent-notice-credit.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentReminderService } from './rent-reminder.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const DYGN = 24 * 60 * 60 * 1000
/** Antal simulerade dygn = antal cron-körningar. Samma tal som mätningen bar. */
const N_DYGN = 3
const BELOPP = 9000
/** Samtidigheten riggen skapar mot Postgres. */
const N = 1
/** Poolen sätts explicit, aldrig ärvd från nproc (#695). */
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
})

medDb('kreditering och kravtrappans steg', () => {
  let prisma: PrismaClient
  let credits: RentNoticeCreditService
  let reminder: RentReminderService
  let orgId: string
  let userId: string
  let tenantId: string
  let propertyId: string
  let leaseId: string
  let räknare = 0

  beforeAll(async () => {
    const url = urlMedPool(process.env.DATABASE_URL as string, POOL)
    const satt = Number(new URL(url).searchParams.get('connection_limit'))
    if (!(satt > N)) {
      throw new Error(
        `POOL, INTE KRAVTRAPPA: connection_limit=${satt} är inte större än N=${N}. ` +
          'Prismas default är nproc×2+1. Med en pool mindre än samtidigheten blir ' +
          'maxWait den bindande gränsen och transaktionen dör innan den hinner ' +
          'skriva — ett utfall som ser ut som att spärren vägrade. Riggen sätter ' +
          'poolen själv: får du det här felet är POOL-konstanten fel.',
      )
    }
    prisma = new PrismaClient({ datasources: { db: { url } } })

    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    const events = new RentNoticeEventsService(prisma as never)
    credits = new RentNoticeCreditService(prisma as never, events, accounting)

    reminder = Object.create(RentReminderService.prototype) as RentReminderService
    Object.assign(reminder, {
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
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `kre-${sfx}`,
        email: `kre-${sfx}@example.se`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        orgNumber: `5560${sfx.slice(0, 6)}`,
        remindersEnabled: true,
        rentReminderDay: 5,
        rentInkassoDaysAfterReminder: 14, // tröskel 19 dygn
        // null = ALDRIG inaktuell betalningsdata; annars hade freshness-grinden
        // pausat cronen och provet mätt fel spärr.
        paymentDataThrough: null,
      },
      select: { id: true },
    })
    orgId = org.id

    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `u-${sfx}@example.se`,
        firstName: 'Hyres',
        lastName: 'Värd',
        role: 'OWNER',
        isActive: true,
      },
      select: { id: true },
    })
    userId = user.id

    await prisma.account.createMany({
      data: [
        { organizationId: orgId, number: 1510, name: 'Kundfordringar', type: 'ASSET' as const },
        { organizationId: orgId, number: 3911, name: 'Hyresintäkter', type: 'REVENUE' as const },
        { organizationId: orgId, number: 3593, name: 'Påminnelseavgift', type: 'REVENUE' as const },
        { organizationId: orgId, number: 8131, name: 'Dröjsmålsränta', type: 'REVENUE' as const },
      ],
    })

    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
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
    tenantId = tenant.id

    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `p-${sfx}`,
        propertyDesignation: `KRE ${sfx}`,
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
        monthlyRent: BELOPP,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
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
    leaseId = lease.id
  }, 60_000)

  afterEach(async () => {
    // FK-RIKTNING: barnen först. Krediteringar och verifikat pekar med Restrict,
    // så de måste bort innan avin — och avin innan nästa prov bygger sin egen.
    const ids = (
      await prisma.rentNotice.findMany({ where: { organizationId: orgId }, select: { id: true } })
    ).map((n) => n.id)
    await prisma.rentNoticeCreditLine.deleteMany({
      where: { credit: { rentNoticeId: { in: ids } } },
    })
    await prisma.rentNoticeCredit.deleteMany({ where: { rentNoticeId: { in: ids } } })
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNoticeId: { in: ids } } })
    await prisma.rentNoticeSend.deleteMany({ where: { rentNoticeId: { in: ids } } })
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.notification.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /**
   * En avi i REMINDED med KOMPLETT INV-B-underlag, plus det accrual-verifikat
   * krediteringen speglar. Utan verifikatet avvisas krediteringen med
   * "saknar bokfört underlag", och provet hade mätt bokföringen i stället för
   * kravtrappan.
   */
  async function avi(): Promise<string> {
    const nr = ++räknare
    const sfx = randomUUID().slice(0, 8)
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${sfx}`,
        ocrNumber: `${3000000 + nr}`,
        // Perioden varieras, inte datumet: @@unique([leaseId, year, month, type]).
        month: ((nr - 1) % 12) + 1,
        year: 2026,
        amount: BELOPP,
        totalAmount: BELOPP,
        vatAmount: 0,
        dueDate: new Date(Date.now() - 30 * DYGN), // förbi tröskeln 19
        status: 'OVERDUE',
        collectionStage: 'REMINDED',
        sentAt: new Date(Date.now() - 40 * DYGN),
        reminderPdfStorageKey: 'r2/x.pdf',
      },
      select: { id: true },
    })

    const konton = await prisma.account.findMany({
      where: { organizationId: orgId, number: { in: [1510, 3911] } },
      select: { id: true, number: true },
    })
    const konto = (n: number) => konton.find((k) => k.number === n)!.id
    await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: new Date(),
        description: `Hyresfordran ${sfx}`,
        source: 'RENT_NOTICE',
        sourceId: `rent-notice:${notice.id}`,
        fiscalYear: 2026,
        // HÖGT nummer med flit: verifikationsnummer allokeras ur
        // JournalEntrySequence som börjar på 1, och krediteringens eget
        // verifikat hade krockat med ett handskrivet 1/2/3 på
        // @@unique([organizationId, series, fiscalYear, verNumber]).
        verNumber: 900000 + nr,
        lines: {
          create: [
            { accountId: konto(1510), debit: BELOPP, description: 'fordran' },
            { accountId: konto(3911), credit: BELOPP, description: 'intäkt' },
          ],
        },
      },
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
    await prisma.rentNoticeEvent.create({
      data: {
        rentNoticeId: notice.id,
        type: 'EMAIL_DELIVERED',
        actorType: 'SYSTEM',
        sendId: send.id,
      },
    })
    return notice.id
  }

  /** Kör kravtrappans cron N dygn; åldern flyttas genom att dueDate backas. */
  async function körCron(dygn: number): Promise<void> {
    for (let i = 0; i < dygn; i++) {
      await reminder.escalateRemindedToInkassoReady()
      await prisma.$executeRawUnsafe(
        `UPDATE "RentNotice" SET "dueDate" = "dueDate" - interval '1 day' WHERE "organizationId" = $1`,
        orgId,
      )
    }
  }

  async function blockeringar(id: string): Promise<number> {
    const ev = await prisma.rentNoticeEvent.findMany({
      where: { rentNoticeId: id, type: 'NOTE_ADDED' },
      select: { payload: true },
    })
    return ev.filter(
      (e) => (e.payload as { action?: string } | null)?.action === 'inkasso-ready-blocked',
    ).length
  }

  it('HELKREDIT: avin lämnar kravtrappan direkt, och cronen ser den inte igen', async () => {
    const id = await avi()

    await credits.createCredit(id, orgId, userId, {
      lines: [{ amount: BELOPP }],
      reason: 'Hyran var felaktigt debiterad',
    })

    // Steget nollas i SAMMA transaktion som krediteringen — inte av cronen.
    const direkt = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true, status: true },
    })
    expect(direkt.collectionStage).toBe('NONE')
    // STATUS RÖRS INTE: skulden förblir ett beräknat tillstånd.
    expect(direkt.status).toBe('OVERDUE')

    await körCron(N_DYGN)

    const efter = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true },
    })
    expect(efter.collectionStage).toBe('NONE')
    // FÖRE ÄNDRINGEN: 3 — en blockering per dygn, för alltid.
    expect(await blockeringar(id)).toBe(0)

    const status = await reminder.collectionStatus(id, orgId, new Date())
    expect(status.state).toBe('NOT_APPLICABLE')
  }, 60_000)

  it('DEN OMVÄNDA RIKTNINGEN — DELKREDIT lämnar kravtrappan orörd', async () => {
    const id = await avi()

    await credits.createCredit(id, orgId, userId, {
      lines: [{ amount: 4000 }],
      reason: 'Delvis felaktig debitering',
    })

    const direkt = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true },
    })
    // Skuld kvar → ärendet hör fortfarande hemma i kravtrappan. En spärr som
    // nollar steget vid VARJE kreditering hade varit grön i provet ovan.
    expect(direkt.collectionStage).toBe('REMINDED')

    await körCron(1)

    const efter = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { collectionStage: true },
    })
    // Underlaget är komplett och skulden 5 000 kr → cronen eskalerar som den ska.
    expect(efter.collectionStage).toBe('INKASSO_READY')
  }, 60_000)

  it('CREDITED-eventet bär om avin lämnade kravtrappan', async () => {
    const id = await avi()
    await credits.createCredit(id, orgId, userId, {
      lines: [{ amount: BELOPP }],
      reason: 'Hel nedsättning',
    })

    const ev = await prisma.rentNoticeEvent.findFirstOrThrow({
      where: { rentNoticeId: id, type: 'CREDITED' },
      select: { payload: true },
    })
    // Ingen egen händelsetyp — ingen av betalvägarna skriver en för utträdet.
    // Flaggan i payloaden gör det ändå frågbart.
    expect((ev.payload as { collectionStageCleared?: boolean }).collectionStageCleared).toBe(true)
  }, 60_000)
})
