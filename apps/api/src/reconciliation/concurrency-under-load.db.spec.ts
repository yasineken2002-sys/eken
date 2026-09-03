/**
 * BANKAVSTÄMNINGEN UNDER SAMTIDIGHET — mekanismen mätt, inte bara påkopplad.
 *
 * `docs/revision-status.md` bar posten "H2 under verklig samtidighet" som en
 * UTTRYCKLIG ICKE-MÄTNING: radlås, deterministisk låsordning och
 * transaktionsgränser fanns och var påkopplade, men svält var aldrig mätt under
 * last. Mekanismernas närvaro är ett argument, inte en mätning. Den här filen
 * är mätningen.
 *
 * ── VAD SOM BÄR SKYDDET (läst i koden, inte antaget) ────────────────────────
 *
 *   reconciliation.service.ts:1517       enskildvägen låser EN avi:
 *                                        SELECT id FROM "RentNotice" … FOR UPDATE
 *   reconciliation.service.ts:2056-2058  vattenfallet låser ALLA kandidater
 *   reconciliation.service.ts:2026       ordningen är deterministisk:
 *                                        orderBy [dueDate asc, createdAt asc]
 *   reconciliation.service.ts:2062       restskulden läses EFTER låset
 *
 * Isolationsnivån är Postgres default READ COMMITTED — ingen `isolationLevel`
 * sätts någonstans i `apps/api/src`. Skyddet är alltså RADLÅSET, inte
 * isolationen: under READ COMMITTED skulle två samtidiga delbetalningar båda
 * läsa full restskuld, vilket kommentaren på `:1470-1472` säger rakt ut.
 *
 * ── POOLEN MÅSTE VARA STÖRRE ÄN N, ANNARS MÄTER RIGGEN MASKINEN ─────────────
 *
 * Det här är filens viktigaste förutsättning och den upptäcktes genom att köra
 * riggen fel först.
 *
 * Prismas anslutningspool är `num_physical_cpus × 2 + 1` när ingen
 * `connection_limit` är satt. Utvecklingsmaskinen rapporterar `nproc = 2` →
 * pool 5; produktionscontainern `nproc = 48` → ~97 (se `transaction-limits.ts`).
 * Med N = 10 mot en pool om 5 blir `maxWait: 3000` den bindande gränsen, och
 * uppmätt konsekvens:
 *
 *     tio transaktioner mot TIO OLIKA avier — som inte kan låsa varandra —
 *     dog ALLA med P2028.
 *
 * `P2028` skiljer inte pooluttömning från låsväntan. Ett P2028-tal utan känd
 * pool är därför inte en mätning av låsen. Filen skapar därför sin EGEN
 * PrismaClient med `connection_limit` satt explicit i datasource-URL:en, så
 * talet är oberoende av runnerns kärnantal — och `beforeAll` assertar poolen
 * med ett felmeddelande som säger POOL och inte lås.
 *
 * ── VAD SOM MÄTS ────────────────────────────────────────────────────────────
 *
 *   FALL 1  N samtidiga matchare mot SAMMA avi        → exakt en allokerar
 *   FALL 2  N samtidiga mot N OLIKA avier             → alla lyckas, 0 deadlock
 *   FALL 3  vattenfall + delbetalning, överlappningen TVINGAD med ett externt
 *           lås                                        → Σ ≤ skuld
 *   FALL 4  vattenfallets HÅLLTID per M                → marginal till taket
 *   FALL 5  DEN OMVÄNDA RIKTNINGEN: en konkurrents VÄNTETID medan vattenfallet
 *           håller M lås                                → under maxWait
 *
 * ── VAD SOM INTE MÄTS ───────────────────────────────────────────────────────
 *
 *  • N = 10, inte hundra. Produktionens pool är ~97; tio samtidiga matchare är
 *    en samtidighet som går att skapa, inte den värsta som kan uppstå.
 *  • Maskinen har TVÅ kärnor och databasen nås över LOOPBACK. Produktionens
 *    tur-och-retur går över nät. Tiderna nedan är alltså undre gränser;
 *    `transaction-limits.ts` projicerar prod som uppmätt × 10.
 *  • Kanariefågeln som neutraliserar radlåset ligger som ett eget prov nedan,
 *    men den patchar Prisma-klienten och inte tjänstefilen. Den bevisar därför
 *    att RIGGEN ser en överallokering — inte att tjänstens `FOR UPDATE`-rad är
 *    den enda som hindrar den.
 *  • Väntetiden i FALL 5 mäts på EN konkurrent, inte på en kö.
 *
 * ── DEN TIDIGARE MÄTNINGEN, OCH VAD DEN INTE TÄCKTE ─────────────────────────
 *
 * `reconciliation.service.ts:1509-1518` bär ett tal: 440 parallella försök mot
 * riktig Postgres, 440/440 ett verifikat, och med låset borttaget 39/40 med TVÅ
 * verifikat (40 000 kr bokfört mot en fordran på 20 000). Det talet gällde
 * `RentNotice`↔`Deposit`-låsordningen, inte N matchare mot samma hyresgästs
 * avier — och riggen finns inte i repot, bara talet i kommentaren. Den här
 * filen är den första körbara samtidighetsmätningen på bankavstämningen.
 */

