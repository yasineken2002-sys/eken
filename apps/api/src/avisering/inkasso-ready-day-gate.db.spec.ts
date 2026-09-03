/**
 * FRISTEN INNAN INKASSO — grinden i METODEN, inte hos anroparen.
 *
 * ── VAD SOM MÄTTES ─────────────────────────────────────────────────────────
 *
 * Ålderskontrollen låg i cron-loopen. Uppmätt (#648) på en avi som var 8 dygn
 * förfallen mot en tröskel på 19:
 *
 *     via CRON      stage=REMINDED       state=WAITING, 11 dygn kvar
 *     via METODEN   flipped=true         stage=INKASSO_READY
 *
 * Alltså: ett formellt inkassokrav mot en gäldenär som hade elva dygn kvar av
 * sin frist — om någon anropade metoden direkt. I dag fanns bara EN anropare,
 * så det var latent och inte trasigt; men det är samma form som DEPOSIT-noten
 * i tjänsten varnar för, och skillnaden mellan latent och trasigt är en ny
 * anropare.
 *
 * ── VARFÖR DB OCH INTE EN ATTRAPP ──────────────────────────────────────────
 *
 * Frågan är vad som HÄNDER med raden, inte vilket värde en funktion råkar
 * returnera. En attrapp hade kunnat svara `flipped=false` med ett kravsteg som
 * ändå flippades i skrivningen efteråt.
 *
 * ── VAD PROVET INTE KAN SE ─────────────────────────────────────────────────
 *
 *  • Att cronen kallar metoden med rätt klocka. Det ägs av cron-provet; här
 *    skickas `now` in explicit, vilket är hela poängen med parametern.
 *  • INV-B:s tio krav. De prövas av `rent-reminder.service.spec.ts` och av
 *    grindens egna prov — fixturen här är komplett så att ENDAST åldern kan
 *    fälla eller släppa.
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
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentReminderService } from './rent-reminder.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const DYGN = 24 * 60 * 60 * 1000
const BELOPP = 9000
/** Tröskeln fixturen sätter: 5 + 14. Skrivs ut i provnamnen. */
const TROSKEL = 19
/** Samtidigheten riggen skapar mot Postgres. */
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
})

medDb('dagsgrinden i escalateNoticeToInkassoReady', () => {
  let prisma: PrismaClient
  let service: RentReminderService
  let orgId: string
  let tenantId: string
  let propertyId: string
  let leaseId: string
  let räknare = 0

  /** Fast klocka — provet ska inte kunna drifta med kalendern (#690/#694). */
  const NU = new Date('2026-09-01T12:00:00.000Z')

  beforeAll(async () => {
    const url = urlMedPool(process.env.DATABASE_URL as string, POOL)
    const satt = Number(new URL(url).searchParams.get('connection_limit'))
    if (!(satt > N)) {
      throw new Error(
        `POOL, INTE GRIND: connection_limit=${satt} är inte större än N=${N}. ` +
          'Prismas default är nproc×2+1. Med en pool mindre än samtidigheten dör ' +
          'transaktionen av maxWait innan den hinner skriva — ett utfall som ser ' +
          'ut som att grinden vägrade. Riggen sätter poolen själv: får du det ' +
          'här felet är POOL-konstanten fel.',
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
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `frist-${sfx}`,
        email: `frist-${sfx}@example.se`,
        street: 'Gatan 1',
        city: 'Stad',
        postalCode: '11111',
        orgNumber: `5560${sfx.slice(0, 6)}`,
        remindersEnabled: true,
        rentReminderDay: 5,
        rentInkassoDaysAfterReminder: 14,
        paymentDataThrough: null,
      },
      select: { id: true },
    })
    orgId = org.id
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
        propertyDesignation: `FRI ${sfx}`,
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
    // FK-riktning: barnen först.
    const ids = (
      await prisma.rentNotice.findMany({ where: { organizationId: orgId }, select: { id: true } })
    ).map((n) => n.id)
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNoticeId: { in: ids } } })
    await prisma.rentNoticeSend.deleteMany({ where: { rentNoticeId: { in: ids } } })
    await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
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
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /** En avi i REMINDED med komplett INV-B-underlag — bara åldern varierar. */
  async function avi(dagarFörfallen: number): Promise<string> {
    const nr = ++räknare
    const sfx = randomUUID().slice(0, 8)
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${sfx}`,
        ocrNumber: `${4000000 + nr}`,
        month: ((nr - 1) % 12) + 1,
        year: 2026,
        amount: BELOPP,
        totalAmount: BELOPP,
        vatAmount: 0,
        dueDate: new Date(NU.getTime() - dagarFörfallen * DYGN),
        status: 'OVERDUE',
        collectionStage: 'REMINDED',
        sentAt: new Date(NU.getTime() - 60 * DYGN),
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

  const stage = async (id: string) =>
    (
      await prisma.rentNotice.findUniqueOrThrow({
        where: { id },
        select: { collectionStage: true },
      })
    ).collectionStage

  it(`8 dygn mot tröskeln ${TROSKEL}: metoden anropad DIREKT vägrar`, async () => {
    const id = await avi(8)

    const res = await service.escalateNoticeToInkassoReady(id, orgId, NU)

    // FÖRE ÄNDRINGEN: flipped=true och stage=INKASSO_READY — uppmätt.
    expect(res.flipped).toBe(false)
    expect(res.tooEarly).toBe(true)
    expect(await stage(id)).toBe('REMINDED')
    // "För tidigt" är inte "ofullständigt underlag". Blandas de ihop letar
    // operatören efter en saknad handling som inte saknas.
    expect(res.missing).toBeUndefined()
  }, 60_000)

  it(`exakt ${TROSKEL} dygn: fristen har löpt ut och avin flippar`, async () => {
    const id = await avi(TROSKEL)

    const res = await service.escalateNoticeToInkassoReady(id, orgId, NU)

    // Randen hör till provet: en grind som råkar vara `<=` i stället för `<`
    // hade hållit avin kvar en dag för länge, och det syns bara här.
    expect(res.flipped).toBe(true)
    expect(await stage(id)).toBe('INKASSO_READY')
  }, 60_000)

  it('KLOCKAN STYR: samma avi, ett now före och ett efter fristen', async () => {
    const id = await avi(TROSKEL)

    // Ett dygn tidigare — samma rad, samma underlag, bara en annan klocka.
    const tidigt = await service.escalateNoticeToInkassoReady(
      id,
      orgId,
      new Date(NU.getTime() - DYGN),
    )
    expect(tidigt.flipped).toBe(false)
    expect(tidigt.tooEarly).toBe(true)
    expect(await stage(id)).toBe('REMINDED')

    // Utan det här andra anropet vore provet ovan förenligt med en grind som
    // aldrig släpper igenom något alls.
    const senare = await service.escalateNoticeToInkassoReady(id, orgId, NU)
    expect(senare.flipped).toBe(true)
    expect(await stage(id)).toBe('INKASSO_READY')
  }, 60_000)
})
