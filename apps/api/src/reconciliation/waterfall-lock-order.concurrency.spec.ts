/**
 * VATTENFALLETS LÅSORDNING UNDER LAST — mot riktig Postgres.
 *
 * ── DEN STÖRSTA OMÄTTA POSTEN ───────────────────────────────────────────────
 *
 * `docs/revision-status.md` bar detta som en UTTRYCKLIG ICKE-MÄTNING: radlås,
 * deterministisk låsordning och transaktionsgränser fanns och var påkopplade,
 * men "att svält faktiskt uteblir under last" var aldrig prövat. Mekanismernas
 * närvaro är ett argument, inte en mätning.
 *
 * ── VAD SOM MÄTS ────────────────────────────────────────────────────────────
 *
 * Låssekvensen speglar `applyWaterfallToRentNotices` i reconciliation.service.ts:
 *
 *   findMany(orderBy [dueDate asc, createdAt asc])
 *     → SELECT … FOR UPDATE i SAMMA ordning
 *       → läs allokeringar per avi
 *         → skriv
 *
 * N matchare arbetar samtidigt mot SAMMA hyresgästs avier, var och en med sin
 * EGEN inbetalning. (Delar de banktransaktion mäter man i stället unikhets-
 * indexet `@@unique([bankTransactionId, rentNoticeId])` — en annan egenskap,
 * och det felet gjordes en gång när riggen byggdes.)
 *
 * ── NEGATIVKONTROLLEN BOR HÄR ───────────────────────────────────────────────
 *
 * Noll timeouts betyder ingenting utan beviset att riggen KAN producera dem.
 * `omvänd` låter varannan arbetare låsa i OMVÄND ordning — enda skillnaden — och
 * kräver deadlock (40P01) eller transaktionstimeout (P2028).
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const ARBETARE = 16
const AVIER = 6
// PAYMENT_TX_LIMITS som literaler — riggen ska mäta låsordningen, inte ärva en
// konstant som kan ändras och tyst göra mätningen till något annat.
const TX = { timeout: 8_000, maxWait: 3_000 } as const

medDb('vattenfallets deterministiska låsordning', () => {
  let prisma: PrismaClient
  const orgar: string[] = []

  beforeAll(() => {
    prisma = new PrismaClient()
  })

  afterAll(async () => {
    // Org-radering kaskaderar inte — städa i beroendeordning.
    for (const orgId of orgar) {
      await prisma.rentNoticePayment.deleteMany({
        where: { rentNotice: { organizationId: orgId } },
      })
      await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
      await prisma.lease.deleteMany({ where: { organizationId: orgId } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
      await prisma.property.deleteMany({ where: { organizationId: orgId } })
      await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.delete({ where: { id: orgId } })
    }
    await prisma.$disconnect()
  }, 60_000)

  async function seed() {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `wf-${sfx}`,
        email: `wf-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgar.push(org.id)
    const prop = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: 'p',
        propertyDesignation: `d-${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        name: 'u',
        unitNumber: `1-${sfx}`,
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 1000,
      },
    })
    const tenant = await prisma.tenant.create({
      data: { organizationId: org.id, type: 'INDIVIDUAL', email: `wf-${sfx}@example.se` },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        tenantId: tenant.id,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        monthlyRent: 1000,
        depositAmount: 0,
      },
    })
    const ocr = `9${sfx.replace(/\D/g, '0').padEnd(9, '0')}`.slice(0, 10)
    for (let i = 0; i < AVIER; i++) {
      await prisma.rentNotice.create({
        data: {
          organizationId: org.id,
          tenantId: tenant.id,
          leaseId: lease.id,
          noticeNumber: `N-${sfx}-${i}`,
          ocrNumber: ocr,
          month: (i % 12) + 1,
          year: 2026,
          amount: 1000,
          totalAmount: 1000,
          dueDate: new Date(2026, i, 27),
          status: 'SENT',
          type: 'RENT',
        },
      })
    }
    // EN banktransaktion PER ARBETARE — det verkliga scenariot.
    const btIds: string[] = []
    for (let w = 0; w < ARBETARE; w++) {
      const bt = await prisma.bankTransaction.create({
        data: { organizationId: org.id, date: new Date(), description: `w${w}`, amount: 1000 },
      })
      btIds.push(bt.id)
    }
    return { orgId: org.id, ocr, btIds }
  }

  function vattenfall(orgId: string, ocr: string, btId: string, omvänd: boolean) {
    return prisma.$transaction(async (tx) => {
      const kandidater = await tx.rentNotice.findMany({
        where: {
          organizationId: orgId,
          ocrNumber: ocr,
          status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
          type: 'RENT',
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      })
      const ordning = omvänd ? [...kandidater].reverse() : kandidater
      for (const k of ordning) {
        await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${k.id} AND "organizationId" = ${orgId} FOR UPDATE`
      }
      for (const k of kandidater) {
        await tx.rentNoticePayment.findMany({
          where: { rentNoticeId: k.id },
          select: { amount: true },
        })
      }
      await tx.rentNoticePayment.create({
        data: {
          rentNoticeId: kandidater[0]!.id,
          bankTransactionId: btId,
          amount: new Prisma.Decimal(1),
          paidAt: new Date(),
          source: 'BANK_RECONCILIATION',
        },
      })
    }, TX)
  }

  async function kör(läge: 'ordnad' | 'omvänd') {
    const { orgId, ocr, btIds } = await seed()
    const res = await Promise.allSettled(
      Array.from({ length: ARBETARE }, (_, i) =>
        vattenfall(orgId, ocr, btIds[i]!, läge === 'omvänd' && i % 2 === 1),
      ),
    )
    const fel: Record<string, number> = {}
    for (const r of res) {
      if (r.status !== 'rejected') continue
      const m = String(r.reason?.message ?? r.reason)
      const kod = /\b40P01\b/.test(m) ? '40P01' : (r.reason?.code ?? 'okänt')
      fel[kod] = (fel[kod] ?? 0) + 1
    }
    return { lyckade: res.filter((r) => r.status === 'fulfilled').length, fel }
  }

  it(`KÄRNAN: ${ARBETARE} samtidiga vattenfall i produktionsordning → alla lyckas, noll P2028`, async () => {
    const r = await kör('ordnad')
    expect(r.lyckade).toBe(ARBETARE)
    expect(r.fel).toEqual({})
  }, 180_000)

  it('och det gäller över flera omgångar, inte bara en lycklig', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await kör('ordnad')
      expect(r.lyckade).toBe(ARBETARE)
    }
  }, 300_000)

  it('NEGATIVKONTROLL: bryts låsordningen ger riggen deadlock eller timeout', async () => {
    // Enda skillnaden mot testet ovan är att varannan arbetare låser baklänges.
    // Utan den här raden är "noll fel" lika förenligt med att riggen inte mäter.
    const r = await kör('omvänd')
    const fällda = (r.fel['40P01'] ?? 0) + (r.fel['P2028'] ?? 0)
    expect(fällda).toBeGreaterThan(0)
    expect(r.lyckade).toBeLessThan(ARBETARE)
  }, 180_000)
})
