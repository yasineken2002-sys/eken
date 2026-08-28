/**
 * MANUELL BETALNING UNDER SAMTIDIGHET — mot riktig Postgres.
 *
 * ── EGENSKAPEN ──────────────────────────────────────────────────────────────
 *
 * `markAsPaidManually` tar `FOR UPDATE` på fakturan (invoices.service.ts) och
 * läser skulden INNANFÖR låset innan `assertPaymentWithinDebt` prövar beloppet.
 * N samtidiga betalningar av hela beloppet ska därför ge EN betalning — de
 * övriga blockerar, läser om, ser restskuld 0 och avvisas.
 *
 * ── VARFÖR MOT RIKTIG POSTGRES ──────────────────────────────────────────────
 *
 * `FOR UPDATE` är databasens mekanism. Utan riktig radlåsning läser alla N
 * samma restskuld och alla N passerar grinden — vilket är precis vad
 * negativkontrollen nedan mäter.
 *
 * ── NEGATIVKONTROLLEN BOR HÄR ───────────────────────────────────────────────
 *
 * "1 betalning av 16" betyder ingenting utan beviset att riggen KAN producera
 * 16. Utan lås och utan grind blir summan 16 × fakturabeloppet — en mätning,
 * inte ett resonemang.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import { assertPaymentWithinDebt } from '../common/payments/payment-within-debt'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const SAMTIDIGA = 16
const TOTAL = 10_000
// Talen bor i common/prisma/transaction-limits.ts. Här står de som literaler med
// flit: riggen ska mäta LÅSET, inte importera en konstant som kan ändras och
// tyst göra mätningen till något annat.
const TX = { timeout: 8_000, maxWait: 3_000 } as const

medDb('markAsPaidManually — radlåset och skuldgrinden under samtidighet', () => {
  let prisma: PrismaClient
  let orgId: string
  let tenantId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `paid-${sfx}`,
        email: `paid-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    // CHECK Invoice_tenant_xor_customer_chk kräver exakt en motpart.
    const t = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `paid-${sfx}@example.se` },
    })
    tenantId = t.id
  }, 30_000)

  afterAll(async () => {
    // Org-radering KASKADERAR INTE (31 Restrict-relationer i schemat) — städa i
    // beroendeordning, annars faller afterAll och sviten blir röd trots gröna
    // tester. Uppmätt: det gjorde den första versionen av den här filen.
    await prisma.invoicePayment.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const nyFaktura = () =>
    prisma.invoice.create({
      data: {
        organizationId: orgId,
        tenantId,
        invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
        type: 'RENT',
        issueDate: new Date(),
        dueDate: new Date(),
        subtotal: TOTAL,
        vatTotal: 0,
        total: TOTAL,
        status: 'SENT',
      },
      select: { id: true },
    })

  /**
   * Speglar `markAsPaidManually`: transaktion → FOR UPDATE → läs allokeringar →
   * grinden → skriv. `skydd: false` tar bort BÅDE låset och grinden, och
   * ingenting annat.
   */
  function betala(invId: string, belopp: number, skydd: boolean) {
    return prisma.$transaction(async (tx) => {
      if (skydd) {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invId} AND "organizationId" = ${orgId} FOR UPDATE`
      }
      const inv = await tx.invoice.findUnique({ where: { id: invId }, select: { total: true } })
      const prior = await tx.invoicePayment.findMany({
        where: { invoiceId: invId },
        select: { amount: true },
      })
      const betalt = prior.reduce((s, p) => s.plus(p.amount), new Prisma.Decimal(0))
      const utestående = new Prisma.Decimal(inv!.total).minus(betalt)
      // DEN RIKTIGA GRINDEN, inte en avskrift. Två kopior av samma regel
      // divergerar, och då mäter riggen sin egen kopia i stället för produktionen.
      if (skydd) assertPaymentWithinDebt(new Prisma.Decimal(belopp), utestående)
      await tx.invoicePayment.create({
        data: { invoiceId: invId, amount: belopp, paidAt: new Date(), source: 'MANUAL' },
      })
    }, TX)
  }

  async function kör(skydd: boolean) {
    const { id } = await nyFaktura()
    const res = await Promise.allSettled(
      Array.from({ length: SAMTIDIGA }, () => betala(id, TOTAL, skydd)),
    )
    const rader = await prisma.invoicePayment.findMany({
      where: { invoiceId: id },
      select: { amount: true },
    })
    return {
      lyckade: res.filter((r) => r.status === 'fulfilled').length,
      rader: rader.length,
      summa: rader.reduce((s, p) => s.plus(p.amount), new Prisma.Decimal(0)).toNumber(),
    }
  }

  it(`KÄRNAN: ${SAMTIDIGA} samtidiga betalningar av hela beloppet → EN betalning`, async () => {
    const r = await kör(true)
    expect(r.lyckade).toBe(1)
    expect(r.rader).toBe(1)
    expect(r.summa).toBe(TOTAL)
  }, 120_000)

  it('fakturan blir aldrig överbetald', async () => {
    const r = await kör(true)
    expect(r.summa).toBeLessThanOrEqual(TOTAL)
  }, 120_000)

  it(`NEGATIVKONTROLL: utan lås och grind blir summan ${SAMTIDIGA} × ${TOTAL}`, async () => {
    // Det uppmätta överbetalningsbeloppet. Utan den här raden är "1 betalning"
    // lika förenligt med att riggen kör sekventiellt.
    const r = await kör(false)
    expect(r.lyckade).toBe(SAMTIDIGA)
    expect(r.summa).toBe(SAMTIDIGA * TOTAL)
  }, 120_000)
})
