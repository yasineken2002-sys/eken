/**
 * SEN BOKFÖRING I ETT STÄNGT RÄKENSKAPSÅR — mot riktig Postgres.
 *
 * ── VAD SOM ÄNDRADES, OCH VAD SOM INTE GJORDE DET ───────────────────────────
 *
 * Före: `assertPeriodOpen` kastade på BÅDA stängningsformerna, och för det
 * stängda RÄKENSKAPSÅRET fanns ingen väg framåt — året kan inte öppnas igen.
 * En betalning som verkligen inträffade kunde alltså aldrig bokföras, vilket är
 * en fullständighetsbrist i grundbokföringen (BFL 5 kap 1–2 §§).
 *
 * Efter: med operatörens uttryckliga ja bokförs posten på FÖRSTA ÖPPNA DAG, med
 * betalningsdatumet bevarat i `JournalEntry.eventDate` (BFL 5 kap 7 § — "när
 * affärshändelsen har inträffat") och ett spår i `LateFiscalYearPosting`.
 *
 * Den stängda MÅNADEN är ORÖRD och det är hela poängen med att den står med
 * här: den har en spårad återöppningsväg, och att rutta förbi den hade kringgått
 * ett medvetet mänskligt beslut.
 *
 * ── VARFÖR RIKTIG DATABAS ───────────────────────────────────────────────────
 *
 * Tre av frågorna kan en attrapp inte svara på:
 *
 *  1. FÖRSTA ÖPPNA DAG utvärderas genom riktiga uppslag mot `FiscalYearClose`
 *     och `AccountingPeriodEvent`, månad för månad. En attrapp hade returnerat
 *     det den blev tillsagd oavsett vilket datum resolvern frågade om.
 *  2. ATOMICITETEN. Att verifikatet och spåret skrivs i SAMMA transaktion syns
 *     bara om en riktig transaktion kan rullas tillbaka.
 *  3. CHECK-VILLKORET `bookedDate > eventDate` är databasens, inte kodens.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Rollspärren. `assertFarBokforaSent` är en ren funktion som prövas i
 * `late-fiscal-year-role.spec.ts`; controllern anropar den innan tjänsten nås,
 * och den vägen ägs av behörighetsytans golden-fil. Här mäts bokföringen.
 */
import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

