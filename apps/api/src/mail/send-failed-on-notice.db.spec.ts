/**
 * ETT UTSKICK SOM GER UPP MÅSTE SYNAS PÅ AVIN — mot riktig Postgres.
 *
 * ── VAD MÄTNINGEN VISADE ────────────────────────────────────────────────────
 *
 * `FailedEmail` fick sin koppling till avin i #651 och den FYLLS. Men mätt
 * 2026-09-02: noll läsare i `src/`, noll rader i produktion. Det är den
 * operativa raden — jobId, payload, antal försök — för den som felsöker kön.
 *
 * Domänraden saknades. `SEND_FAILED` skrevs bara vid SYNKRONA fel: hyresgäst
 * utan e-post, eller ett köande som självt kastade. Ett Bull-jobb som gjorde
 * slut på sina försök lämnade INGET spår på avin, och ett ärende som stod
 * stilla i REMINDED gick därför inte att förklara i den vy (#648) som finns för
 * just den frågan.
 *
 * ── INGEN GRIND ÄNDRAS ──────────────────────────────────────────────────────
 *
 * INV-B läser SENT, EMAIL_DELIVERED och EMAIL_BOUNCED — inte SEND_FAILED.
 * Raden är upplysning, inte beslut. Det hålls fast av ett BETEENDEprov i
 * `avisering/rent-collection-status.db.spec.ts`, som har fullt INV-B-underlag.
 *
 * Det stod först här som en källtextkontroll och var RÖTT direkt — av en
 * kommentar inne i grinden som nämner `SEND_FAILED`. En kontroll som läser
 * prosa mäter prosan; frågan flyttades till ett prov som mäter utfallet.
 *
 * ── VAD PROVEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att Bull verkligen avfyrar `failed` exakt en gång för sista försöket. Proven
 * anropar handlern direkt. Dubblettskyddet mäts därför genom att anropa den två
 * gånger — vilket är strängare än verkligheten, inte svagare.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { Job } from 'bull'

import { PrismaService } from '../common/prisma/prisma.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { MailWorkerNormal } from './mail.worker'

import type { MailJobPayload } from './mail.types'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('SEND_FAILED när kön ger upp', () => {
  let prisma: PrismaClient
  let worker: MailWorkerNormal
  let orgId: string
  let tenantId: string
  let leaseId: string
  let propertyId: string
  let noticeId: string
  let räknare = 0

  /** Ett Bull-jobb som gjort slut på sina försök. */
  const jobb = (over: { id?: string; correlation?: MailJobPayload['correlation'] } = {}) =>
    ({
      id: over.id ?? 'job-1',
      attemptsMade: 3,
      opts: { attempts: 3 },
      queue: { name: 'mail-normal' },
      data: {
        template: 'rent-reminder',
        to: 'h@example.se',
        subject: 'Påminnelse',
        ...(over.correlation ? { correlation: over.correlation } : {}),
      },
    }) as unknown as Job<MailJobPayload>

  const händelser = (typ: string) =>
    prisma.rentNoticeEvent.findMany({
      where: { rentNoticeId: noticeId, type: typ as never },
      select: { payload: true },
    })

  beforeAll(async () => {
    prisma = new PrismaClient()
    const p = prisma as unknown as PrismaService
    worker = new MailWorkerNormal(
      { render: jest.fn() } as never,
      p,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      new RentNoticeEventsService(p),
    )

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `sf-${sfx}`,
        email: `sf-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `sf-t-${sfx}@example.se` },
      select: { id: true },
    })
    tenantId = tenant.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `SF ${sfx}`,
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
    await prisma.failedEmail.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
    const n = ++räknare
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${2000000 + n}`,
        month: ((n - 1) % 12) + 1,
        year: 2026 + Math.floor((n - 1) / 12),
        amount: 9000,
        totalAmount: 9000,
        dueDate: new Date('2026-08-31'),
        status: 'OVERDUE',
        collectionStage: 'REMINDED',
      },
      select: { id: true },
    })
    noticeId = notice.id
  })

  afterAll(async () => {
    await prisma.failedEmail.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { propertyId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('ett SLUTGILTIGT misslyckande skriver SEND_FAILED på avin', async () => {
    await worker.onFailed(
      jobb({ correlation: { kind: 'rent-notice-reminder', rentNoticeId: noticeId } }),
      new Error('SMTP 550 mailbox unavailable'),
    )

    const rader = await händelser('SEND_FAILED')
    expect(rader).toHaveLength(1)
    expect(rader[0]!.payload).toMatchObject({
      jobId: 'job-1',
      reason: 'SMTP 550 mailbox unavailable',
    })
  })

  it('och FailedEmail-raden pekar på samma avi — båda halvorna, inte den ena', async () => {
    await worker.onFailed(
      jobb({ correlation: { kind: 'rent-notice-reminder', rentNoticeId: noticeId } }),
      new Error('boom'),
    )
    const fel = await prisma.failedEmail.findMany({ where: { rentNoticeId: noticeId } })
    expect(fel).toHaveLength(1)
  })

  it('SAMMA jobb två gånger → EN händelse (append-only tål ingen dubblett)', async () => {
    const j = jobb({ correlation: { kind: 'rent-notice-reminder', rentNoticeId: noticeId } })
    await worker.onFailed(j, new Error('boom'))
    await worker.onFailed(j, new Error('boom'))
    expect(await händelser('SEND_FAILED')).toHaveLength(1)
  })

  it('TVÅ OLIKA jobb → TVÅ händelser (spärren är inte för grov)', async () => {
    // Den obligatoriska andra riktningen. Två verkliga utskicksförsök som båda
    // gav upp är två upplysningar, och att äta den andra hade dolt ett fel.
    const k = { kind: 'rent-notice-reminder' as const, rentNoticeId: noticeId }
    await worker.onFailed(jobb({ id: 'job-A', correlation: k }), new Error('a'))
    await worker.onFailed(jobb({ id: 'job-B', correlation: k }), new Error('b'))
    expect(await händelser('SEND_FAILED')).toHaveLength(2)
  })

  it('ett brev UTAN avi-korrelation skriver ingen händelse alls', async () => {
    await worker.onFailed(jobb({ id: 'job-X' }), new Error('boom'))
    expect(await händelser('SEND_FAILED')).toHaveLength(0)
  })
})
