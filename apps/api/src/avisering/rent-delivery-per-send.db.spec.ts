/**
 * LEVERANSIDENTITET PER UTSKICK — mot riktig Postgres.
 *
 * ── PROVET SOM AVGÖR ────────────────────────────────────────────────────────
 *
 * En avi vars FÖRSTA utskick studsade och vars ANDRA levererades ska släppas
 * fram av INV-B. Före #656 kunde den aldrig det: `has('EMAIL_BOUNCED')` läste
 * en append-only-logg, så en studs blockerade för alltid — även efter att
 * adressen rättats och påminnelsen kommit fram.
 *
 * Motprovet står bredvid och är lika viktigt: TVÅ studsade utskick ska
 * fortfarande blockera. Utan det vore "släpp igenom allt" en giltig lösning.
 *
 * ── ENHETEN ÄR HELA POÄNGEN ─────────────────────────────────────────────────
 *
 * `UNIQUE(rentNoticeId, type)` påstod "en avi kan studsa en gång". Med enheten
 * rättad finns ingen tidsstämpel att jämföra och ingen ordning att resonera om
 * — varje utskick bär sitt eget svar, och grinden läser det senaste.
 *
 * ── VAD PROVEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att ett andra utskick faktiskt går att UTLÖSA. Vägen ut ur REMINDED — knappen
 * — är ett eget arbete. Proven här skriver utskicken direkt och mäter grinden,
 * inte utlösaren.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import { RentReminderService } from './rent-reminder.service'
import { RentDebtService } from './rent-debt.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const NU = new Date('2026-09-02T12:00:00.000Z')
const DYGN = 24 * 60 * 60 * 1000

medDb('leveransutfall per utskick', () => {
  let prisma: PrismaClient
  let service: RentReminderService
  let orgId: string
  let tenantId: string
  let leaseId: string
  let propertyId: string
  let räknare = 0

  /** En avi i REMINDED med fullständigt INV-B-underlag utom leveransen. */
  const avi = async () => {
    const nr = ++räknare
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${3000000 + nr}`,
        month: ((nr - 1) % 12) + 1,
        year: 2026 + Math.floor((nr - 1) / 12),
        amount: 9000,
        totalAmount: 9000,
        dueDate: new Date(NU.getTime() - 40 * DYGN),
        status: 'OVERDUE',
        collectionStage: 'REMINDED',
        sentAt: new Date(NU.getTime() - 38 * DYGN),
        reminderPdfStorageKey: 'r2/x.pdf',
      },
      select: { id: true },
    })
    // SENT krävs av INV-B och hör till det första utskicket.
    return n.id
  }

  /** Ett utskick med sitt utfall. Returnerar utskickets id. */
  const utskick = async (
    noticeId: string,
    utfall: 'DELIVERED' | 'BOUNCED' | 'INGET',
    minuterSedan: number,
  ) => {
    const s = await prisma.rentNoticeSend.create({
      data: {
        rentNoticeId: noticeId,
        kind: 'REMINDER',
        createdAt: new Date(NU.getTime() - minuterSedan * 60_000),
      },
      select: { id: true },
    })
    await prisma.rentNoticeEvent.create({
      data: { rentNoticeId: noticeId, type: 'SENT', actorType: 'SYSTEM', sendId: s.id },
    })
    if (utfall !== 'INGET') {
      await prisma.rentNoticeEvent.create({
        data: {
          rentNoticeId: noticeId,
          type: utfall === 'DELIVERED' ? 'EMAIL_DELIVERED' : 'EMAIL_BOUNCED',
          actorType: 'WEBHOOK',
          sendId: s.id,
        },
      })
    }
    return s.id
  }

  const hinder = async (noticeId: string) =>
    (await service.collectionStatus(noticeId, orgId, NU)).missing

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = Object.create(RentReminderService.prototype) as RentReminderService
    Object.assign(service, {
      prisma,
      rentDebt: new RentDebtService(prisma as never),
      freshness: new PaymentFreshnessService(
        prisma as never,
        {
          send: async () => undefined,
        } as never,
      ),
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `lev-${sfx}`,
        email: `lev-${sfx}@example.se`,
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
    const t = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `lev-t-${sfx}@example.se`,
        firstName: 'A',
        lastName: 'B',
        street: 'Gatan 2',
        city: 'Stad',
        postalCode: '11111',
        personalNumberHash: 'hash',
      },
      select: { id: true },
    })
    tenantId = t.id
    const p = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `LEV ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = p.id
    const u = await prisma.unit.create({
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
    const l = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
        unitId: u.id,
        contractNumber: `HK-${sfx}`,
        monthlyRent: 9000,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'DRAFT',
      },
      select: { id: true },
    })
    leaseId = l.id
  }, 30_000)

  beforeEach(async () => {
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNoticeSend.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNoticeSend.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  // ── DEN AVGÖRANDE ────────────────────────────────────────────────────────

  it('STUDSAT först, LEVERERAT sedan → INV-B släpper fram avin', async () => {
    const id = await avi()
    await utskick(id, 'BOUNCED', 120)
    await utskick(id, 'DELIVERED', 10)

    expect(await hinder(id)).toEqual([])
    expect((await service.collectionStatus(id, orgId, NU)).state).toBe('READY')
  })

  it('MOTPROV: TVÅ studsade utskick blockerar fortfarande', async () => {
    // Utan den här vore "släpp igenom allt" en giltig lösning på provet ovan.
    const id = await avi()
    await utskick(id, 'BOUNCED', 120)
    await utskick(id, 'BOUNCED', 10)

    expect(await hinder(id)).toEqual(expect.arrayContaining([expect.stringContaining('studsade')]))
  })

  it('MOTPROV: LEVERERAT först, STUDSAT sedan → blockerar', async () => {
    // Ordningen spelar roll åt BÅDA hållen. En gammal lyckad leverans får inte
    // bära ett senare misslyckat utskick.
    const id = await avi()
    await utskick(id, 'DELIVERED', 120)
    await utskick(id, 'BOUNCED', 10)

    expect(await hinder(id)).toEqual(expect.arrayContaining([expect.stringContaining('studsade')]))
  })

  it('MOTPROV: ett utskick UTAN utfall är inte verifierad leverans', async () => {
    const id = await avi()
    await utskick(id, 'BOUNCED', 120)
    await utskick(id, 'INGET', 10)

    expect(await hinder(id)).toEqual(
      expect.arrayContaining([expect.stringContaining('leverans är inte verifierad')]),
    )
  })

  // ── ENHETEN I DATABASEN ──────────────────────────────────────────────────

  it('TVÅ STUDSAR går nu att REGISTRERA — före #656 svaldes den andra', async () => {
    const id = await avi()
    const a = await utskick(id, 'BOUNCED', 120)
    const b = await utskick(id, 'BOUNCED', 10)
    expect(a).not.toBe(b)

    const studsar = await prisma.rentNoticeEvent.count({
      where: { rentNoticeId: id, type: 'EMAIL_BOUNCED' },
    })
    expect(studsar).toBe(2)
  })

  it('men SAMMA utskick kan bara ha ETT utfall per typ — indexet håller', async () => {
    const id = await avi()
    const s = await utskick(id, 'BOUNCED', 10)
    await expect(
      prisma.rentNoticeEvent.create({
        data: { rentNoticeId: id, type: 'EMAIL_BOUNCED', actorType: 'WEBHOOK', sendId: s },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })

  // ── DE GAMLA RADERNA ─────────────────────────────────────────────────────

  it('en avi FRÅN FÖRE enheten läses med den gamla semantiken', async () => {
    // sendId = '' är sentinelen för "skrevs innan utskicket var en egen enhet".
    // De raderna ska bete sig exakt som förut: en av varje typ, och grinden
    // läser dem eftersom avin saknar utskicksrader.
    const id = await avi()
    await prisma.rentNoticeEvent.createMany({
      data: [
        { rentNoticeId: id, type: 'SENT', actorType: 'SYSTEM' },
        { rentNoticeId: id, type: 'EMAIL_BOUNCED', actorType: 'WEBHOOK' },
      ],
    })
    expect(await hinder(id)).toEqual(expect.arrayContaining([expect.stringContaining('studsade')]))
  })

  it('och sentinelen kolliderar med sig själv — skyddet för dem är kvar', async () => {
    const id = await avi()
    await prisma.rentNoticeEvent.create({
      data: { rentNoticeId: id, type: 'EMAIL_BOUNCED', actorType: 'WEBHOOK' },
    })
    await expect(
      prisma.rentNoticeEvent.create({
        data: { rentNoticeId: id, type: 'EMAIL_BOUNCED', actorType: 'WEBHOOK' },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  })
})
