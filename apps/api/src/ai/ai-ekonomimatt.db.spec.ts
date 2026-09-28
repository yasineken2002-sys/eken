/**
 * AI:s ekonomiska mått mot RIKTIG Postgres — förväntad månadshyra (F01) och
 * betalda fakturors total per svensk kalenderdag (F02).
 *
 * ── VAD SPECEN MÄTER ────────────────────────────────────────────────────────
 *
 * F01: `DataContextService.buildContext` med produktionens kollaboratörer.
 * "Förväntad månadshyra" ska vara Σ monthlyRent över ALLA organisationens
 * aktiva avtal, medan detaljlistan får vara ett urval om högst 30. Talen
 * 0/1/30/31/500 är valda så att 31 och 500 bara blir rätt om summan är
 * oberoende av listtaket: varje avtal har en unik hyra (10 000 + i) och det
 * ÄLDSTA (i = 1) är det som faller ur listan.
 *
 * F02: `get_revenue_report`, `compare_revenue` och `get_dashboard_stats` via
 * `executeTool`. Datumen är hela svenska kalenderdagar (Europe/Stockholm) med
 * båda ändpunkter inkluderade. Fixturerna ligger på exakt de ögonblick där en
 * UTC-avgränsning och en svensk avgränsning ger olika svar: sista
 * millisekunden, UTC-juli som är svensk augusti, och de två DST-dygnen.
 *
 * Måtten hålls isär med SEPARATA fixturer: avtalad hyra, bokförd intäkt,
 * betalda fakturors total, registrerade betalningar (allokeringar) och
 * kvarvarande skuld har olika tal här, och verktygen ska bara rapportera ett
 * av dem. Hyresavin och dess delbetalning finns med för att exkluderingen ska
 * synas, inte för att måttet ska räkna dem.
 *
 * ── VAD SPECEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Den mäter vad modellen FÅR (kontexttext, verktygssvar), inte vad en modell
 * säger. Ingen språkmodell anropas. Processens tidszon påverkar inte
 * förväntningarna; att det håller i en icke-svensk zon bevisas genom att köra
 * specen i en SEPARAT process med TZ satt utanför Sverige — att sätta
 * `process.env.TZ` inne i Jest bevisar inte det.
 *
 * Tjänsten instansieras via `Object.create` med bara de kollaboratörer
 * läsverktygen rör, av samma skäl som i effect-trace-production-path.db.spec:
 * en positionell uppräkning av konstruktorn blir röd av fel skäl. Metodkroppen
 * är produktionens.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

// StorageService drar in @aws-sdk (ESM) via tool-executor → invoices.service →
// pdf.service. Ingen av vägarna som mäts rör dem.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Logger } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { OverdueDebtService } from '../overdue/overdue-debt.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { AiAuditService } from './audit/ai-audit.service'
import { DataContextService } from './data-context.service'
import { ToolExecutorService } from './tools/tool-executor.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

// Råutdata för granskning, bara när AI_EKONOMIMATT_OUT är satt. Påverkar inga utfall.
const UT = process.env.AI_EKONOMIMATT_OUT
const skriv = (namn: string, data: unknown) => {
  if (!UT) return
  mkdirSync(UT, { recursive: true })
  writeFileSync(
    `${UT}/${namn}`,
    typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n',
  )
}

const kr = (n: number) =>
  new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(n)
const radMed = (text: string, prefix: string) => text.split('\n').find((l) => l.startsWith(prefix))
const belopp = (rad: string | undefined) => (rad ? Number(rad.replace(/[^\d-]/g, '')) : NaN)

let prisma: PrismaService
let accounting: AccountingService
let context: DataContextService
let executor: ToolExecutorService
const skapadeOrgar: string[] = []

async function nyOrg(namn: string) {
  const sfx = randomUUID().slice(0, 8)
  const org = await prisma.organization.create({
    data: {
      name: namn,
      email: `em-${sfx}@example.invalid`,
      street: 'Provgatan 1',
      city: 'Provstad',
      postalCode: '111 22',
    },
  })
  skapadeOrgar.push(org.id)
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `em-${sfx}@example.invalid`,
      passwordHash: 'x',
      firstName: 'Syn',
      lastName: 'Tetisk',
      role: 'OWNER',
    },
  })
  const prop = await prisma.property.create({
    data: {
      organizationId: org.id,
      name: 'P',
      propertyDesignation: `EM ${sfx}:1`,
      type: 'RESIDENTIAL',
      street: 'Provgatan 1',
      city: 'Provstad',
      postalCode: '111 22',
      totalArea: 1000,
    },
  })
  return { orgId: org.id, userId: user.id, propId: prop.id }
}

/**
 * `antal` avtal med enhetsnamnet `${tagg}-${i}`, i = 1..antal, och
 * `createdAt = t0 + i minuter` — i = 1 är alltså det ÄLDSTA avtalet.
 */
