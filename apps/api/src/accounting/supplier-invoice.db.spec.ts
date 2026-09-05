/**
 * LEVERANTÖRSSKULDEN MOT RIKTIG POSTGRES — 2440 ska netta till NOLL.
 *
 * ── VARFÖR INTE MOT EN ATTRAPP ──────────────────────────────────────────────
 *
 * Invarianten är en SUMMA över två verifikat skrivna vid två tidpunkter. En
 * attrapp returnerar det den blev tillsagd att returnera och kan visa att koden
 * ANROPAR något; den kan inte visa att raderna i huvudboken tar ut varandra.
 * Och idempotensen är databasens egenskap: det unika indexet
 * `(organizationId, source, sourceId)` är det som gör att ett omtag ger EN post.
 *
 * ── DEN ANDRA RIKTNINGEN ────────────────────────────────────────────────────
 *
 * Två OLIKA fakturor ska ge två skulder. En för grov nyckel hade tystat den
 * andra som en dubblett — och det är den riktning en mockad `findFirst` inte kan
 * pröva alls.
 *
 * ── RIGGEN SKAPAR SINA EGNA FÖRUTSÄTTNINGAR ─────────────────────────────────
 *
 * Egen organisation, egen kontoplan, städning i FK-riktning. Ingenting lånas ur
 * `eken_dev` (#612).
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import {
  byggLeverantorsbetalningsrader,
  byggLeverantorsfakturarader,
  kontouppslagAv,
  KONTO_LEVERANTORSSKULD,
} from './manual-entry'
import { byggLeverantorsfakturareverseringsrader } from './manual-entry'
import { cancellationSourceId, paymentSourceId, receiptSourceId } from './supplier-invoice-status'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('leverantörsskuld — de två stegen nettar 2440 till noll', () => {
  let prisma: PrismaClient
  let orgId: string
  let konton: Map<number, string>

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `lev-${sfx}`,
        email: `lev-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id

    const specar = [
      { number: 1930, name: 'Företagskonto', type: 'ASSET' as const },
      { number: 2440, name: 'Leverantörsskulder', type: 'LIABILITY' as const },
      { number: 2641, name: 'Ingående moms', type: 'ASSET' as const },
      { number: 5070, name: 'Reparationer', type: 'EXPENSE' as const },
    ]
    const rader = []
    for (const s of specar) {
      rader.push(
        await prisma.account.create({
          data: { organizationId: orgId, number: s.number, name: s.name, type: s.type },
        }),
      )
    }
    konton = new Map(kontouppslagAv(rader.map((r) => ({ id: r.id, number: r.number }))))
  })

  afterAll(async () => {
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.supplierInvoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /** Skriver ett verifikat på samma sätt `createNumberedEntry` gör. */
  async function bokfor(
    sourceId: string,
    rader: Array<{ accountId: string; debit?: number; credit?: number }>,
    datum: string,
  ) {
    const befintlig = await prisma.journalEntry.findFirst({
      where: { organizationId: orgId, source: 'SUPPLIER_INVOICE', sourceId },
    })
    if (befintlig) return { id: befintlig.id, skapad: false }
    const skapad = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: new Date(datum),
        description: sourceId,
        source: 'SUPPLIER_INVOICE',
        sourceId,
        series: 'V',
        verNumber: Math.floor(Math.random() * 1_000_000),
        fiscalYear: 2026,
        lines: { create: rader },
      },
    })
    return { id: skapad.id, skapad: true }
  }

  /** Saldot på ett konto, debet minus kredit, för den här organisationen. */
  async function saldo(kontonummer: number): Promise<number> {
    const rader = await prisma.journalEntryLine.findMany({
      where: {
        accountId: konton.get(kontonummer) as string,
        journalEntry: { organizationId: orgId },
      },
    })
    return rader.reduce((s, r) => s + Number(r.debit ?? 0) - Number(r.credit ?? 0), 0)
  }

  it('KÄRNAN: mottagande + betalning → 2440 nettar till NOLL', async () => {
    const id = randomUUID()
    const mottagande = byggLeverantorsfakturarader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'Rörmokare' },
      konton,
    )
    if (!mottagande.ok) throw new Error(mottagande.fel)
    await bokfor(receiptSourceId(id), mottagande.rader, '2026-09-01')

    // Efter STEG 1 står skulden kvar: 2440 är krediterad med bruttot.
    expect(await saldo(KONTO_LEVERANTORSSKULD)).toBeCloseTo(-1250, 2)

    const betalning = byggLeverantorsbetalningsrader(1250, konton)
    if (!betalning.ok) throw new Error(betalning.fel)
    await bokfor(paymentSourceId(id), betalning.rader, '2026-09-30')

    // Efter STEG 2 är skulden reglerad. Det är hela invarianten.
    expect(await saldo(KONTO_LEVERANTORSSKULD)).toBeCloseTo(0, 2)
  })

  it('kostnaden ligger på 5070 (NETTO) och momsen på 2641 — inte hopblandade', async () => {
    // Bruttot står på skulden, nettot på kostnaden. Den omvända tolkningen ger
    // ett verifikat som BALANSERAR men bokför fel summa som kostnad, och det
    // syns varken i balansgrinden eller i ett radantalsprov.
    expect(await saldo(5070)).toBeCloseTo(1000, 2)
    expect(await saldo(2641)).toBeCloseTo(250, 2)
    // Och bruttot lämnade banken vid betalningen.
    expect(await saldo(1930)).toBeCloseTo(-1250, 2)
  })

  it('OMTAG av samma steg → EN post (idempotens per sourceId)', async () => {
    const id = randomUUID()
    const byggt = byggLeverantorsfakturarader(
      { belopp: 500, kontonummer: 5070, beskrivning: 'Omtag' },
      konton,
    )
    if (!byggt.ok) throw new Error(byggt.fel)

    const första = await bokfor(receiptSourceId(id), byggt.rader, '2026-09-02')
    const andra = await bokfor(receiptSourceId(id), byggt.rader, '2026-09-02')

    expect(första.skapad).toBe(true)
    expect(andra.skapad).toBe(false)
    expect(andra.id).toBe(första.id)
  })

  it('TVÅ OLIKA fakturor → TVÅ skulder (spärren hindrar inte riktigt arbete)', async () => {
    // Riktningen en attrapp inte kan pröva. En för grov nyckel hade tystat den
    // andra fakturan som en dubblett.
    const a = randomUUID()
    const b = randomUUID()
    const byggt = byggLeverantorsfakturarader(
      { belopp: 300, kontonummer: 5070, beskrivning: 'Två olika' },
      konton,
    )
    if (!byggt.ok) throw new Error(byggt.fel)

    const första = await bokfor(receiptSourceId(a), byggt.rader, '2026-09-03')
    const andra = await bokfor(receiptSourceId(b), byggt.rader, '2026-09-03')

    expect(första.skapad).toBe(true)
    expect(andra.skapad).toBe(true)
    expect(andra.id).not.toBe(första.id)
  })

  it('MOTTAGANDE och BETALNING har SKILDA nycklar — annars vore betalningen en dubblett', async () => {
    // DEN AVGÖRANDE KONTROLLEN för nyckelvalet. Med en gemensam nyckel hade
    // betalningen blivit en idempotensträff på mottagandet, alltså tyst ingen
    // bokföring alls — och skulden hade aldrig reglerats i huvudboken.
    const id = randomUUID()
    expect(receiptSourceId(id)).not.toBe(paymentSourceId(id))

    const mottagande = byggLeverantorsfakturarader(
      { belopp: 100, kontonummer: 5070, beskrivning: 'Nycklar' },
      konton,
    )
    const betalning = byggLeverantorsbetalningsrader(100, konton)
    if (!mottagande.ok || !betalning.ok) throw new Error('kunde inte bygga rader')

    const m = await bokfor(receiptSourceId(id), mottagande.rader, '2026-09-04')
    const b = await bokfor(paymentSourceId(id), betalning.rader, '2026-09-05')
    expect(m.skapad).toBe(true)
    expect(b.skapad).toBe(true)
  })

  it('MAKULERING vänder mottagandet — ALLA rörda konton tillbaka till noll', async () => {
    // Mäts som DELTA, inte som absolut saldo: de tidigare testerna har lämnat
    // rader på samma konton, och ett absolut tal hade gjort provet beroende av
    // körordningen i stället för av makuleringen.
    const fore = {
      skuld: await saldo(KONTO_LEVERANTORSSKULD),
      kostnad: await saldo(5070),
      moms: await saldo(2641),
    }

    const id = randomUUID()
    const indata = { belopp: 2500, moms: 500, kontonummer: 5070, beskrivning: 'Felaktig faktura' }
    const mottagande = byggLeverantorsfakturarader(indata, konton)
    const makulering = byggLeverantorsfakturareverseringsrader(indata, konton)
    if (!mottagande.ok || !makulering.ok) throw new Error('kunde inte bygga rader')

    await bokfor(receiptSourceId(id), mottagande.rader, '2026-09-10')
    // Mellanläget: skulden FINNS. Utan det här steget hade provet varit grönt
    // även om båda verifikaten bokfört ingenting.
    expect((await saldo(KONTO_LEVERANTORSSKULD)) - fore.skuld).toBeCloseTo(-2500, 2)

    await bokfor(cancellationSourceId(id), makulering.rader, '2026-09-11')

    expect((await saldo(KONTO_LEVERANTORSSKULD)) - fore.skuld).toBeCloseTo(0, 2)
    expect((await saldo(5070)) - fore.kostnad).toBeCloseTo(0, 2)
    expect((await saldo(2641)) - fore.moms).toBeCloseTo(0, 2)
  })

  it('MAKULERING har en TREDJE nyckel — den kan inte bli en träff på något av de andra', async () => {
    const id = randomUUID()
    const nycklar = [receiptSourceId(id), paymentSourceId(id), cancellationSourceId(id)]
    expect(new Set(nycklar).size).toBe(3)
  })

  it('MAKULERING rör INTE bankkontot — inga pengar har lämnat kontot', async () => {
    // Skillnaden mot betalningen, och hela poängen med två skilda vägar ut ur
    // skulden: den ena flyttar pengar, den andra säger att skulden aldrig fanns.
    const indata = { belopp: 900, moms: 180, kontonummer: 5070, beskrivning: 'Ingen bank' }
    const makulering = byggLeverantorsfakturareverseringsrader(indata, konton)
    if (!makulering.ok) throw new Error(makulering.fel)
    const bankId = konton.get(1930) as string
    expect(makulering.rader.some((r) => r.accountId === bankId)).toBe(false)
  })

  it('varje verifikat balanserar i DATABASEN', async () => {
    const poster = await prisma.journalEntry.findMany({
      where: { organizationId: orgId },
      include: { lines: true },
    })
    expect(poster.length).toBeGreaterThan(0)
    for (const post of poster) {
      const debet = post.lines.reduce((s, r) => s + Number(r.debit ?? 0), 0)
      const kredit = post.lines.reduce((s, r) => s + Number(r.credit ?? 0), 0)
      expect(debet).toBeCloseTo(kredit, 2)
    }
  })
})
