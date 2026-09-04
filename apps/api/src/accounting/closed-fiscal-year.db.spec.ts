/**
 * SPÄRREN MOT BOKFÖRING I ETT STÄNGT RÄKENSKAPSÅR (#704 PR 1) — mot riktig Postgres.
 *
 * ── VARFÖR RIKTIG DATABAS OCH INTE EN ATTRAPP ───────────────────────────────
 *
 * Två av frågorna nedan går inte att ställa till en attrapp:
 *
 *  1. AVGRÄNSNINGEN. `findUnique` på (organizationId, fiscalYear) utvärderas av
 *     Postgres. Tappar den `organizationId` returnerar en attrapp ändå det den
 *     blev tillsagd att returnera — provet "en annan organisations stängning
 *     låser inte min" hade förblivit grönt med en trasig `where`. (CLAUDE.md:
 *     "En ATTRAPP kan inte pröva den FÖR GROVA riktningen".)
 *  2. IDEMPOTENSEN. Att exakt EN av två samtidiga stängningar vinner är
 *     unik-indexets arbete, inte kodens.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att `closeFiscalYear` skriver raden rätt — den funktionen finns inte än
 * (PR 2). Här mäts bara att spärren läser raden rätt när den finns, och att den
 * inte fäller något när den saknas. Att raden är OFÖRÄNDERLIG ägs av
 * `append-only.db.spec.ts` och av triggern i migrationen.
 *
 * ── POOLEN SÄTTS AV RIGGEN ──────────────────────────────────────────────────
 *
 * Samtidighetsprovet öppnar N transaktioner samtidigt. Är Prismas pool mindre än
 * N dör anropen på pool-timeout i stället för på unik-indexet, och utfallet ser
 * ut som ett grönt "bara en vann" — av fel skäl.
 */
import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'

import {
  assertPeriodOpen,
  fiscalYearLabel,
  isFiscalYearClosed,
  isPeriodClosed,
} from './closed-period'
import { VerifikationsnummerService } from './verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Samtidiga stängningsförsök i idempotensprovet. */
const N = 4
/** …plus marginal för riggens egna anslutningar. */
const POOL = N + 6

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