async function avtal(
  orgId: string,
  propId: string,
  antal: number,
  hyra: (i: number) => number,
  status: 'ACTIVE' | 'TERMINATED',
  tagg: string,
) {
  if (!antal) return
  const t0 = new Date('2026-01-01T00:00:00Z').getTime()
  const idx = Array.from({ length: antal }, (_, k) => k + 1)
  const units = idx.map((i) => ({
    id: randomUUID(),
    propertyId: propId,
    name: `${tagg}-${i}`,
    unitNumber: `${tagg}-${i}`,
    type: 'APARTMENT' as const,
    area: 50,
    monthlyRent: hyra(i),
  }))
  const tenants = idx.map(() => ({
    id: randomUUID(),
    organizationId: orgId,
    type: 'INDIVIDUAL' as const,
    email: `${randomUUID()}@example.invalid`,
    firstName: 'H',
    lastName: tagg,
  }))
  await prisma.unit.createMany({ data: units })
  await prisma.tenant.createMany({ data: tenants })
  await prisma.lease.createMany({
    data: idx.map((i, k) => ({
      organizationId: orgId,
      unitId: units[k]!.id,
      tenantId: tenants[k]!.id,
      startDate: new Date('2025-01-01'),
      tenancyStartDate: new Date('2025-01-01'),
      monthlyRent: hyra(i),
      depositAmount: 0,
      status,
      createdAt: new Date(t0 + i * 60_000),
    })),
  })
}