import { resolveBokforingsdatum } from './closed-period'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('sen bokföring i stängt räkenskapsår', () => {
  let prisma: PrismaClient
  let accounting: AccountingService
  let orgId: string
  let bankKonto: string
  let fordringsKonto: string
  let intaktsKonto: string
  /** Verifikationsnummer för riggens EGNA förutsättningsposter. */
  let nastaVerNummer = 9000

  /** Ett datum i svensk civil tid, mitt på dagen — aldrig nära en periodgräns. */
  const d = (ar: number, manad: number, dag: number) =>
    new Date(Date.UTC(ar, manad - 1, dag, 10, 0, 0))

  /** Kalenderdagen i ett @db.Date-värde, utan tidszonsglidning. */
  const dagenI = (v: Date) => v.toISOString().slice(0, 10)

  const stangAr = (fiscalYear: number) =>
    prisma.fiscalYearClose.create({ data: { organizationId: orgId, fiscalYear } })

  const stangManad = (year: number, month: number) =>
    prisma.accountingPeriodEvent.create({
      data: { organizationId: orgId, year, month, seq: 1, type: 'CLOSED', actorType: 'SYSTEM' },
    })

  const SKAL = 'Betalningen kom in i december men upptäcktes först nu'

  /**
   * Antal BETALNINGSverifikat. Riggens egen fordran är också en `JournalEntry`,
   * så ett rått `count()` hade varit 1 när ingen betalning bokförts — och ett
   * prov som kräver 0 hade blivit rött av riggen i stället för av koden.
   */
  const betalningsverifikat = () =>
    prisma.journalEntry.count({ where: { organizationId: orgId, source: 'PAYMENT' } })

  /**
   * FÖRUTSÄTTNING, inte det som mäts: fakturans INTÄKTSVERIFIKAT.
   *
   * `createJournalEntryForInvoiceManualPayment` vägrar kreditera 1510 utan en
   * bokförd fordran (`assertInvoiceReceivableBacked`, fail-closed mot spök-
   * krediter). Riggen skapar därför fordran själv — direkt genom Prisma och
   * inte genom tjänsten, eftersom det är en förutsättning och inte vägen under
   * mätning. Datumet ligger med flit i en ÖPPEN period: intäkten är inte det
   * provet handlar om.
   */
  const bokforFordran = async (invoiceId: string) => {
    await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: d(2026, 6, 1),
        description: 'Fordran (riggens förutsättning)',
        source: 'INVOICE',
        sourceId: invoiceId,
        fiscalYear: 2026,
        series: 'A',
        verNumber: nastaVerNummer++,
        lines: {
          create: [
            { accountId: fordringsKonto, debit: 1500 },
            { accountId: intaktsKonto, credit: 1500 },
          ],
        },
      },
    })
  }

  /**
   * Bokför en fakturabetalning genom PRODUKTIONSVÄGEN.
   *
   * Går via `createJournalEntryForInvoiceManualPayment`, inte via ett eget
   * `createNumberedEntry`-anrop: ett grönt prov ska betyda att just den vägen
   * fungerar, inte att en väg jag skrev i provet gör det.
   */
  const bokfor = async (paidAt: Date, senBokforing?: { reason: string }, belopp = 1500) => {
    const invoiceId = randomUUID()
    await bokforFordran(invoiceId)
    return accounting.createJournalEntryForInvoiceManualPayment(
      { id: invoiceId, invoiceNumber: `F-${invoiceId.slice(0, 6)}` },
      belopp,
      paidAt,
      'BANK',
      orgId,
      null,
      randomUUID(),
      undefined,
      senBokforing
        ? {
            tillat: true,
            reason: senBokforing.reason,
            actorType: 'USER',
            actorUserId: null,
            actorLabel: 'Provet',
          }
        : undefined,
    )
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `lfy-${sfx}`,
        email: `lfy-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    orgId = org.id
    // Kontoplanens två konton betalningsverifikatet behöver. Riggen skapar sina
    // EGNA förutsättningar — den lånar inget ur eken_dev, och är därför grön
    // eller röd av samma skäl mot en tom databas som i CI.
    const bank = await prisma.account.create({
      data: { organizationId: orgId, number: 1930, name: 'Företagskonto', type: 'ASSET' },
      select: { id: true },
    })
    const fordran = await prisma.account.create({
      data: { organizationId: orgId, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
      select: { id: true },
    })
    const intakt = await prisma.account.create({
      data: { organizationId: orgId, number: 3010, name: 'Hyresintäkter', type: 'REVENUE' },
      select: { id: true },
    })
    bankKonto = bank.id
    fordringsKonto = fordran.id
    intaktsKonto = intakt.id
    void bankKonto
  })

  // Städas i FK-riktning: spåret pekar på verifikatet med Restrict, så det
  // måste bort först. Riggen skapar sina egna förutsättningar och tar bort dem
  // igen — två körningar mot samma databas ger samma svar.
  afterEach(async () => {
    await prisma.lateFiscalYearPosting.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.fiscalYearClose.deleteMany({ where: { organizationId: orgId } })
    await prisma.accountingPeriodEvent.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  // ── 1. ÖPPEN PERIOD: BETEENDET SKA VARA OFÖRÄNDRAT ────────────────────────
  //
  // Den här beskrivningen är det som gör resten av provet läsbart: om flaggan
  // ändrade något i normalfallet vore ändringen inte "en ny väg" utan "en ny
  // regel för alla".
  describe('öppen period — oförändrat', () => {
    it('bokförs på betalningsdagen, utan eventDate och utan spår', async () => {
      const entry = await bokfor(d(2026, 3, 15))
      expect(entry).not.toBeNull()
      expect(dagenI(entry!.date)).toBe('2026-03-15')
      expect(entry!.eventDate).toBeNull()
      expect(await prisma.lateFiscalYearPosting.count({ where: { organizationId: orgId } })).toBe(0)
    })

    it('flaggan ändrar INGENTING när perioden är öppen', async () => {
      // Samma anrop som ovan men MED operatörens ja. Utan den här raden kunde
      // flaggan ha flyttat varje post och provet ovan ändå varit grönt.
      const entry = await bokfor(d(2026, 3, 15), { reason: SKAL })
      expect(dagenI(entry!.date)).toBe('2026-03-15')
      expect(entry!.eventDate).toBeNull()
      expect(await prisma.lateFiscalYearPosting.count({ where: { organizationId: orgId } })).toBe(0)
    })
  })

  // ── 2. STÄNGT RÄKENSKAPSÅR ────────────────────────────────────────────────
  describe('stängt räkenskapsår', () => {
    it('UTAN operatörens ja: avvisas precis som förut', async () => {
      await stangAr(2025)
      await expect(bokfor(d(2025, 12, 20))).rejects.toThrow(ConflictException)
      expect(await betalningsverifikat()).toBe(0)
    })

    it('MED operatörens ja: bokförs på första öppna dag, betalningsdatumet bevarat', async () => {
      await stangAr(2025)
      const entry = await bokfor(d(2025, 12, 20), { reason: SKAL })

      expect(entry).not.toBeNull()
      // Första öppna dag = 1 januari 2026: året 2025 är stängt, 2026 är det inte.
      expect(dagenI(entry!.date)).toBe('2026-01-01')
      // …och det VERKLIGA datumet finns kvar på verifikatet (BFL 5 kap 7 §).
      expect(dagenI(entry!.eventDate!)).toBe('2025-12-20')
      // Härledningarna följer BOKFÖRINGSDATUMET, annars bryts nummerserien.
      expect(entry!.fiscalYear).toBe(2026)
    })

    it('spåret skrivs, och det säger vad som hände', async () => {
      await stangAr(2025)
      const entry = await bokfor(d(2025, 12, 20), { reason: SKAL })

      const spar = await prisma.lateFiscalYearPosting.findUnique({
        where: { journalEntryId: entry!.id },
      })
      expect(spar).not.toBeNull()
      expect(dagenI(spar!.eventDate)).toBe('2025-12-20')
      expect(dagenI(spar!.bookedDate)).toBe('2026-01-01')
      expect(spar!.closedFiscalYear).toBe(2025)
      expect(spar!.reason).toBe(SKAL)
      expect(spar!.actorType).toBe('USER')
      expect(Number(spar!.amount)).toBe(1500)
      // 1 500 kr ligger under väsentlighetsgränsen (10 000) — flaggan ska vara
      // falsk, annars betyder den ingenting.
      expect(spar!.materialityFlagged).toBe(false)
    })

    it('hoppar över efterföljande STÄNGDA MÅNADER på väg till första öppna dag', async () => {
      await stangAr(2025)
      await stangManad(2026, 1)
      await stangManad(2026, 2)
      const entry = await bokfor(d(2025, 12, 20), { reason: SKAL })
      // Januari och februari 2026 är stängda månader → mars.
      expect(dagenI(entry!.date)).toBe('2026-03-01')
      expect(dagenI(entry!.eventDate!)).toBe('2025-12-20')
    })

    it('väsentligt belopp FLAGGAS — det är en bedömning, inte en beräkning', async () => {
      await stangAr(2025)
      const entry = await bokfor(d(2025, 12, 20), { reason: SKAL }, 25000)
      const spar = await prisma.lateFiscalYearPosting.findUnique({
        where: { journalEntryId: entry!.id },
      })
      expect(spar!.materialityFlagged).toBe(true)
    })
  })

  // ── 3. STÄNGD MÅNAD: MEDVETET ORÖRD ───────────────────────────────────────
  //
  // Den här beskrivningen är gränsen mot vad ändringen INTE gör, och den är den
  // viktigaste i filen: utan den hade en senare, bredare implementation kunnat
  // glida in utan att något blev rött.
  describe('stängd MÅNAD i ett öppet år — avvisas, även med operatörens ja', () => {
    it('utan ja: avvisas', async () => {
      await stangManad(2026, 3)
      await expect(bokfor(d(2026, 3, 15))).rejects.toThrow(ConflictException)
    })

    it('MED ja: avvisas ÄNDÅ — månaden har en spårad återöppningsväg', async () => {
      await stangManad(2026, 3)
      await expect(bokfor(d(2026, 3, 15), { reason: SKAL })).rejects.toThrow(ConflictException)
      expect(await betalningsverifikat()).toBe(0)
      expect(await prisma.lateFiscalYearPosting.count({ where: { organizationId: orgId } })).toBe(0)
    })
  })

  // ── 4. RESOLVERN DIREKT ───────────────────────────────────────────────────
  describe('resolveBokforingsdatum', () => {
    it('utan tillåtelse rör den ingenting, ens i ett stängt år', async () => {
      await stangAr(2025)
      const ut = await resolveBokforingsdatum(prisma, orgId, d(2025, 12, 20), false)
      expect(ut.bookingDate).toEqual(d(2025, 12, 20))
      expect(ut.eventDate).toBeNull()
      expect(ut.movedFromFiscalYear).toBeNull()
    })

    it('KANARIEFÅGEL: den kan flytta — annars mäter provet ovan ingenting', async () => {
      await stangAr(2025)
      const ut = await resolveBokforingsdatum(prisma, orgId, d(2025, 12, 20), true)
      expect(dagenI(ut.bookingDate)).toBe('2026-01-01')
      expect(ut.movedFromFiscalYear).toBe(2025)
    })
  })

  // ── 5. SPÅRET ÄR APPEND-ONLY ──────────────────────────────────────────────
  describe('spåret går inte att ÄNDRAS i efterhand', () => {
    it('UPDATE avvisas av databasen; DELETE är med flit tillåten', async () => {
      await stangAr(2025)
      const entry = await bokfor(d(2025, 12, 20), { reason: SKAL })
      const id = (await prisma.lateFiscalYearPosting.findUnique({
        where: { journalEntryId: entry!.id },
        select: { id: true },
      }))!.id

      await expect(
        prisma.lateFiscalYearPosting.update({ where: { id }, data: { reason: 'nytt skäl' } }),
      ).rejects.toThrow(/append-only/i)

      // DELETE är med FLIT ospärrad, precis som för de sex befintliga
      // append-only-tabellerna: `scripts/delete-organization.ts` måste kunna
      // radera, och en full spärr hade brutit den vägen — upptäckt först vid en
      // GDPR-begäran. Raden nedan blir röd om någon "härdar" bort den.
      await expect(prisma.lateFiscalYearPosting.delete({ where: { id } })).resolves.toBeDefined()
    })
  })
})
