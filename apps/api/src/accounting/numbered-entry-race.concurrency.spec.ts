/**
 * SAMTIDIGT OMFÖRSÖK FÅR TILLBAKA DET FÖRSTA VERIFIKATET — mot riktig Postgres.
 *
 * ── EGENSKAPEN ──────────────────────────────────────────────────────────────
 *
 * `createNumberedEntry` är idempotent på (org, source, sourceId). Två anrop med
 * samma nyckel ska ge EN effekt och BÅDA anroparna ska få SAMMA verifikat
 * tillbaka — också när de kör samtidigt. Det är skillnaden mellan "idempotent"
 * och "råkar bli rätt antal rader": en agent som gör automatiskt omförsök
 * träffar exakt den här vägen och behöver ett verifikat, inte ett P2002.
 *
 * ── VARFÖR MOT RIKTIG POSTGRES ──────────────────────────────────────────────
 *
 * Egenskapen ÄGS av databasen. `findFirst` inuti transaktionen skyddar inte:
 * en läsning som inte hittar någon rad låser ingenting, så två samtidiga
 * transaktioner ser båda noll rader och går båda vidare till insert:en. Det som
 * räddar utfallet är `@@unique([organizationId, source, sourceId])`. Ingen
 * Prisma-attrapp kan visa det — en mock har varken index eller isolationsnivå.
 *
 * Uppmätt 2026-08-30, före den här ändringen:
 *     T1 ser 0 rader · T2 ser 0 rader
 *     T2: ERROR: duplicate key value violates unique constraint
 *     slutligt antal rader: 1          ← rätt antal, kastat fel till anroparen
 *
 * ── VARFÖR EN LÅSGRIND, INTE ETT `Promise.all` ─────────────────────────────
 *
 * Ett rakt `Promise.all` är ett HOPPFULLT prov: hinner den ena committa före
 * den andras `findFirst` tar förloraren snabbvägen, racet sker aldrig, och
 * testet blir grönt utan att ha mätt något. Det gör provet tidsberoende —
 * alltså svagt (samma lärdom som `mark-paid.concurrency.spec.ts`).
 *
 * Grinden gör racet DETERMINISTISKT. En utomstående transaktion håller radlåset
 * på `JournalEntrySequence` för (org, år, serie). Båda anroparna hinner då göra
 * sin `findFirst` (som ser noll rader), och fastnar sedan i `allocate` — som
 * ligger EFTER läsningen. Först när båda bevisligen väntar på låset släpps
 * grinden.
 *
 * ATT BÅDA VÄNTAR ÄR EN MÄTNING, INTE EN PAUS. Väntan läses ur
 * `pg_stat_activity` (`wait_event_type = 'Lock'` mot `JournalEntrySequence`) och
 * provet FALLER om talet aldrig når 2. Utan den raden hade en `sleep` kunnat se
 * likadan ut och bevisa ingenting.
 *
 * ── VAD SPECEN INTE ÄGER ────────────────────────────────────────────────────
 *
 * Att INDEXET finns och biter på radnivå ägs av
 * `ai/tools/ai-journal-idempotens.db.spec.ts` (A1–A3, mot rå `prisma.create`).
 * Den här specen mäter lagret ovanför: vad SKRIVVÄGEN returnerar. B4 nedan är
 * medvetet samma negativkontroll som A3, men ställd mot tjänsten — utan den kan
 * B1–B3 vara gröna av att något helt annat råkade hindra den andra skrivningen.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

const DATUM = new Date('2026-09-01')
const FISCAL_YEAR = 2026
const SERIE = 'A'
// Hur länge grinden får vänta på att BÅDA anroparna fastnat i låset. Ligger
// under `PRISMA_DEFAULT_TX_LIMITS.timeout` (5 s) med marginal: hinner vi inte
// dit inom fristen ska provet falla på sin egen mätning, inte på Prismas.
const VANTE_DEADLINE_MS = 3_000

medDb('createNumberedEntry — idempotens under samtidighet', () => {
  let prisma: PrismaService
  // Grinden får en EGEN klient med egen pool. Delade den anroparnas pool skulle
  // den kunna svälta dem på anslutningar, och provet hade fastnat i väntan på en
  // connection i stället för på radlåset — ett annat fenomen, samma symptom.
  let grind: PrismaClient
  let service: AccountingService
  let orgId: string
  let debetKonto: string
  let kreditKonto: string

  const rader = () => [
    { accountId: debetKonto, debit: 100 },
    { accountId: kreditKonto, credit: 100 },
  ]

  /** Skriver via SKARPA `createNumberedEntry` — privat, därför indexerad åtkomst. */
  const bokfor = (sourceId: string | null, description = 'samtidighetsprov') =>
    (
      service as unknown as {
        createNumberedEntry: (p: Record<string, unknown>) => Promise<{ id: string }>
      }
    ).createNumberedEntry({
      organizationId: orgId,
      date: DATUM,
      description,
      source: 'AI',
      sourceId,
      lines: rader(),
      idempotencyWhere: { organizationId: orgId, source: 'AI', sourceId },
    })

  /**
   * Tar och HÅLLER radlåset på sekvensraden, och återvänder först när låset
   * bevisligen är taget.
   *
   * Handskakningen är inte pynt. Utan den startar anroparna medan grindens egen
   * UPDATE fortfarande är på väg till databasen — de hinner då förbi
   * `allocate`, ingen väntar på något, och `toppVantande` blir 0. Det var inte
   * en hypotes: det var riggens första utfall.
   */
  const hallSekvenslaset = async () => {
    let slappGrinden!: () => void
    let bekraftaTaget!: () => void
    const grindenHalls = new Promise<void>((resolve) => {
      slappGrinden = resolve
    })
    const lasetTaget = new Promise<void>((resolve) => {
      bekraftaTaget = resolve
    })

    const grindKlar = grind.$transaction(
      async (tx) => {
        // `increment: 0` ändrar ingenting men tar radlåset — grinden ska HÅLLA
        // serien, inte flytta den.
        await tx.journalEntrySequence.update({
          where: {
            organizationId_fiscalYear_series: {
              organizationId: orgId,
              fiscalYear: FISCAL_YEAR,
              series: SERIE,
            },
          },
          data: { lastNumber: { increment: 0 } },
        })
        bekraftaTaget()
        await grindenHalls
      },
      { timeout: 20_000, maxWait: 10_000 },
    )

    await lasetTaget
    return { grindKlar, slappGrinden }
  }

  /** Antal sessioner som just nu VÄNTAR på ett lås mot sekvenstabellen. */
  const antalVantande = async (): Promise<number> => {
    const rows = await grind.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND state = 'active'
         AND query ILIKE '%JournalEntrySequence%'`
    return Number(rows[0]?.n ?? 0)
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    grind = new PrismaClient()
    service = new AccountingService(prisma, new VerifikationsnummerService(prisma))

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `race-${sfx}`,
        email: `race-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const d = await prisma.account.create({
      data: { organizationId: orgId, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
    })
    const k = await prisma.account.create({
      data: { organizationId: orgId, number: 3593, name: 'Påminnelseavgifter', type: 'REVENUE' },
    })
    debetKonto = d.id
    kreditKonto = k.id
    // Sekvensraden måste FINNAS för att gå att låsa. Skapas här, inte i ett
    // enskilt prov, så grinden inte beror på körordningen.
    await prisma.journalEntrySequence.create({
      data: { organizationId: orgId, fiscalYear: FISCAL_YEAR, series: SERIE, lastNumber: 0 },
    })
  })

  afterAll(async () => {
    await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
    await grind.$disconnect()
  })

  it('B1: SAMMA bekräftelse två gånger → exakt 1 effekt, och samma verifikat båda gångerna', async () => {
    const nyckel = `b1:${randomUUID()}`
    const forsta = await bokfor(nyckel)
    const andra = await bokfor(nyckel)

    expect(andra.id).toBe(forsta.id)
    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'AI', sourceId: nyckel },
    })
    expect(antal).toBe(1)
  })

  it('B2: TVÅ OLIKA bekräftelser → exakt 2, var och en mot SIN identitet', async () => {
    // Spärren får inte hindra riktigt arbete: olika nycklar är olika händelser.
    const a = `b2a:${randomUUID()}`
    const b = `b2b:${randomUUID()}`
    const ea = await bokfor(a)
    const eb = await bokfor(b)

    expect(ea.id).not.toBe(eb.id)
    for (const [nyckel, entry] of [
      [a, ea],
      [b, eb],
    ] as const) {
      const traffar = await prisma.journalEntry.findMany({
        where: { organizationId: orgId, source: 'AI', sourceId: nyckel },
        select: { id: true },
      })
      expect(traffar).toHaveLength(1)
      expect(traffar[0]!.id).toBe(entry.id)
    }
  })

  it('B3: TVÅ SAMTIDIGA försök med samma nyckel → exakt 1 effekt, och BÅDA får samma verifikat', async () => {
    const nyckel = `b3:${randomUUID()}`
    const { grindKlar, slappGrinden } = await hallSekvenslaset()
    let toppVantande = 0

    const a = bokfor(nyckel, 'samtidig A')
    const b = bokfor(nyckel, 'samtidig B')

    const deadline = Date.now() + VANTE_DEADLINE_MS
    while (Date.now() < deadline) {
      toppVantande = Math.max(toppVantande, await antalVantande())
      if (toppVantande >= 2) break
      await new Promise((r) => setTimeout(r, 25))
    }
    slappGrinden()
    await grindKlar

    const [ea, eb] = await Promise.all([a, b])

    // ── MÄTNINGEN SOM GÖR PROVET SKARPT ──────────────────────────────────
    // Nådde inte båda anroparna låset har de INTE racat: den ena hann committa
    // före den andras `findFirst`, och då mäter B3 snabbvägen — samma sak som
    // B1 redan äger. Talet står med flit i assertionen.
    expect(toppVantande).toBeGreaterThanOrEqual(2)

    // 1. EXAKT EN EFFEKT.
    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'AI', sourceId: nyckel },
    })
    expect(antal).toBe(1)

    // 2. BÅDA ANROPARNA FICK VERIFIKATET — inte ett kastat P2002.
    expect(ea.id).toBe(eb.id)

    // 3. Och det är den rad som faktiskt ligger i databasen.
    const iDb = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: orgId, source: 'AI', sourceId: nyckel },
      select: { id: true, verNumber: true },
    })
    expect(ea.id).toBe(iDb.id)

    // 4. GAP-FREE: förlorarens transaktion rullades tillbaka, så hens
    //    sekvensökning brändes aldrig. Ett nummer förbrukat, inte två.
    const seq = await prisma.journalEntrySequence.findFirstOrThrow({
      where: { organizationId: orgId, fiscalYear: FISCAL_YEAR, series: SERIE },
      select: { lastNumber: true },
    })
    expect(seq.lastNumber).toBe(iDb.verNumber)
  })

  it('B5: en dubblett i VERIFIKATIONSSERIEN maskeras ALDRIG som ett ofarligt race', async () => {
    // ── VARFÖR DEN HÄR RADEN FINNS ────────────────────────────────────────
    //
    // Återhämtningen i `createNumberedEntry` är en CATCH. En catch som sväljer
    // fel är hur en spärr går blind. JournalEntry har TRE unika index och de
    // betyder inte samma sak: (org, series, fiscalYear, verNumber) betyder att
    // verifikationsserien fått en dubblett — ett allvarligt fel (BFL 5 kap 6 §)
    // som måste fortsätta upp, inte översättas till "någon hann före".
    //
    // ⚠️ ÄRLIGT OM VAD PROVET SKILJER PÅ: det skiljer INTE en riktad
    // `isIdempotencyRaceConflict` från en blind `catch (P2002)`. Båda faller
    // här, eftersom uppslaget på vår egen nyckel ger null och felet kastas
    // vidare ändå. Provet låser UTFALLET — att ett serienummerkrock syns som ett
    // fel — inte vilket av de två lagren som bär det. Att skriva ut det är
    // billigare än att någon senare läser för mycket i ett grönt prov.
    const seqFore = await prisma.journalEntrySequence.findFirstOrThrow({
      where: { organizationId: orgId, fiscalYear: FISCAL_YEAR, series: SERIE },
      select: { lastNumber: true },
    })
    // Backa sekvensen ett steg: nästa allokering delar ut ett REDAN ANVÄNT
    // nummer, med en helt ny (och alltså kollisionsfri) idempotensnyckel.
    await prisma.journalEntrySequence.updateMany({
      where: { organizationId: orgId, fiscalYear: FISCAL_YEAR, series: SERIE },
      data: { lastNumber: seqFore.lastNumber - 1 },
    })

    const nyckel = `b5:${randomUUID()}`
    await expect(bokfor(nyckel)).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: expect.arrayContaining(['verNumber']) },
    })

    // Och ingenting skrevs: felet stoppade posten, det maskerades inte.
    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'AI', sourceId: nyckel },
    })
    expect(antal).toBe(0)

    await prisma.journalEntrySequence.updateMany({
      where: { organizationId: orgId, fiscalYear: FISCAL_YEAR, series: SERIE },
      data: { lastNumber: seqFore.lastNumber },
    })
  })

  it('B4: NEGATIVKONTROLL — utan deterministisk identitet producerar SAMMA rigg två effekter', async () => {
    // Beviset för att B3:s "exakt 1" är en mätning och inte en tomhet: samma
    // grind, samma två samtidiga anropare, enda skillnaden är att identiteten
    // (`sourceId`) tagits bort. Postgres räknar NULL som distinkt, så det unika
    // indexet spärrar ingenting — och båda skrivningarna går igenom.
    //
    // ⚠️ SEKVENTIELLT hade det HÄR provet varit grönt av fel skäl: `findFirst`
    // matchar `sourceId: null` mot en redan skriven null-rad och returnerar den.
    // Snabbvägen döljer alltså att skyddet är borta. Det är precis därför
    // negativkontrollen måste köra SAMTIDIGT — då hinner ingen se den andra.
    const fore = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'AI', sourceId: null },
    })
    const { grindKlar, slappGrinden } = await hallSekvenslaset()
    let toppVantande = 0

    const a = bokfor(null, 'utan identitet A')
    const b = bokfor(null, 'utan identitet B')

    const deadline = Date.now() + VANTE_DEADLINE_MS
    while (Date.now() < deadline) {
      toppVantande = Math.max(toppVantande, await antalVantande())
      if (toppVantande >= 2) break
      await new Promise((r) => setTimeout(r, 25))
    }
    slappGrinden()
    await grindKlar

    const [ea, eb] = await Promise.all([a, b])

    // Samma skärpekrav som B3: nådde de inte låset har de inte racat.
    expect(toppVantande).toBeGreaterThanOrEqual(2)
    expect(ea.id).not.toBe(eb.id)

    const efter = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'AI', sourceId: null },
    })
    expect(efter - fore).toBe(2)
  })
})
