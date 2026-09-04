/**
 * ÅRSSTÄNGNINGEN — mot riktig Postgres (#704 PR 2).
 *
 * ── VARFÖR SALDON ASSERTERAS OCH INTE BARA "KASTADE" ──────────────────────
 *
 * Ett prov som bara kräver att `closeFiscalYear` inte kastar mäter att koden
 * kördes, inte att bokföringen blev rätt. Nollställningen kan vara vänd åt fel
 * håll, plug-posten kan hamna på fel sida av 2099, och båda felen ger ett
 * verifikat som BALANSERAR — den globala balansgrinden i `createNumberedEntry`
 * märker ingenting, eftersom summa debet fortfarande är summa kredit. Vad som
 * skiljer rätt från fel är TECKNET på eget kapital, och det syns bara i saldona.
 *
 * Därför asserterar varje utfallsprov nedan:
 *   • varje resultatkontos utgående saldo = 0
 *   • balanskontonas utgående saldo OFÖRÄNDRADE av årsavslutet
 *   • Årets resultat-kontots saldo = −resultatet (kreditsaldo vid vinst)
 *
 * ── VARFÖR RIKTIG DATABAS ─────────────────────────────────────────────────
 *
 * `groupBy` med Decimal-summering, det unika indexet (org, source, sourceId) som
 * bär verifikatets idempotens, och (org, fiscalYear) som bär stängningens — inget
 * av det utvärderas av en attrapp. En attrapp returnerar det den blev tillsagd,
 * oavsett `where`.
 *
 * ── VAD PROVET INTE KAN SE ────────────────────────────────────────────────
 *
 * Om konteringen är redovisningsmässigt RÄTT. Att resultatet ska avräknas mot
 * Årets resultat och inte mot något annat är en redovisningsfråga som verifieras
 * av människa (underlaget på #704). Proven mäter att koden gör det den säger.
 */
import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { CompanyForm, Prisma, PrismaClient } from '@prisma/client'

import { AccountingPeriodService } from './accounting-period.service'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'
import { assertPeriodOpen } from './closed-period'
import { fiscalYearBounds } from './fiscal-year'
import { YEAR_RESULT_ACCOUNT_BY_FORM } from './bas-chart'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Samtidiga stängningsförsök i dubbelstängningsprovet. */
const N = 2
/** …plus marginal för riggens egna anslutningar. Se PR 1:s db-spec. */
const POOL = N + 8

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

/** Kontona riggen behöver. Minimalt urval ur BAS — inte hela planen. */
const KONTON = [
  { number: 1510, name: 'Kundfordringar', type: 'ASSET' as const },
  { number: 1930, name: 'Företagskonto', type: 'ASSET' as const },
  { number: 2611, name: 'Utgående moms 25%', type: 'LIABILITY' as const },
  { number: 2099, name: 'Årets resultat', type: 'EQUITY' as const },
  { number: 3911, name: 'Hyresintäkter, bostäder', type: 'REVENUE' as const },
  { number: 5010, name: 'Lokalhyra', type: 'EXPENSE' as const },
  { number: 8131, name: 'Dröjsmålsränta, kundfordringar', type: 'REVENUE' as const },
]