medDb('#704 PR 1 · bokföring i stängt räkenskapsår', () => {
  let prisma: PrismaClient
  let verServiceKalender: VerifikationsnummerService
  /** Kalenderår (startmånad 1). */
  let orgKal: string
  /** Brutet år, startmånad 5 → räkenskapsåret 2026 = maj 2026–apr 2027. */
  let orgBrutet: string
  /** Främmande organisation — dess stängningar får aldrig låsa någon annans år. */
  let orgAnnan: string

  /** Ett datum i svensk civil tid, mitt på dagen (aldrig nära en periodgräns). */
  const d = (år: number, månad: number, dag: number) =>
    new Date(Date.UTC(år, månad - 1, dag, 10, 0, 0))

  const nyOrg = async (fiscalYearStartMonth: number): Promise<string> => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `fyc-${sfx}`,
        email: `fyc-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        fiscalYearStartMonth,
      },
      select: { id: true },
    })
    return org.id
  }

  /** Stäng en KALENDERMÅNAD (AccountingPeriodEvent), utan att röra året. */
  const stängMånad = (organizationId: string, year: number, month: number) =>
    prisma.accountingPeriodEvent.create({
      data: { organizationId, year, month, seq: 1, type: 'CLOSED', actorType: 'SYSTEM' },
    })

  /** Stäng ett RÄKENSKAPSÅR (FiscalYearClose), utan att röra månaderna. */
  const stängÅr = (organizationId: string, fiscalYear: number) =>
    prisma.fiscalYearClose.create({ data: { organizationId, fiscalYear } })

  /**
   * Allokera ett verifikationsnummer — den VERKSTÄLLANDE punkten. Provet går via
   * den och inte bara via `assertPeriodOpen`, så att en spärr som fungerar men
   * inte är påkopplad blir röd.
   */
  const allokera = (organizationId: string, datum: Date) =>
    prisma.$transaction((tx) => verServiceKalender.allocate(tx, organizationId, datum))

  beforeAll(async () => {
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
          'mindre än samtidigheten dör anropen på pool-timeout i stället för på unik-' +
          'indexet, och "bara en vann" blir grönt av fel skäl.',
      )
    }
    verServiceKalender = new VerifikationsnummerService(prisma as never)
    orgKal = await nyOrg(1)
    orgBrutet = await nyOrg(5)
    orgAnnan = await nyOrg(1)
  })

  // Riggen skapar sina egna förutsättningar och tar bort dem igen, så två
  // körningar mot samma databas ger samma svar. Städas i FK-riktning.
  afterEach(async () => {
    for (const id of [orgKal, orgBrutet, orgAnnan]) {
      await prisma.fiscalYearClose.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: id } })
      await prisma.accountingPeriodEvent.deleteMany({ where: { organizationId: id } })
    }
  })

  afterAll(async () => {
    for (const id of [orgKal, orgBrutet, orgAnnan]) {
      await prisma.organization.deleteMany({ where: { id } })
    }
    await prisma.$disconnect()
  })

  // ── 1. Kärnan: stängt år nekar, öppet år släpper igenom ───────────────────
  describe('kalenderår', () => {
    it('verifikat i ett STÄNGT räkenskapsår NEKAS — och meddelandet säger ÅR', async () => {
      await stängÅr(orgKal, 2026)
      // Månaden är ORÖRD. Faller anropet ändå är det årsspärren som gör det.
      await expect(isPeriodClosed(prisma, orgKal, d(2026, 6, 15))).resolves.toBe(false)

      await expect(allokera(orgKal, d(2026, 6, 15))).rejects.toThrow(
        /Räkenskapsåret 2026 är stängt/,
      )
    })

    it('verifikat i ett ÖPPET räkenskapsår PASSERAR', async () => {
      // KANARIEFÅGEL för provet ovan: utan raden ska samma anrop lyckas, annars
      // mäter "nekas" något annat än årsstängningen.
      await expect(isFiscalYearClosed(prisma, orgKal, d(2026, 6, 15))).resolves.toBe(false)
      const nr = await allokera(orgKal, d(2026, 6, 15))
      expect(nr).toMatchObject({ fiscalYear: 2026, series: 'A', verNumber: 1 })
    })

    it('STÄNGD PERIOD i ett ÖPPET år nekas med PERIOD-meddelandet, inte ÅR', async () => {
      await stängMånad(orgKal, 2026, 6)
      await expect(isFiscalYearClosed(prisma, orgKal, d(2026, 6, 15))).resolves.toBe(false)

      const fel = await allokera(orgKal, d(2026, 6, 15)).catch((e: Error) => e)
      expect(fel).toBeInstanceOf(ConflictException)
      expect((fel as Error).message).toMatch(/Bokföringsperioden 2026-06 är stängd/)
      // Den skarpa halvan: det får INTE stå räkenskapsår, för det är inte det
      // som hindrar — och de två anvisar olika åtgärder (månaden kan öppnas).
      expect((fel as Error).message).not.toMatch(/Räkenskapsåret/)
    })

    it('ORDNINGEN: är BÅDA stängda vinner ÅRET — annars vore årsmeddelandet oåtkomligt', async () => {
      await stängMånad(orgKal, 2026, 6)
      await stängÅr(orgKal, 2026)
      const fel = await allokera(orgKal, d(2026, 6, 15)).catch((e: Error) => e)
      expect((fel as Error).message).toMatch(/Räkenskapsåret 2026 är stängt/)
      expect((fel as Error).message).not.toMatch(/Bokföringsperioden/)
    })

    it('en ANNAN organisations stängning låser inte mitt år', async () => {
      await stängÅr(orgAnnan, 2026)
      await expect(isFiscalYearClosed(prisma, orgKal, d(2026, 6, 15))).resolves.toBe(false)
      await expect(allokera(orgKal, d(2026, 6, 15))).resolves.toMatchObject({ fiscalYear: 2026 })
    })
  })

  // ── 2. Brutet räkenskapsår — provet som skiljer år från KALENDERår ────────
  describe('brutet räkenskapsår (startmånad 5)', () => {
    it('ett datum i KALENDERÅR 2027 tillhör räkenskapsåret 2026 och NEKAS av dess stängning', async () => {
      await stängÅr(orgBrutet, 2026)
      // Mars 2027 ligger i räkenskapsåret 2026 (maj 2026–apr 2027). En spärr som
      // läste kalenderåret hade svarat "öppet" här — det är hela poängen.
      await expect(isFiscalYearClosed(prisma, orgBrutet, d(2027, 3, 15))).resolves.toBe(true)
      await expect(assertPeriodOpen(prisma, orgBrutet, d(2027, 3, 15), 'test')).rejects.toThrow(
        /Räkenskapsåret 2026\/2027 är stängt/,
      )
    })

    it('NÄSTA räkenskapsår är opåverkat — spärren är riktad, inte bred', async () => {
      await stängÅr(orgBrutet, 2026)
      // 15 maj 2027 är första månaden i räkenskapsåret 2027.
      await expect(isFiscalYearClosed(prisma, orgBrutet, d(2027, 5, 15))).resolves.toBe(false)
      await expect(
        assertPeriodOpen(prisma, orgBrutet, d(2027, 5, 15), 'test'),
      ).resolves.toBeUndefined()
    })

    it('etiketten visar BÅDA kalenderåren vid brutet år, ett vid kalenderår', () => {
      expect(fiscalYearLabel(2026, 1)).toBe('2026')
      expect(fiscalYearLabel(2026, 5)).toBe('2026/2027')
    })
  })

  // ── 3. Idempotensen bor i unik-villkoret, inte i koden ────────────────────
  describe('idempotens på (organizationId, fiscalYear)', () => {
    it(`${N} samtidiga stängningar av samma år → EXAKT en rad, övriga P2002`, async () => {
      const utfall = await Promise.allSettled(
        Array.from({ length: N }, () => stängÅr(orgKal, 2026)),
      )
      const ok = utfall.filter((u) => u.status === 'fulfilled')
      const p2002 = utfall.filter(
        (u) =>
          u.status === 'rejected' &&
          u.reason instanceof Prisma.PrismaClientKnownRequestError &&
          u.reason.code === 'P2002',
      )
      expect(ok).toHaveLength(1)
      // Alla avslag ska vara unik-krocken. Ett pool-timeout eller ett annat fel
      // hade också gett "en vann" — men av fel skäl.
      expect(p2002).toHaveLength(N - 1)
      await expect(
        prisma.fiscalYearClose.count({ where: { organizationId: orgKal } }),
      ).resolves.toBe(1)
    })

    it('två LEGITIMA stängningar (olika år) ger TVÅ rader', async () => {
      // Den omvända riktningen: villkoret får inte vara så grovt att det spärrar
      // ett annat år för samma organisation.
      await stängÅr(orgKal, 2026)
      await stängÅr(orgKal, 2027)
      await expect(
        prisma.fiscalYearClose.count({ where: { organizationId: orgKal } }),
      ).resolves.toBe(2)
    })
  })

  // ── 4. Ordningen bokslutsposter → stängning ───────────────────────────────
  describe('bokslutsposter måste kunna bokföras FÖRE stängningen', () => {
    /** Samma gränsuträkning som runYearEndAccrual (consumption.service.ts:732-735). */
    const gränser = (fiscalYear: number, startMonth: number) => {
      const reversalDate = new Date(Date.UTC(fiscalYear + 1, startMonth - 1, 1))
      const yearEndDate = new Date(reversalDate.getTime() - 86_400_000)
      return { yearEndDate, reversalDate }
    }

    it('med året ÖPPET passerar både årsslutet och återföringen', async () => {
      const { yearEndDate, reversalDate } = gränser(2026, 5)
      for (const datum of [yearEndDate, reversalDate]) {
        await expect(
          assertPeriodOpen(prisma, orgBrutet, datum, 'bokslutspost kan inte skapas'),
        ).resolves.toBeUndefined()
      }
    })

    it('med året STÄNGT nekas årsslutet — men återföringen ligger i NÄSTA år och passerar', async () => {
      await stängÅr(orgBrutet, 2026)
      const { yearEndDate, reversalDate } = gränser(2026, 5)
      await expect(assertPeriodOpen(prisma, orgBrutet, yearEndDate, 'x')).rejects.toThrow(
        /Räkenskapsåret 2026\/2027 är stängt/,
      )
      await expect(assertPeriodOpen(prisma, orgBrutet, reversalDate, 'x')).resolves.toBeUndefined()
    })

    /**
     * MÄTNING FÖR PR 2, INTE ETT KRAV PÅ PR 1.
     *
     * Issue #704 kräver av `closeFiscalYear` BÅDE att räkenskapsårets alla
     * månader är stängda FÖRE stängningen OCH att årsavslutsverifikatet dateras
     * räkenskapsårets sista dag. De två utesluter varandra redan i dag, av den
     * BEFINTLIGA månadsspärren — årsstängningens sista dag ligger i en av de
     * månader som då är stängda. Provet nedan fastnaglar den mekaniken så att
     * PR 2 tvingas ta ställning i stället för att upptäcka det i drift.
     */
    it('PR 2-FYND: med sista månaden stängd nekas årsavslutsverifikatets datum redan av MÅNADSspärren', async () => {
      const { yearEndDate } = gränser(2026, 5) // 30 april 2027
      await stängMånad(orgBrutet, 2027, 4)
      await expect(isFiscalYearClosed(prisma, orgBrutet, yearEndDate)).resolves.toBe(false)
      await expect(assertPeriodOpen(prisma, orgBrutet, yearEndDate, 'x')).rejects.toThrow(
        /Bokföringsperioden 2027-04 är stängd/,
      )
    })
  })
})