// StorageService och PdfService drar in @aws-sdk/client-s3 respektive Puppeteer
// via importkedjan; @nodable/entities är ESM och jest kan inte parsa den. Samma
// två mockar som kodbasens övriga reconciliation-specar använder — de rör ingen
// kodväg riggen mäter.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, RentNoticeType } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { ReconciliationService } from './reconciliation.service'

const Decimal = Prisma.Decimal

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Samtidighetsgraden. Skrivs ut i varje mätning — ett tal i prosan glider. */
const N = 10

/** Poolen: N plus marginal för riggens egna hjälpklienter (hållare, kanarie). */
const POOL = N + 15

const AVIBELOPP = 9000

/**
 * Hur länge det externa låset hålls i FALL 3 och 5. Måste ligga klart under
 * `PAYMENT_TX_LIMITS.timeout` (annars dör konkurrenterna av taket i stället
 * för att vänta) och under `maxWait` i FALL 5:s assertion.
 */
const HÅLLTID_MS = 800

/** Datasource-URL med `connection_limit` satt explicit. Se huvudet. */
function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

function klient(pool: number): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, pool) } },
  })
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('bankavstämningen under samtidighet', () => {
  let prisma: PrismaClient
  let service: ReconciliationService
  let orgId: string
  let tenantId: string
  let unitId: string
  let leaseId: string
  let userId: string
  const tider: Record<string, number> = {}
  let räknare = 0

  function nyTjänst(klientEn: PrismaClient): ReconciliationService {
    const accounting = new AccountingService(
      klientEn as never,
      new VerifikationsnummerService(klientEn as never),
    )
    const s = Object.create(ReconciliationService.prototype) as ReconciliationService
    Object.assign(s, {
      prisma: klientEn,
      accounting,
      rentNoticeEvents: new RentNoticeEventsService(klientEn as never),
      // De tre som RentNotice-vägarna inte rör. Att de aldrig anropas är halva
      // assertionen: rör riggen dem kastar den i stället för att tiga.
      invoices: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('invoices orört')
          },
        },
      ),
      events: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('events orört')
          },
        },
      ),
      freshness: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('freshness orört')
          },
        },
      ),
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    return s
  }

  beforeAll(async () => {
    // POOLEN FÖRST, och som en assertion med ett felmeddelande som pekar på
    // POOL och inte på lås. Se huvudet: P2028 skiljer inte de två.
    const url = urlMedPool(process.env.DATABASE_URL as string, POOL)
    const satt = Number(new URL(url).searchParams.get('connection_limit'))
    if (!(satt > N)) {
      throw new Error(
        `POOL, INTE LÅS: connection_limit=${satt} är inte större än N=${N}. ` +
          'Prismas default är nproc×2+1 (2 kärnor → 5), och med en pool mindre ' +
          'än N blir maxWait den bindande gränsen: transaktioner mot OLIKA avier ' +
          'dör då med P2028 utan att något radlås varit inblandat. ' +
          'Riggen sätter poolen själv — får du det här felet är POOL-konstanten fel.',
      )
    }

    prisma = klient(POOL)
    const sfx = randomUUID().slice(0, 8)

    const org = await prisma.organization.create({
      data: {
        name: `conc-${sfx}`,
        email: `conc-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5560${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    orgId = org.id

    // Kontoplanen — utan 1510/1930/39xx loggar AccountingService ett fel och
    // hoppar verifikatet, och riggen hade mätt en tystare väg än produktionens.
    await prisma.account.createMany({
      data: [
        { organizationId: orgId, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: orgId, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: orgId, number: 3911, name: 'Hyresintäkter bostad', type: 'REVENUE' },
      ],
    })

    const prop = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `p-${sfx}`,
        propertyDesignation: `CONC ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        name: `Lgh ${sfx}`,
        unitNumber: `1-${sfx}`,
        type: 'APARTMENT',
        rooms: 2,
        area: 55,
        monthlyRent: AVIBELOPP,
        status: 'OCCUPIED',
      },
      select: { id: true },
    })
    unitId = unit.id

    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Sam',
        lastName: 'Tidig',
        email: `t-${sfx}@example.se`,
      },
      select: { id: true },
    })
    tenantId = tenant.id

    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        unitId,
        tenantId,
        contractNumber: `HK-${sfx}`,
        monthlyRent: AVIBELOPP,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    leaseId = lease.id

    // `manualMatch` skriver `matchedBy` mot User (främmande nyckel). Utan en
    // riktig rad faller varje delbetalning med P2003, och riggen rapporterar
    // "övriga fel" i stället för att mäta samtidighet.
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `u-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Conc',
        lastName: 'Rigg',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id

    service = nyTjänst(prisma)
  })

  /**
   * STÄDNING I afterEach, INTE efter assertionerna.
   *
   * Ett fällande fall får inte förgifta nästa. Den första versionen städade
   * sist i varje `it`, efter `expect` — och när kanariefågeln fällde FALL 1
   * föll FALL 2 och 3 också, på FALL 1:s kvarlämnade rader. Två falska fynd
   * som såg ut som tre riktiga.
   *
   * Riktningen är FK-ordningen: barnen först. `Restrict` (inte `Cascade`) på
   * trettio modeller mot Organization gör att sekvenstabellerna måste bort före
   * organisationen — se `städaOrg`.
   */
  afterEach(async () => {
    await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
    await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    // Sekvenstabellerna är Restrict och måste bort FÖRE organisationen.
    // Uppmätt: utan raderna nedan kastar `organization.deleteMany` på
    // JournalEntrySequence_organizationId_fkey i afterAll, vilket jest
    // rapporterar som "Test suite failed to run" — ett riggfel som ser ut som
    // ett mätfel.
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    console.warn(`[SAMTIDIGHET] N=${N} pool=${POOL} tider(ms)=${JSON.stringify(tider)}`)
    await prisma.$disconnect()
  })

  /** En avi MED accrual bokförd — betalvägen är fail-closed på den (`:1765`). */
  async function avi(opts: { ocr: string; belopp?: number; månad?: number }): Promise<string> {
    const nr = ++räknare
    const belopp = opts.belopp ?? AVIBELOPP
    const månad = opts.månad ?? ((nr - 1) % 12) + 1
    const notice = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: opts.ocr,
        // PERIODEN VARIERAS, INTE DATUMET: @@unique([leaseId, year, month, type]).
        month: månad,
        year: 2026 + Math.floor((nr - 1) / 12),
        amount: belopp,
        totalAmount: belopp,
        dueDate: new Date(Date.UTC(2026, månad - 1, 27)),
        status: 'SENT',
        collectionStage: 'NONE',
        type: RentNoticeType.RENT,
      },
      select: { id: true, noticeNumber: true, year: true },
    })

    const acc = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    await acc.createJournalEntryForRentNotice(
      {
        id: notice.id,
        noticeNumber: notice.noticeNumber,
        amount: belopp,
        vatAmount: 0,
        totalAmount: belopp,
        year: notice.year,
        month: månad,
        unitId,
      } as never,
      orgId,
      null,
    )
    return notice.id
  }

  async function banktrans(opts: { ocr: string; belopp: number }) {
    return prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        date: new Date(Date.UTC(2026, 0, 28)),
        amount: opts.belopp,
        rawOcr: opts.ocr,
        description: 'samtidighetsrigg',
        status: 'UNMATCHED',
      },
    })
  }

  /** P2028 = transaktionen dog på timeout/maxWait. Räknas separat från nekad. */
  function klassa(utfall: PromiseSettledResult<boolean>[]) {
    let ok = 0
    let nekade = 0
    let p2028 = 0
    let deadlock = 0
    const övriga: string[] = []
    for (const r of utfall) {
      if (r.status === 'fulfilled') {
        if (r.value) ok++
        else nekade++
        continue
      }
      const skäl = r.reason as { code?: string; message?: string } | undefined
      const m = `${skäl?.code ?? ''} ${skäl?.message ?? String(r.reason)}`
      if (/P2028/.test(m)) p2028++
      else if (/deadlock|40P01/i.test(m)) deadlock++
      else övriga.push(m.slice(0, 120))
    }
    return { ok, nekade, p2028, deadlock, övriga }
  }

  /**
   * Håller ett `FOR UPDATE`-lås på en avi i en EGEN transaktion, på en EGEN
   * klient, tills `släpp()` anropas. Det är det som gör överlappningen TVINGAD
   * i stället för hoppad på: utan den är "två samtidiga" en tidsfråga, och en
   * körning där den ena hann klart före den andra mäter ingen samtidighet alls.
   */
  async function externtLås(noticeId: string) {
    const hållare = klient(3)
    let släppSignal: () => void = () => undefined
    const släppt = new Promise<void>((r) => {
      släppSignal = r
    })
    const låst = new Promise<void>((taget, fel) => {
      hållare
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${noticeId} FOR UPDATE`
            taget()
            await släppt
          },
          { timeout: 30_000, maxWait: 10_000 },
        )
        .catch(fel)
    })
    await låst
    return {
      släpp: async () => {
        släppSignal()
        // Ge hållaren en tick att committa innan konkurrenterna mäts klart.
        await new Promise((r) => setTimeout(r, 20))
        await hållare.$disconnect()
      },
    }
  }

  // ── FALL 1 ────────────────────────────────────────────────────────────────
  it(`FALL 1: ${N} samtidiga matchare mot SAMMA avi — exakt en allokerar`, async () => {
    const ocr = `950000${++räknare}`
    const noticeId = await avi({ ocr })
    const trans = await Promise.all(
      Array.from({ length: N }, () => banktrans({ ocr, belopp: AVIBELOPP })),
    )

    const t0 = Date.now()
    const utfall = await Promise.allSettled(trans.map((t) => service.matchTransaction(t, orgId)))
    tider['fall1'] = Date.now() - t0

    const k = klassa(utfall)
    const allok = await prisma.rentNoticePayment.findMany({
      where: { rentNoticeId: noticeId },
      select: { amount: true },
    })
    const verifikat = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'PAYMENT' },
    })
    const notice = await prisma.rentNotice.findUniqueOrThrow({
      where: { id: noticeId },
      select: { status: true },
    })
    const summa = allok.reduce((s, a) => s.add(a.amount), new Decimal(0))

    console.warn(
      `[FALL 1] N=${N} ok=${k.ok} nekade=${k.nekade} P2028=${k.p2028} deadlock=${k.deadlock} ` +
        `övriga=${k.övriga.length} allokeringar=${allok.length} Σ=${summa} verifikat=${verifikat} ` +
        `status=${notice.status} ${tider['fall1']}ms`,
    )
    if (k.övriga.length) console.warn(`[FALL 1] övriga: ${k.övriga.join(' | ')}`)

    expect(allok).toHaveLength(1)
    expect(summa.toString()).toBe(new Decimal(AVIBELOPP).toString())
    expect(verifikat).toBe(1)
    expect(k.ok).toBe(1)
    expect(k.p2028).toBe(0)
    expect(k.deadlock).toBe(0)
  }, 180_000)

  // ── FALL 2 ────────────────────────────────────────────────────────────────
  it(`FALL 2: ${N} samtidiga mot ${N} OLIKA avier — alla lyckas, inga deadlocks`, async () => {
    const par: Array<Awaited<ReturnType<typeof banktrans>>> = []
    for (let i = 0; i < N; i++) {
      const ocr = `9510${String(i).padStart(4, '0')}`
      await avi({ ocr, månad: (i % 12) + 1 })
      par.push(await banktrans({ ocr, belopp: AVIBELOPP }))
    }

    const t0 = Date.now()
    const utfall = await Promise.allSettled(par.map((t) => service.matchTransaction(t, orgId)))
    tider['fall2'] = Date.now() - t0

    const k = klassa(utfall)
    const allok = await prisma.rentNoticePayment.count({
      where: { rentNotice: { organizationId: orgId } },
    })
    console.warn(
      `[FALL 2] N=${N} ok=${k.ok} nekade=${k.nekade} P2028=${k.p2028} deadlock=${k.deadlock} ` +
        `övriga=${k.övriga.length} allokeringar=${allok} ${tider['fall2']}ms`,
    )
    if (k.övriga.length) console.warn(`[FALL 2] övriga: ${k.övriga.join(' | ')}`)

    expect(k.deadlock).toBe(0)
    expect(k.p2028).toBe(0)
    expect(k.ok).toBe(N)
    expect(allok).toBe(N)
  }, 180_000)

  // ── FALL 3 ────────────────────────────────────────────────────────────────
  it('FALL 3: vattenfall och delbetalning mot ÖVERLAPPANDE avier — överlappningen tvingad', async () => {
    const ocr = `9520001`
    const a1 = await avi({ ocr, månad: 1 })
    const a2 = await avi({ ocr, månad: 2 })
    const a3 = await avi({ ocr, månad: 3 })
    const skuld = new Decimal(AVIBELOPP).mul(3)

    const vattenfall = await banktrans({ ocr, belopp: AVIBELOPP * 3 })
    const del = await banktrans({ ocr, belopp: AVIBELOPP / 2 })

    // MITTENAVIN LÅSES UTIFRÅN. Vattenfallet låser i dueDate-ordning och
    // blockerar därför på a2 medan det håller a1; delbetalningen mot a2
    // blockerar direkt. Båda står stilla tills låset släpps — det är det som
    // gör att "samtidigt" betyder samtidigt.
    const lås = await externtLås(a2)

    const start = Date.now()
    const vTid: number[] = []
    const körning = Promise.allSettled([
      service.matchTransaction(vattenfall, orgId).finally(() => vTid.push(Date.now() - start)),
      service
        .manualMatch(del.id, { rentNoticeId: a2 }, orgId, userId)
        .then(() => true)
        .finally(() => vTid.push(Date.now() - start)),
    ])

    await new Promise((r) => setTimeout(r, HÅLLTID_MS))
    await lås.släpp()
    const utfall = await körning
    tider['fall3'] = Date.now() - start

    const k = klassa(utfall as PromiseSettledResult<boolean>[])
    const allok = await prisma.rentNoticePayment.findMany({
      where: { rentNoticeId: { in: [a1, a2, a3] } },
      select: { amount: true },
    })
    const summa = allok.reduce((s, a) => s.add(a.amount), new Decimal(0))
    const minstaVäntetid = Math.min(...vTid)

    console.warn(
      `[FALL 3] hålltid=${HÅLLTID_MS}ms väntetider=[${vTid.join(', ')}]ms ` +
        `ok=${k.ok} nekade=${k.nekade} P2028=${k.p2028} deadlock=${k.deadlock} ` +
        `övriga=${k.övriga.length} Σallokerat=${summa} skuld=${skuld} ${tider['fall3']}ms`,
    )
    if (k.övriga.length) console.warn(`[FALL 3] övriga: ${k.övriga.join(' | ')}`)

    // FÖRST detta gör Σ ≤ skuld till ett uttalande om samtidighet: båda
    // konkurrenterna VÄNTADE på låset. Blir den här assertionen röd har
    // överlappningen inte inträffat, och summan nedan säger inget.
    expect(minstaVäntetid).toBeGreaterThanOrEqual(HÅLLTID_MS)
    // DEN BÄRANDE INVARIANTEN.
    expect(summa.lte(skuld)).toBe(true)
    expect(k.deadlock).toBe(0)
    expect(k.p2028).toBe(0)
  }, 180_000)

  // ── FALL 4 ────────────────────────────────────────────────────────────────
  it.each([3, 12])(
    'FALL 4: vattenfallets hålltid för M=%i avier med samma OCR',
    async (M) => {
      const ocr = `953${String(M).padStart(4, '0')}`
      for (let i = 0; i < M; i++) await avi({ ocr, månad: (i % 12) + 1 })
      const t = await banktrans({ ocr, belopp: AVIBELOPP * M })

      const t0 = Date.now()
      const ok = await service.matchTransaction(t, orgId)
      const ms = Date.now() - t0
      tider[`fall4_M${M}`] = ms

      const allok = await prisma.rentNoticePayment.count({
        where: { rentNotice: { organizationId: orgId } },
      })
      console.warn(
        `[FALL 4] M=${M} ok=${ok} allokeringar=${allok} hålltid=${ms}ms ` +
          `tak=${PAYMENT_TX_LIMITS.timeout}ms marginal=${(PAYMENT_TX_LIMITS.timeout / Math.max(ms, 1)).toFixed(1)}x ` +
          `per_avi=${(ms / M).toFixed(1)}ms`,
      )
      // Taket LÄSES ur PAYMENT_TX_LIMITS, aldrig skrivet här. En upplysning med
      // en gräns: faller den betyder det att hålltiden närmar sig taket.
      expect(ms).toBeLessThan(PAYMENT_TX_LIMITS.timeout)
      expect(allok).toBe(M)
    },
    180_000,
  )

  // ── FALL 5: DEN OMVÄNDA RIKTNINGEN ────────────────────────────────────────
  //
  // Spärrar är riktade. FALL 1–3 mäter att ingen slinker igenom; den omvända
  // frågan är om någon väg håller låset så länge att andra svälter.
  //
  // Vattenfallet är den vägen: det låser ALLA kandidater med samma OCR och
  // håller dem genom hela transaktionen. Konstruktionen nedan gör hålltiden
  // deterministisk i stället för att jaga ett tidsfönster: den SISTA avin i
  // dueDate-ordningen låses utifrån, så vattenfallet blockerar där medan det
  // håller de M−1 föregående. En konkurrent mot den FÖRSTA avin får då vänta
  // på vattenfallet, och väntetiden är det tal frågan handlar om.
  it(`FALL 5: en konkurrents väntetid medan vattenfallet håller ${12} lås`, async () => {
    const M = 12
    const ocr = `9540001`
    const ids: string[] = []
    for (let i = 0; i < M; i++) ids.push(await avi({ ocr, månad: i + 1 }))
    const första = ids[0] as string
    const sista = ids[M - 1] as string

    const vattenfall = await banktrans({ ocr, belopp: AVIBELOPP * M })
    const konkurrent = await banktrans({ ocr, belopp: AVIBELOPP / 2 })

    const lås = await externtLås(sista)

    const vf = service.matchTransaction(vattenfall, orgId).catch(() => false)
    // Låt vattenfallet hinna ta sina M−1 lås innan konkurrenten anländer.
    await new Promise((r) => setTimeout(r, 120))

    const kStart = Date.now()
    const kUtfall = service
      .manualMatch(konkurrent.id, { rentNoticeId: första }, orgId, userId)
      .then(() => 'ok')
      .catch((e: { code?: string; message?: string }) => `${e?.code ?? ''}${e?.message ?? ''}`)

    await new Promise((r) => setTimeout(r, HÅLLTID_MS))
    await lås.släpp()

    const [vfOk, kSvar] = await Promise.all([vf, kUtfall])
    const väntetid = Date.now() - kStart
    tider['fall5_väntetid'] = väntetid

    console.warn(
      `[FALL 5] M=${M} vattenfall=${vfOk} konkurrentens_väntetid=${väntetid}ms ` +
        `maxWait=${PAYMENT_TX_LIMITS.maxWait}ms marginal=${(PAYMENT_TX_LIMITS.maxWait / Math.max(väntetid, 1)).toFixed(2)}x ` +
        `konkurrentens_svar=${String(kSvar).slice(0, 60)}`,
    )

    // Konkurrenten VÄNTADE (annars mäter provet ingen svält alls) …
    expect(väntetid).toBeGreaterThanOrEqual(HÅLLTID_MS - 120)
    // … men inte längre än budgeten. Talet LÄSES ur PAYMENT_TX_LIMITS.
    //
    // OBS om valet av gräns: `maxWait` är strikt sett budgeten för att få en
    // ANSLUTNING ur poolen, medan låsväntan bärs av `timeout` (8 s). maxWait är
    // den STRÄNGARE av de två och används därför som tak här — men skälet är
    // valet av marginal, inte att maxWait skulle vara den mekanism som fäller.
    expect(väntetid).toBeLessThan(PAYMENT_TX_LIMITS.maxWait)
  }, 180_000)

  // ── KANARIEFÅGELN ─────────────────────────────────────────────────────────
  //
  // En rigg som inte kan se en överallokering mäter inte det den påstår.
  // Provet kör FALL 1 igen på en klient där varje `SELECT … FOR UPDATE` gjorts
  // till en no-op, och KRÄVER att allokeringarna blir fler än en.
  //
  // GRÄNSEN: patchen ligger på Prisma-klienten, inte på tjänstefilen. Provet
  // bevisar att riggen ser en överallokering när serialiseringen försvinner —
  // inte att just raden `reconciliation.service.ts:1517` är den enda som
  // hindrar den. Det senare kräver att man muterar tjänsten, och det gör den
  // här filen med flit inte.
  it('KANARIEFÅGEL: utan radlåset ser riggen överallokering', async () => {
    const utanLås = klient(POOL)
    const original = utanLås.$transaction.bind(utanLås)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(utanLås as any).$transaction = (arg: unknown, opts?: unknown) => {
      if (typeof arg !== 'function') return original(arg as never, opts as never)
      return original(async (tx: Prisma.TransactionClient) => {
        const rå = tx.$queryRaw.bind(tx)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(tx as any).$queryRaw = (q: TemplateStringsArray, ...v: unknown[]) => {
          const text = Array.isArray(q) ? q.join('?') : String(q)
          if (/FOR UPDATE/i.test(text)) return Promise.resolve([])
          return rå(q, ...(v as never[]))
        }
        return (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(tx)
      }, opts as never)
    }

    const ocr = `9550001`
    const noticeId = await avi({ ocr })
    const trans = await Promise.all(
      Array.from({ length: N }, () => banktrans({ ocr, belopp: AVIBELOPP })),
    )

    const utfall = await Promise.allSettled(
      trans.map((t) => nyTjänst(utanLås).matchTransaction(t, orgId)),
    )
    const k = klassa(utfall)
    const allok = await prisma.rentNoticePayment.findMany({
      where: { rentNoticeId: noticeId },
      select: { amount: true },
    })
    const summa = allok.reduce((s, a) => s.add(a.amount), new Decimal(0))
    console.warn(
      `[KANARIE] utan lås: ok=${k.ok} allokeringar=${allok.length} Σ=${summa} ` +
        `skuld=${AVIBELOPP} (kräver Σ > skuld)`,
    )
    await utanLås.$disconnect()

    expect(allok.length).toBeGreaterThan(1)
    expect(summa.gt(new Decimal(AVIBELOPP))).toBe(true)
  }, 180_000)
})