async function städa(orgId: string) {
  await prisma.invoicePayment.deleteMany({ where: { invoice: { organizationId: orgId } } })
  await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
  await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
  await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
  await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
  await prisma.account.deleteMany({ where: { organizationId: orgId } })
  await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: orgId } } })
  await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
  await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
  await prisma.lease.deleteMany({ where: { organizationId: orgId } })
  await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
  await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
  await prisma.property.deleteMany({ where: { organizationId: orgId } })
  await prisma.user.deleteMany({ where: { organizationId: orgId } })
  // Auditraden skrivs med `void` och kan landa efter testet (se
  // effect-trace-production-path.db.spec) — därför radera-och-försök-igen.
  for (let försök = 1; ; försök++) {
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    try {
      await prisma.organization.delete({ where: { id: orgId } })
      break
    } catch (err) {
      if (försök >= 5) throw err
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

beforeAll(() => {
  if (!HAR_DB) return
  prisma = new PrismaService()
  const verifikationsnummer = new VerifikationsnummerService(prisma)
  accounting = new AccountingService(prisma, verifikationsnummer)
  context = new DataContextService(prisma, new OverdueDebtService(prisma), accounting)
  executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
  Object.assign(executor, {
    prisma,
    audit: new AiAuditService(prisma),
    accountingService: accounting,
    verifikationsnummer,
    logger: new Logger('ToolExecutorService'),
  })
  skriv('PROCESS.json', {
    envTZ: process.env.TZ ?? null,
    intlTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMin_2026_01_15: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
    offsetMin_2026_07_15: new Date('2026-07-15T12:00:00Z').getTimezoneOffset(),
  })
})

afterAll(async () => {
  if (!HAR_DB) return
  for (const id of skapadeOrgar) await städa(id)
  await prisma.$disconnect()
})

// ─── F01 ────────────────────────────────────────────────────────────────────

medDb('F01 — förväntad månadshyra gäller HELA mängden aktiva avtal', () => {
  const FALL = [0, 1, 30, 31, 500] as const
  const LISTTAK = 30
  const mätt = new Map<number, { text: string; dbSumma: number; dbAntal: number }>()

  beforeAll(async () => {
    for (const N of FALL) {
      const egen = await nyOrg(`EM-F01-N${N}`)
      await avtal(egen.orgId, egen.propId, N, (i) => 10_000 + i, 'ACTIVE', `EMA${N}`)
      await avtal(egen.orgId, egen.propId, 3, () => 777_777, 'TERMINATED', `EMT${N}`)
      const främmande = await nyOrg(`EM-F01-X${N}`)
      await avtal(främmande.orgId, främmande.propId, 5, () => 888_888, 'ACTIVE', `EMX${N}`)

      const agg = await prisma.lease.aggregate({
        where: { organizationId: egen.orgId, status: 'ACTIVE' },
        _sum: { monthlyRent: true },
        _count: { id: true },
      })
      const text = await context.buildContext(egen.orgId)
      skriv(`F01-N${N}-kontext.txt`, text)
      mätt.set(N, { text, dbSumma: Number(agg._sum.monthlyRent ?? 0), dbAntal: agg._count.id })
    }
  }, 180_000)

  const facit = (N: number) => N * 10_000 + (N * (N + 1)) / 2
  const kontraktsdel = (text: string) =>
    text.split('## AKTIVA KONTRAKT')[1]?.split('\n## ')[0] ?? ''
  const listadeIndex = (text: string, N: number) =>
    [...kontraktsdel(text).matchAll(new RegExp(`→ EMA${N}-(\\d+) `, 'g'))].map((m) => Number(m[1]))

  it.each(FALL)('N=%i instrument: DB-facit är exakt den konstruerade mängden', (N) => {
    const m = mätt.get(N)!
    expect({ summa: m.dbSumma, antal: m.dbAntal }).toEqual({ summa: facit(N), antal: N })
  })

  it.each(FALL)('N=%i: "Förväntad månadshyra" = Σ ALLA aktiva avtal', (N) => {
    const m = mätt.get(N)!
    const rad = radMed(m.text, 'Förväntad månadshyra (avtalad, aktiva kontrakt): ')
    expect(belopp(rad)).toBe(facit(N))
  })

  it.each(FALL)('N=%i: detaljlistan är ett urval om högst 30, och urvalet sägs ut', (N) => {
    const { text } = mätt.get(N)!
    const index = listadeIndex(text, N)
    expect(index).toHaveLength(Math.min(N, LISTTAK))
    // Senast skapade först: de listade är exakt N, N-1, … (de 30 nyaste).
    expect(index).toEqual(Array.from({ length: Math.min(N, LISTTAK) }, (_, k) => N - k))
    // Det ÄLDSTA avtalet (i = 1) syns i listan bara när allt ryms.
    expect(index.includes(1)).toBe(N >= 1 && N <= LISTTAK)
    const urval = kontraktsdel(text)
      .split('\n')
      .find((l) => l.includes('Urval:'))
    if (N > LISTTAK) {
      expect(urval).toContain(`visar de ${LISTTAK} senast skapade av ${N} aktiva kontrakt`)
      expect(urval).toContain(`gäller alla ${N}`)
    } else {
      expect(urval).toBeUndefined()
    }
  })

  it.each(FALL)('N=%i: avslutade och främmande avtal ingår varken i summa eller lista', (N) => {
    const { text } = mätt.get(N)!
    expect(text).not.toMatch(new RegExp(`EMT${N}-\\d`))
    expect(text).not.toMatch(new RegExp(`EMX${N}-\\d`))
    // Hela formaterade belopp — inte delsträngar som kan träffa ett UUID.
    expect(text).not.toContain(kr(777_777))
    expect(text).not.toContain(kr(888_888))
  })
})

// ─── F02 ────────────────────────────────────────────────────────────────────

type Svar = { success: boolean; message: string; data?: Record<string, unknown> }
type Mått = { id: string; excludes: string[]; scope?: string }
type MåttData = {
  measure: Mått
  period: Record<string, unknown>
  totalPaidRevenue: number
  totalPaidRevenueMeasure: Mått
}
const måttData = (s: Svar) => s.data as unknown as MåttData

medDb('F02 — betalda fakturors total per HELA svenska kalenderdagar', () => {
  let orgId = ''
  let userId = ''
  let xOrgId = ''
  let tenantId = ''
  let leaseId = ''

  // Tagg → [paidAt (UTC), belopp, issueDate]. Beloppen är potenser så att varje
  // summa avslöjar exakt vilka rader som räknats.
  const PAID: Record<string, [string, number, string]> = {
    A: ['2026-07-31T21:59:59.999Z', 1, '2026-07-10'], // 07-31 23:59:59.999 CEST
    B: ['2026-07-31T22:00:00.000Z', 10, '2026-08-10'], // 08-01 00:00 CEST (UTC-juli)
    C: ['2026-08-15T10:00:00.000Z', 100, '2026-08-10'],
    D: ['2026-08-31T21:59:59.999Z', 1_000, '2026-08-10'], // 08-31, sista millisekunden
    E: ['2026-08-31T22:00:00.000Z', 10_000, '2026-08-10'], // 09-01 00:00 CEST
    W1: ['2026-10-24T22:30:00.000Z', 20_000, '2026-10-10'], // 10-25 00:30 CEST
    W2: ['2026-10-25T22:59:59.999Z', 40_000, '2026-10-10'], // 10-25 23:59:59.999 CET
    W3: ['2026-10-25T23:00:00.000Z', 80_000, '2026-10-10'], // 10-26 00:00 CET
    S1: ['2026-03-28T23:00:00.000Z', 160_000, '2026-03-10'], // 03-29 00:00 CET
    S2: ['2026-03-29T21:59:59.999Z', 320_000, '2026-03-10'], // 03-29 23:59:59.999 CEST
    S3: ['2026-03-29T22:00:00.000Z', 640_000, '2026-03-10'], // 03-30 00:00 CEST
  }
  const SUMMA_ALLA_PAID = Object.values(PAID).reduce((s, [, b]) => s + b, 0)
  // Svenska augusti som ögonblick, oberoende av produktkoden.
  const AUG = { gte: new Date('2026-07-31T22:00:00Z'), lt: new Date('2026-08-31T22:00:00Z') }

  const kör = async (verktyg: string, input: Record<string, unknown>, org = orgId) =>
    (await executor.executeTool(
      verktyg,
      input,
      org,
      { kind: 'USER', id: userId },
      'OWNER',
    )) as unknown as Svar
  const rev = (from: unknown, to: unknown, org?: string) =>
    kör('get_revenue_report', { from, to }, org)

  async function faktura(
    nr: string,
    total: number,
    status: 'PAID' | 'SENT' | 'PARTIAL',
    issue: string,
    paidAt: string | null,
    org = orgId,
    tenant = tenantId,
  ) {
    const inv = await prisma.invoice.create({
      data: {
        organizationId: org,
        invoiceNumber: nr,
        type: 'SERVICE',
        status,
        tenantId: tenant,
        subtotal: total,
        vatTotal: 0,
        total,
        issueDate: new Date(issue),
        dueDate: new Date('2026-12-31'),
        paidAt: paidAt ? new Date(paidAt) : null,
        lines: {
          create: [
            { description: `Syntetisk ${nr}`, quantity: 1, unitPrice: total, vatRate: 0, total },
          ],
        },
      },
      include: { lines: true },
    })
    return inv
  }

  beforeAll(async () => {
    const egen = await nyOrg('EM-F02')
    orgId = egen.orgId
    userId = egen.userId
    await accounting.seedDefaultAccounts(orgId)
    await avtal(orgId, egen.propId, 1, () => 10_000, 'ACTIVE', 'EML')
    const lease = await prisma.lease.findFirstOrThrow({ where: { organizationId: orgId } })
    tenantId = lease.tenantId
    leaseId = lease.id

    for (const [tagg, [paidAt, total, issue]] of Object.entries(PAID)) {
      const inv = await faktura(tagg, total, 'PAID', issue, paidAt)
      await prisma.invoicePayment.create({
        data: { invoiceId: inv.id, amount: total, paidAt: new Date(paidAt), source: 'MANUAL' },
      })
      await accounting.createJournalEntryForInvoice(inv, orgId, userId)
    }
    // Bokförd men obetald, och delbetald (PARTIAL) — ingår inte i måttet.
    const sent = await faktura('SENT1', 2_000_000, 'SENT', '2026-08-10', null)
    await accounting.createJournalEntryForInvoice(sent, orgId, userId)
    const partial = await faktura('PART1', 3_000_000, 'PARTIAL', '2026-08-10', null)
    await prisma.invoicePayment.create({
      data: {
        invoiceId: partial.id,
        amount: 1_000_000,
        paidAt: new Date('2026-08-20T10:00:00Z'),
        source: 'MANUAL',
      },
    })
    await accounting.createJournalEntryForInvoice(partial, orgId, userId)
    // Hyresavi aug med delbetalning — hyran går den vägen, men inte in i måttet.
    const rn = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: 'EM-RN1',
        ocrNumber: '7000123',
        month: 8,
        year: 2026,
        amount: 9_000_000,
        vatAmount: 0,
        totalAmount: 9_000_000,
        dueDate: new Date('2026-08-31'),
        status: 'SENT',
        type: 'RENT',
      },
    })
    await accounting.createJournalEntryForRentNotice(rn, orgId, userId)
    await prisma.rentNoticePayment.create({
      data: {
        rentNoticeId: rn.id,
        amount: 4_000_000,
        paidAt: new Date('2026-08-20T10:00:00Z'),
        source: 'MANUAL',
      },
    })

    const x = await nyOrg('EM-F02-X')
    xOrgId = x.orgId
    await avtal(xOrgId, x.propId, 1, () => 1, 'ACTIVE', 'EMXL')
    const xl = await prisma.lease.findFirstOrThrow({ where: { organizationId: xOrgId } })
    await faktura(
      'X1',
      5_000_000,
      'PAID',
      '2026-08-10',
      '2026-08-15T10:00:00Z',
      xOrgId,
      xl.tenantId,
    )
  }, 120_000)

  it('instrument: de fem måtten har var sitt tal i DB', async () => {
    const [paid, invPay, rnPay, obetalt] = await Promise.all([
      prisma.invoice.aggregate({
        where: { organizationId: orgId, status: 'PAID', paidAt: AUG },
        _sum: { total: true },
      }),
      prisma.invoicePayment.aggregate({
        where: { invoice: { organizationId: orgId }, paidAt: AUG },
        _sum: { amount: true },
      }),
      prisma.rentNoticePayment.aggregate({
        where: { rentNotice: { organizationId: orgId }, paidAt: AUG },
        _sum: { amount: true },
      }),
      prisma.invoice.findMany({
        where: { organizationId: orgId, status: { in: ['SENT', 'PARTIAL'] } },
        select: { total: true, payments: { select: { amount: true } } },
      }),
    ])
    const avi = await prisma.rentNotice.findFirstOrThrow({
      where: { organizationId: orgId },
      include: { payments: true },
    })
    const bokfördAug = await accounting.getRevenueTotal(
      orgId,
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-08-31T00:00:00Z'),
    )
    const mått = {
      avtaladHyra: 10_000,
      bokfördIntäktAug: bokfördAug,
      betaldaFakturorAug: Number(paid._sum.total ?? 0),
      registreradeBetalningarAug: Number(invPay._sum.amount ?? 0) + Number(rnPay._sum.amount ?? 0),
      kvarvarandeSkuld:
        obetalt.reduce(
          (s, i) => s + Number(i.total) - i.payments.reduce((a, p) => a + Number(p.amount), 0),
          0,
        ) +
        Number(avi.totalAmount) -
        avi.payments.reduce((a, p) => a + Number(p.amount), 0),
    }
    skriv('F02-DB-FACIT.json', mått)
    expect(mått).toEqual({
      avtaladHyra: 10_000,
      // B, C, D, E (issue aug) + SENT1 + PART1 + avi. E betalas i sept men bokförs i aug.
      bokfördIntäktAug: 10 + 100 + 1_000 + 10_000 + 2_000_000 + 3_000_000 + 9_000_000,
      betaldaFakturorAug: 1_110,
      registreradeBetalningarAug: 1_110 + 1_000_000 + 4_000_000,
      kvarvarandeSkuld: 2_000_000 + 2_000_000 + 5_000_000,
    })
  })

  it('augusti: hela svenska månaden, båda ändpunkterna — sista millisekunden med, UTC-juli med', async () => {
    const svar = await rev('2026-08-01', '2026-08-31')
    skriv('F02-rev-aug.json', svar)
    expect(svar.success).toBe(true)
    expect(svar.data?.totalRevenue).toBe(1_110)
    // Månadsnyckeln följer SVENSKT datum: B (UTC 07-31 22:00) är augusti.
    expect(svar.data?.byMonth).toEqual([{ month: '2026-08', amount: 1_110 }])
  })

  it('juli: sista svenska millisekunden räknas, nästa ögonblick inte', async () => {
    expect((await rev('2026-07-01', '2026-07-31')).data?.totalRevenue).toBe(1)
  })

  it('september: positiv kontroll direkt efter augustigränsen', async () => {
    expect((await rev('2026-09-01', '2026-09-30')).data?.totalRevenue).toBe(10_000)
  })

  it('vintertidsdygnet 2026-10-25 (25 h) är en hel dag', async () => {
    expect((await rev('2026-10-25', '2026-10-25')).data?.totalRevenue).toBe(60_000)
  })

  it('sommartidsdygnet 2026-03-29 (23 h) är en hel dag', async () => {
    expect((await rev('2026-03-29', '2026-03-29')).data?.totalRevenue).toBe(480_000)
  })

  it('tom period ger noll, inte fel', async () => {
    const svar = await rev('2026-06-01', '2026-06-30')
    expect(svar.success).toBe(true)
    expect(svar.data?.totalRevenue).toBe(0)
    expect(svar.data?.byMonth).toEqual([])
  })

  it.each([
    ['omvänd period', '2026-08-31', '2026-08-01'],
    ['datum som inte finns', '2026-02-30', '2026-03-01'],
    ['månad i stället för dag', '2026-08', '2026-08-31'],
    ['tidsstämpel i stället för dag', '2026-08-01T00:00:00Z', '2026-08-31'],
    ['saknat slutdatum', '2026-08-01', undefined],
  ])('%s avvisas begripligt', async (_namn, from, to) => {
    const svar = await rev(from, to)
    expect(svar.success).toBe(false)
    expect(svar.message).toMatch(/YYYY-MM-DD|efter/)
    expect(svar.data).toBeUndefined()
  })

  it('compare_revenue använder samma svenska dagar', async () => {
    const svar = await kör('compare_revenue', {
      period1From: '2026-07-01',
      period1To: '2026-07-31',
      period2From: '2026-08-01',
      period2To: '2026-08-31',
    })
    skriv('F02-compare.json', svar)
    expect(svar.success).toBe(true)
    expect(svar.data).toMatchObject({ total1: 1, total2: 1_110, diff: 1_109 })
  })

  it('compare_revenue avvisar en ogiltig period', async () => {
    const svar = await kör('compare_revenue', {
      period1From: '2026-07-31',
      period1To: '2026-07-01',
      period2From: '2026-08-01',
      period2To: '2026-08-31',
    })
    expect(svar.success).toBe(false)
  })

  it('en främmande organisations betalningar ingår aldrig', async () => {
    expect((await rev('2026-08-01', '2026-08-31', xOrgId)).data?.totalRevenue).toBe(5_000_000)
    const egen = await rev('2026-01-01', '2026-12-31')
    expect(egen.data?.totalRevenue).toBe(SUMMA_ALLA_PAID)
  })

  it('svaret säger vilket mått det är och vad som INTE ingår', async () => {
    const svar = await rev('2026-08-01', '2026-08-31')
    const data = måttData(svar)
    expect(data.measure.id).toBe('PAID_INVOICE_TOTAL')
    expect(JSON.stringify(data.measure.excludes)).toMatch(/[Hh]yresavi/)
    expect(data.period).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-31',
      timeZone: 'Europe/Stockholm',
      inclusive: true,
      fromInstant: '2026-07-31T22:00:00.000Z',
      toExclusiveInstant: '2026-08-31T22:00:00.000Z',
    })
    expect(svar.message).toContain('Betalda fakturors total')
    expect(svar.message).toMatch(/hyresavier/i)
    expect(svar.message).toMatch(/inte bokförd intäkt/i)

    const jämför = await kör('compare_revenue', {
      period1From: '2026-07-01',
      period1To: '2026-07-31',
      period2From: '2026-08-01',
      period2To: '2026-08-31',
    })
    expect(måttData(jämför).measure.id).toBe('PAID_INVOICE_TOTAL')
    expect(jämför.message).toContain('Betalda fakturors total')
  })

  it('get_dashboard_stats: samma mått, oförändrad beräkning, nu etiketterad', async () => {
    const svar = await kör('get_dashboard_stats', {})
    skriv('F02-dashboard.json', svar)
    const data = måttData(svar)
    expect(data.totalPaidRevenue).toBe(SUMMA_ALLA_PAID)
    expect(data.totalPaidRevenueMeasure.id).toBe('PAID_INVOICE_TOTAL')
    expect(data.totalPaidRevenueMeasure.scope).toMatch(/hela tiden/i)
  })

  it('måtten skiljer sig begripligt: kontexten och verktyget säger olika saker om samma org', async () => {
    const text = await context.buildContext(orgId)
    skriv('F02-kontext.txt', text)
    const år = await accounting.getRevenueYearToDate(orgId, new Date())
    expect(radMed(text, 'Förväntad månadshyra')).toBe(
      `Förväntad månadshyra (avtalad, aktiva kontrakt): ${kr(10_000)}`,
    )
    expect(radMed(text, 'Bokförd intäkt i år')).toBe(
      `Bokförd intäkt i år (Σ 3xxx, räkenskapsår-till-idag): ${kr(år.total)}`,
    )
    const verktyget = (await rev('2026-08-01', '2026-08-31')).data?.totalRevenue
    const bokfördAug = await accounting.getRevenueTotal(
      orgId,
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-08-31T00:00:00Z'),
    )
    expect(new Set([10_000, bokfördAug, verktyget, 5_001_110, 9_000_000]).size).toBe(5)
  })
})