medDb('#704 PR 2 · closeFiscalYear', () => {
  let prisma: PrismaClient
  let service: AccountingPeriodService
  const städa: string[] = []

  const ADMIN = { actorRole: 'ADMIN' as const, actorUserId: null }
  const NU = new Date('2027-02-15T09:00:00Z')

  beforeAll(() => {
    prisma = new PrismaClient({
      datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, POOL) } },
    })
    const satt = Number(
      new URL(urlMedPool(process.env.DATABASE_URL as string, POOL)).searchParams.get(
        'connection_limit',
      ),
    )
    if (!(satt > N)) {
      throw new Error(
        `POOL, INTE SPÄRR: connection_limit=${satt} är inte större än N=${N}. Med en pool ` +
          'mindre än samtidigheten dör anropen på pool-timeout i stället för på unik-indexet.',
      )
    }
    const ver = new VerifikationsnummerService(prisma as never)
    service = new AccountingPeriodService(
      prisma as never,
      new AccountingService(prisma as never, ver),
    )
  })

  // Riggen skapar sina egna förutsättningar och tar bort dem igen, i FK-riktning.
  // Två körningar mot samma databas ska ge samma svar.
  afterEach(async () => {
    for (const orgId of städa.splice(0)) {
      await prisma.fiscalYearClose.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntry: { organizationId: orgId } },
      })
      await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
      await prisma.accountingPeriodEvent.deleteMany({ where: { organizationId: orgId } })
      await prisma.closedAccountingPeriod.deleteMany({ where: { organizationId: orgId } })
      await prisma.account.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  // ── Riggen ────────────────────────────────────────────────────────────────

  async function nyOrg(
    startMonth = 1,
    companyForm: CompanyForm = 'AB',
  ): Promise<{ orgId: string; kontoId: Map<number, string> }> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `cfy-${sfx}`,
        email: `cfy-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        fiscalYearStartMonth: startMonth,
        companyForm,
      },
      select: { id: true },
    })
    städa.push(org.id)
    const kontoId = new Map<number, string>()
    for (const k of KONTON) {
      const a = await prisma.account.create({
        data: { organizationId: org.id, number: k.number, name: k.name, type: k.type },
        select: { id: true },
      })
      kontoId.set(k.number, a.id)
    }
    return { orgId: org.id, kontoId }
  }

  /**
   * Bokför ett verifikat DIREKT, förbi `allocate`.
   *
   * Avsiktligt: riggen behöver exakta datum och belopp, och `allocate` hade
   * krävt att månaden är öppen — vilket den ska vara när fixturerna skapas men
   * inte när spärrarna prövas. Att spärren i `allocate` fungerar är PR 1:s prov
   * och prövas separat nedan ("verifikat i det stängda året").
   *
   * MEN NUMRET ALLOKERAS SOM I VERKLIGHETEN, ur `JournalEntrySequence` per
   * (org, räkenskapsår, serie). Första versionen räknade i en modulvariabel
   * delad av alla prov, och den kolliderade med `allocate`s egen räknare i det
   * FÖRSTA provet — därefter låg modulräknaren av en slump före, så resten var
   * gröna. En rigg vars förutsättning bara stämmer efter första provet är inte
   * riggens egen; det här är samma defekt som "lånar omgivningens data", fast
   * lånet var från ett tidigare prov i samma fil.
   */
  async function bokför(
    orgId: string,
    kontoId: Map<number, string>,
    datum: string,
    fiscalYear: number,
    rader: Array<{ konto: number; debit?: number; credit?: number }>,
  ): Promise<void> {
    const seq = await prisma.journalEntrySequence.upsert({
      where: {
        organizationId_fiscalYear_series: { organizationId: orgId, fiscalYear, series: 'A' },
      },
      create: { organizationId: orgId, fiscalYear, series: 'A', lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })
    await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: new Date(`${datum}T00:00:00Z`),
        description: `fixtur ${datum}`,
        source: 'MANUAL',
        sourceId: `fixtur:${randomUUID()}`,
        fiscalYear,
        series: 'A',
        verNumber: seq.lastNumber,
        lines: {
          create: rader.map((r) => ({
            accountId: kontoId.get(r.konto) as string,
            ...(r.debit != null ? { debit: new Prisma.Decimal(r.debit) } : {}),
            ...(r.credit != null ? { credit: new Prisma.Decimal(r.credit) } : {}),
            description: `konto ${r.konto}`,
          })),
        },
      },
    })
  }

  /** Stäng en kalendermånad utan att gå via månadsprechecken. */
  const stängMånad = (organizationId: string, year: number, month: number) =>
    prisma.accountingPeriodEvent.create({
      data: { organizationId, year, month, seq: 1, type: 'CLOSED', actorType: 'SYSTEM' },
    })

  /** Stäng månad 1–11 i räkenskapsåret. Månad 12 lämnas öppen — det är kravet. */
  async function stängElvaFörsta(orgId: string, fiscalYear: number, startMonth: number) {
    const { months } = fiscalYearBounds(fiscalYear, startMonth)
    for (const m of months.slice(0, 11)) await stängMånad(orgId, m.year, m.month)
  }

  /**
   * Kontots saldo (debet − kredit) t.o.m. `tom`, inklusive.
   *
   * Det är EXAKT samma storhet som SIE4-exportens `#IB` för nästa räkenskapsår:
   * exporten summerar alla rader med `date < yearStart` och tecknar dem med
   * `sieSignedAmount` = debet − kredit (accounting.service.ts). Att assertera
   * det här saldot ÄR därför att assertera nästa års ingående balans.
   */
  async function saldo(orgId: string, kontoId: string, tom: string): Promise<number> {
    const agg = await prisma.journalEntryLine.aggregate({
      where: {
        accountId: kontoId,
        journalEntry: { organizationId: orgId, date: { lte: new Date(`${tom}T00:00:00Z`) } },
      },
      _sum: { debit: true, credit: true },
    })
    return new Prisma.Decimal(agg._sum.debit ?? 0)
      .minus(new Prisma.Decimal(agg._sum.credit ?? 0))
      .toNumber()
  }

  // ── 1. Vinst ─────────────────────────────────────────────────────────────
  it('VINST 18 000,01: resultatkonton nollas, 2099 får kreditsaldo, balanskonton orörda', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    // Intäkt 30 000,01 (öresfordran med flit — #704:s mätfall) och kostnad 12 000.
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 30_000.01 },
      { konto: 3911, credit: 30_000.01 },
    ])
    await bokför(orgId, kontoId, '2026-06-10', 2026, [
      { konto: 5010, debit: 12_000 },
      { konto: 1930, credit: 12_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    const res = await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    expect(res.summary.result).toBe(18_000.01)
    expect(res.summary.accountsZeroed).toBe(2)
    expect(res.journalEntryId).not.toBeNull()
    expect(res.monthClosed).toEqual({ year: 2026, month: 12 })

    // SALDONA — det som skiljer rätt riktning från fel.
    expect(await saldo(orgId, kontoId.get(3911) as string, '2026-12-31')).toBe(0)
    expect(await saldo(orgId, kontoId.get(5010) as string, '2026-12-31')).toBe(0)
    // Vinst → eget kapital ökar → KREDITsaldo → negativt i debet−kredit-form.
    expect(await saldo(orgId, kontoId.get(2099) as string, '2026-12-31')).toBe(-18_000.01)
    // Balanskontona är oförändrade: årsavslutet rör aldrig klass 1–2.
    expect(await saldo(orgId, kontoId.get(1510) as string, '2026-12-31')).toBe(30_000.01)
    expect(await saldo(orgId, kontoId.get(1930) as string, '2026-12-31')).toBe(-12_000)

    // Verifikatet: daterat årets sista dag, idempotensnyckel year-end:<år>.
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: res.journalEntryId as string },
      include: { lines: true },
    })
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-12-31')
    expect(entry.sourceId).toBe('year-end:2026')
    expect(entry.lines).toHaveLength(3)
  })

  // ── 2. Förlust ───────────────────────────────────────────────────────────
  it('FÖRLUST 5 000: 2099 får DEBETsaldo — motsatt tecken mot vinstfallet', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 10_000 },
      { konto: 3911, credit: 10_000 },
    ])
    await bokför(orgId, kontoId, '2026-06-10', 2026, [
      { konto: 5010, debit: 15_000 },
      { konto: 1930, credit: 15_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    const res = await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    expect(res.summary.result).toBe(-5_000)
    expect(await saldo(orgId, kontoId.get(3911) as string, '2026-12-31')).toBe(0)
    expect(await saldo(orgId, kontoId.get(5010) as string, '2026-12-31')).toBe(0)
    // Förlust → eget kapital minskar → DEBETsaldo → positivt.
    expect(await saldo(orgId, kontoId.get(2099) as string, '2026-12-31')).toBe(5_000)
  })

  // ── 3. Nollresultat ──────────────────────────────────────────────────────
  it('INGET ATT NOLLSTÄLLA: inget verifikat, men FiscalYearClose skrivs ändå', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    // Bara en balansräkningsrörelse — inget resultatkonto rörs.
    await bokför(orgId, kontoId, '2026-04-01', 2026, [
      { konto: 1930, debit: 5_000 },
      { konto: 1510, credit: 5_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    const res = await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    expect(res.journalEntryId).toBeNull()
    expect(res.summary.result).toBe(0)
    expect(res.summary.accountsZeroed).toBe(0)
    expect(res.summary.noEntryReason).toBe('inga resultatkonton med saldo')

    const rad = await prisma.fiscalYearClose.findUniqueOrThrow({
      where: { organizationId_fiscalYear: { organizationId: orgId, fiscalYear: 2026 } },
    })
    expect(rad.journalEntryId).toBeNull()
    expect(rad.closedAt.toISOString()).toBe(NU.toISOString())
    // Året ÄR stängt, trots att inget verifikat skrevs.
    expect(await prisma.fiscalYearClose.count({ where: { organizationId: orgId } })).toBe(1)
  })

  it('NOLLRESULTAT MED RÖRELSE: intäkt = kostnad ger verifikat UTAN 2099-rad', async () => {
    // Skild från fallet ovan, och skillnaden är hela poängen: här FINNS det
    // saldon att nollställa, resultatet blir bara noll. Ett verifikat måste
    // skrivas ändå — annars ligger resultatkontona kvar med saldo in i nästa år.
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 7_000 },
      { konto: 3911, credit: 7_000 },
    ])
    await bokför(orgId, kontoId, '2026-06-10', 2026, [
      { konto: 5010, debit: 7_000 },
      { konto: 1930, credit: 7_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    const res = await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    expect(res.summary.result).toBe(0)
    expect(res.journalEntryId).not.toBeNull()
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: res.journalEntryId as string },
      include: { lines: { include: { account: true } } },
    })
    expect(entry.lines).toHaveLength(2)
    expect(entry.lines.some((l) => l.account.number === 2099)).toBe(false)
    expect(await saldo(orgId, kontoId.get(3911) as string, '2026-12-31')).toBe(0)
    expect(await saldo(orgId, kontoId.get(5010) as string, '2026-12-31')).toBe(0)
    expect(await saldo(orgId, kontoId.get(2099) as string, '2026-12-31')).toBe(0)
  })

  // ── 4. Brutet räkenskapsår ───────────────────────────────────────────────
  it('BRUTET ÅR (startmånad 5): verifikat i BÅDA kalenderåren räknas in, dateringen är 30 april', async () => {
    const { orgId, kontoId } = await nyOrg(5)
    // Räkenskapsåret 2026 = maj 2026 – april 2027.
    await bokför(orgId, kontoId, '2026-09-15', 2026, [
      { konto: 1510, debit: 20_000 },
      { konto: 3911, credit: 20_000 },
    ])
    await bokför(orgId, kontoId, '2027-02-20', 2026, [
      { konto: 5010, debit: 8_000 },
      { konto: 1930, credit: 8_000 },
    ])
    // …och ett verifikat i NÄSTA räkenskapsår, som INTE får räknas med.
    await bokför(orgId, kontoId, '2027-05-02', 2027, [
      { konto: 1510, debit: 999 },
      { konto: 3911, credit: 999 },
    ])
    await stängElvaFörsta(orgId, 2026, 5)

    const res = await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    expect(res.label).toBe('2026/2027')
    expect(res.monthClosed).toEqual({ year: 2027, month: 4 })
    // 20 000 − 8 000 = 12 000. Hade 2027-05-02 räknats med vore det 12 999.
    expect(res.summary.result).toBe(12_000)
    expect(res.summary.yearEndDate).toBe('2027-04-30')

    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: res.journalEntryId as string },
    })
    expect(entry.date.toISOString().slice(0, 10)).toBe('2027-04-30')
    // Resultatkontona är nollade PER RÄKENSKAPSÅRETS SLUT — inte per kalenderår.
    expect(await saldo(orgId, kontoId.get(3911) as string, '2027-04-30')).toBe(0)
    expect(await saldo(orgId, kontoId.get(5010) as string, '2027-04-30')).toBe(0)
    expect(await saldo(orgId, kontoId.get(2099) as string, '2027-04-30')).toBe(-12_000)
    // …och nästa års verifikat ligger kvar orört.
    expect(await saldo(orgId, kontoId.get(3911) as string, '2027-05-31')).toBe(-999)
  })

  // ── 5–6. Förutsättningarna ───────────────────────────────────────────────
  it('MÅNAD 11 ÖPPEN: nekas, och meddelandet LISTAR vilka månader som saknas', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 100 },
      { konto: 3911, credit: 100 },
    ])
    const { months } = fiscalYearBounds(2026, 1)
    // Stäng 1–10, lämna 11 (och 12) öppna.
    for (const m of months.slice(0, 10)) await stängMånad(orgId, m.year, m.month)

    const fel = await service.closeFiscalYear(orgId, 2026, NU, ADMIN).catch((e: Error) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/2026-11/)
    expect((fel as Error).message).not.toMatch(/2026-12/)

    // Inget skrevs: varken verifikat, stängning eller årsrad.
    expect(await prisma.fiscalYearClose.count({ where: { organizationId: orgId } })).toBe(0)
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: orgId, sourceId: 'year-end:2026' },
      }),
    ).toBe(0)

    // …och förhandsvisningen säger samma sak utan att kasta.
    const pre = await service.previewFiscalYearClose(orgId, 2026)
    expect(pre.canClose).toBe(false)
    expect(pre.checks.find((c) => c.code === 'months-not-closed')?.message).toMatch(/2026-11/)
  })

  it('MÅNAD 12 REDAN STÄNGD: nekas — verifikatet kan inte längre bokföras i den', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 100 },
      { konto: 3911, credit: 100 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)
    await stängMånad(orgId, 2026, 12)

    const fel = await service.closeFiscalYear(orgId, 2026, NU, ADMIN).catch((e: Error) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/redan stängd/)
    expect(await prisma.fiscalYearClose.count({ where: { organizationId: orgId } })).toBe(0)
  })

  // ── 7. Idempotens ────────────────────────────────────────────────────────
  it('DUBBEL STÄNGNING: andra försöket ger Conflict, och EN rad + ETT verifikat finns', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 1_000 },
      { konto: 3911, credit: 1_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    await service.closeFiscalYear(orgId, 2026, NU, ADMIN)
    const fel = await service.closeFiscalYear(orgId, 2026, NU, ADMIN).catch((e: Error) => e)

    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/redan stängt/)
    expect(await prisma.fiscalYearClose.count({ where: { organizationId: orgId } })).toBe(1)
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: orgId, sourceId: 'year-end:2026' },
      }),
    ).toBe(1)
    // Och EN CLOSED-händelse för månad 12, inte två.
    expect(
      await prisma.accountingPeriodEvent.count({
        where: { organizationId: orgId, year: 2026, month: 12, type: 'CLOSED' },
      }),
    ).toBe(1)
  })

  // ── 8. PR 1:s spärr gäller efter stängningen ─────────────────────────────
  it('VERIFIKAT I DET STÄNGDA ÅRET: nekas av årsspärren, inte av månadsspärren', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 1_000 },
      { konto: 3911, credit: 1_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)
    await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    // Mars 2026 är stängd som MÅNAD också, så välj ett datum vars månad aldrig
    // stängdes för egen del — då är det bevisligen ÅRSspärren som fäller.
    // Alla tolv månader är nu stängda, så vi mäter i stället på meddelandet.
    const fel = await assertPeriodOpen(
      prisma,
      orgId,
      new Date('2026-07-15T10:00:00Z'),
      'test',
    ).catch((e: Error) => e)
    expect((fel as Error).message).toMatch(/Räkenskapsåret 2026 är stängt/)
    expect((fel as Error).message).not.toMatch(/Bokföringsperioden/)
  })

  // ── 9. Ingående balans nästa år ──────────────────────────────────────────
  it('IB NÄSTA ÅR: balanskonton = UB, resultatkonton 0, 2099 = årets resultat', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 25_000 },
      { konto: 3911, credit: 20_000 },
      { konto: 2611, credit: 5_000 },
    ])
    await bokför(orgId, kontoId, '2026-06-10', 2026, [
      { konto: 5010, debit: 6_000 },
      { konto: 1930, credit: 6_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)
    await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    // IB för räkenskapsåret 2027 = allt med date < 2027-01-01, alltså saldot
    // t.o.m. 2026-12-31. Se `saldo`s docblock för varför det är samma storhet
    // som SIE4-exportens #IB.
    const ib = async (n: number) => saldo(orgId, kontoId.get(n) as string, '2026-12-31')

    // Balanskonton: oförändrade av årsavslutet.
    expect(await ib(1510)).toBe(25_000)
    expect(await ib(1930)).toBe(-6_000)
    // Momsen står KVAR — årsstängningen avräknar den inte, och det är rätt.
    expect(await ib(2611)).toBe(-5_000)
    // Resultatkonton: nollade.
    expect(await ib(3911)).toBe(0)
    expect(await ib(5010)).toBe(0)
    expect(await ib(8131)).toBe(0)
    // Årets resultat: 20 000 − 6 000 = 14 000 vinst → kreditsaldo.
    expect(await ib(2099)).toBe(-14_000)

    // BALANSRÄKNINGEN GÅR IHOP: tillgångar = skulder + eget kapital.
    // Uttryckt i debet−kredit-form är summan över ALLA konton noll när den gör
    // det — och det var precis den summan som var 18 000,01 fel före #704.
    const alla = await Promise.all(KONTON.map((k) => ib(k.number)))
    const summa = alla.reduce((a, b) => a + b, 0)
    expect(summa).toBe(0)
  })

  // ── 10. Bokslutsposter före stängning ────────────────────────────────────
  it('BOKSLUTSPOSTER FÖRE STÄNGNING: årsslutsdatumet är öppet innan, stängt efter', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 1_000 },
      { konto: 3911, credit: 1_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    // Samma två datum som runYearEndAccrual bokför på.
    const { yearEndDate, reversalDate } = fiscalYearBounds(2026, 1)
    for (const d of [yearEndDate, reversalDate]) {
      await expect(assertPeriodOpen(prisma, orgId, d, 'bokslutspost')).resolves.toBeUndefined()
    }

    await service.closeFiscalYear(orgId, 2026, NU, ADMIN)

    // Efteråt är årsslutet låst — men återföringen ligger i NÄSTA räkenskapsår
    // och är fortfarande öppen. Spärren är riktad, inte bred.
    await expect(assertPeriodOpen(prisma, orgId, yearEndDate, 'x')).rejects.toThrow(
      /Räkenskapsåret 2026 är stängt/,
    )
    await expect(assertPeriodOpen(prisma, orgId, reversalDate, 'x')).resolves.toBeUndefined()
  })

  // ── 11. Motkontot beror på bolagsformen ──────────────────────────────────
  it('ENSKILD FIRMA: resultatet går mot 2019, inte 2099 — och saknas kontot NEKAS stängningen', async () => {
    const { orgId, kontoId } = await nyOrg(1, 'ENSKILD_FIRMA')
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 3_000 },
      { konto: 3911, credit: 3_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    // Riggen seedar AB-planen, så 2019 SAKNAS — och det ska fällas, inte tigas.
    expect(YEAR_RESULT_ACCOUNT_BY_FORM.ENSKILD_FIRMA).toBe(2019)
    const fel = await service.closeFiscalYear(orgId, 2026, NU, ADMIN).catch((e: Error) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/2019 \(Årets resultat\) saknas/)

    // Med kontot på plats går det igenom, och 2099 rörs INTE.
    const konto2019 = await prisma.account.create({
      data: { organizationId: orgId, number: 2019, name: 'Årets resultat', type: 'EQUITY' },
      select: { id: true },
    })
    const res = await service.closeFiscalYear(orgId, 2026, NU, ADMIN)
    expect(res.summary.resultAccountNumber).toBe(2019)
    expect(await saldo(orgId, konto2019.id, '2026-12-31')).toBe(-3_000)
    expect(await saldo(orgId, kontoId.get(2099) as string, '2026-12-31')).toBe(0)
  })

  // ── 12. #716: kontoplanens partitioner måste vara ense ───────────────────
  it('OENIG KONTOPLAN: ett balanskonto med resultattyp NEKAR stängningen', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 500 },
      { konto: 3911, credit: 500 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)
    // Ett konto i 2-serien med type=EXPENSE: numret säger balans, typen säger
    // resultat. Nollställdes det tyst hade en skuld nollats mot årets resultat.
    await prisma.account.create({
      data: { organizationId: orgId, number: 2440, name: 'Leverantörsskulder', type: 'EXPENSE' },
    })

    const fel = await service.closeFiscalYear(orgId, 2026, NU, ADMIN).catch((e: Error) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/motsägelsefull/)
    expect((fel as Error).message).toMatch(/2440/)
    expect(await prisma.fiscalYearClose.count({ where: { organizationId: orgId } })).toBe(0)
  })

  // ── 13. Tidigare öppet räkenskapsår ──────────────────────────────────────
  it('TIDIGARE ÅR ÖPPET: nekas — v1 stödjer bara tolvmånadersår i ordning', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2025-08-01', 2025, [
      { konto: 1510, debit: 400 },
      { konto: 3911, credit: 400 },
    ])
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 900 },
      { konto: 3911, credit: 900 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    const fel = await service.closeFiscalYear(orgId, 2026, NU, ADMIN).catch((e: Error) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toMatch(/tidigare räkenskapsår/)
    expect((fel as Error).message).toMatch(/2025/)
  })

  // ── 14. Förhandsvisningen visar samma sak som stängningen bokför ─────────
  it('PREVIEW: samma rader och samma resultat som stängningen — och skriver ingenting', async () => {
    const { orgId, kontoId } = await nyOrg(1)
    await bokför(orgId, kontoId, '2026-03-15', 2026, [
      { konto: 1510, debit: 30_000.01 },
      { konto: 3911, credit: 30_000.01 },
    ])
    await bokför(orgId, kontoId, '2026-06-10', 2026, [
      { konto: 5010, debit: 12_000 },
      { konto: 1930, credit: 12_000 },
    ])
    await stängElvaFörsta(orgId, 2026, 1)

    const pre = await service.previewFiscalYearClose(orgId, 2026)
    expect(pre.canClose).toBe(true)
    expect(pre.entry.result).toBe(18_000.01)
    expect(pre.entry.date).toBe('2026-12-31')

    // Ingenting skrevs av förhandsvisningen.
    expect(await prisma.fiscalYearClose.count({ where: { organizationId: orgId } })).toBe(0)
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: orgId, sourceId: 'year-end:2026' },
      }),
    ).toBe(0)

    // …och den bokförda posten har EXAKT förhandsvisningens rader. Det är hela
    // poängen med att de delar beräkning: en förhandsvisning som räknar på egen
    // hand visar något annat än det människan sedan bekräftar.
    const res = await service.closeFiscalYear(orgId, 2026, NU, ADMIN)
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: res.journalEntryId as string },
      include: { lines: { include: { account: true } } },
    })
    const bokförda = entry.lines
      .map((l) => ({
        number: l.account.number,
        debit: l.debit == null ? null : Number(l.debit),
        credit: l.credit == null ? null : Number(l.credit),
      }))
      .sort((a, b) => a.number - b.number)
    const föreslagna = pre.entry.lines
      .map((l) => ({
        number: l.accountNumber,
        debit: l.debit ?? null,
        credit: l.credit ?? null,
      }))
      .sort((a, b) => a.number - b.number)
    expect(bokförda).toEqual(föreslagna)
  })
})
