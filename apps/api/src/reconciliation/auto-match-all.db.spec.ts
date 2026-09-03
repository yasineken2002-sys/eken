/**
 * `autoMatchAll` — LOOPEN, inte matchningsreglerna.
 *
 * ── VAD DEN HÄR FILEN ÄGER, OCH VAD DEN INTE GÖR ────────────────────────────
 *
 * `waterfall-allocation.db.spec.ts` (#696) äger vattenfallets ALLOKERINGS-
 * semantik: exakt summa, en och en halv avi, överbetalning, underbetalning.
 * Den här filen äger `autoMatchAll` som BULKKÖRNING — kandidatfiltret,
 * ordningen, räknarna, felisoleringen och idempotensen. Där de rör samma
 * mekanism (FALL B) är frågan här en annan: räknar `matched` TRANSAKTIONER
 * eller ALLOKERINGAR? Allokeringsreglerna prövas inte om.
 *
 * ── VAD RADEN PÅSTOD, OCH VAD SOM SAKNADES ──────────────────────────────────
 *
 * `docs/revision-status.md` bär "autoMatchAll sväljer fel tyst" (L1) som LÖST
 * sedan #480 + #556: `failed` räknas separat, loggas per rad och summeras, och
 * `unmatched` sväljer dem inte. Det var ett påstående om kod, inte en mätning.
 * FALL F är mätningen: en transaktion som KASTAR mitt i en bulkkörning ska inte
 * stoppa de övriga, inte lämna en halv allokering, och en omkörning ska inte
 * dubblera något.
 *
 * ── KODEN SOM MÄTS (fil:rad mot `reconciliation.service.ts`) ────────────────
 *
 *   :1865  autoMatchAll
 *   :1867  kandidatfiltret — `status: 'UNMATCHED'`, INGET `take`
 *   :1868  ordningen — `orderBy: { date: 'asc' }`
 *   :1899  `failed++`, körningen fortsätter
 *   :1930  invarianten `matched + unmatched + failed === candidates.length`
 *
 * Matchningsvägarnas prioritet, inne i `matchTransaction`:
 *
 *   1. OCR exakt      :809-949   faktura → avi → vattenfall
 *   2. Referens       :953-1046  faktura-/avinummer läst ur `description`
 *   3. Fuzzy          :1061-1185 belopp inom 1 kr, ±90 dagar, över BÅDA tabellerna
 *
 * Två grindar: är `rawOcr` satt men olöst hoppas fuzzy över MED FLIT (:1052),
 * och flera kandidater i fuzzy ger ingen match alls (:1109).
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 *  • FUZZY-TOLERANSEN. `const tolerance = new Decimal('1.00')` är en LOKAL
 *    variabel inne i `matchTransaction` och går inte att nå utifrån. Filen kan
 *    därför pröva att beloppskontrollen säger JA när den ska (FALL D) och NEJ
 *    när den ska (FALL D2), men inte neutralisera den. Kanariefågeln som gör
 *    det — `Decimal.prototype.abs → 0` — ligger i scratchpad och inte här:
 *    patchen är global och rör vattenfallets jämförelse också, så den kan inte
 *    stå bredvid proven utan att störa dem. Uppmätt med den: D2 går 0 → 1
 *    matchningar mot en transaktion på 14 000 kr och en avi på 9 000.
 *  • Att `logger.error`/`logger.warn` faktiskt NÅR någon. Loggaren är en
 *    attrapp här; att raderna skrivs ägs av tjänstens egen enhetsspec.
 *  • Samtidighet. En bulkkörning parallellt med en annan mäts i
 *    `concurrency-under-load.db.spec.ts`.
 *
 * ── POOLEN ──────────────────────────────────────────────────────────────────
 *
 * Samma krav som #695: Prismas default är `nproc × 2 + 1` (två kärnor → 5,
 * prod 48 → ~97), och P2028 skiljer inte pooluttömning från låsväntan. Filen
 * sätter `connection_limit` själv så talet är oberoende av runnerns kärnantal.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, RentNoticeType } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { ReconciliationService } from './reconciliation.service'

const Decimal = Prisma.Decimal
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const POOL = 25
const AVIBELOPP = 9000

function klient(pool: number): PrismaClient {
  const u = new URL(process.env.DATABASE_URL as string)
  u.searchParams.set('connection_limit', String(pool))
  return new PrismaClient({ datasources: { db: { url: u.toString() } } })
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('autoMatchAll som bulkkörning', () => {
  let prisma: PrismaClient
  let service: ReconciliationService
  let orgId: string
  let tenantId: string
  let unitId: string
  let leaseId: string
  let userId: string
  let räknare = 0
  const utfall: Record<string, unknown> = {}

  beforeAll(async () => {
    prisma = klient(POOL)
    const sfx = randomUUID().slice(0, 8)

    const org = await prisma.organization.create({
      data: {
        name: `l1-${sfx}`,
        email: `l1-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5560${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    orgId = org.id

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
        propertyDesignation: `L1 ${sfx}`,
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
        firstName: 'L',
        lastName: 'Ett',
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
    // riktig rad faller varje manuell matchning med P2003, och FALL H hade
    // rapporterat ett riggfel som ett fynd om koden.
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `u-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Auto',
        lastName: 'Rigg',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id

    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    service = Object.create(ReconciliationService.prototype) as ReconciliationService
    Object.assign(service, {
      prisma,
      accounting,
      rentNoticeEvents: new RentNoticeEventsService(prisma as never),
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
  })

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
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    console.warn(`[autoMatchAll] utfall: ${JSON.stringify(utfall, null, 1)}`)
    await prisma.$disconnect()
  })

  async function avi(opts: { ocr: string; belopp?: number; månad?: number }): Promise<string> {
    const nr = ++räknare
    const belopp = opts.belopp ?? AVIBELOPP
    const månad = opts.månad ?? ((nr - 1) % 12) + 1
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: opts.ocr,
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
        id: n.id,
        noticeNumber: n.noticeNumber,
        amount: belopp,
        vatAmount: 0,
        totalAmount: belopp,
        year: n.year,
        month: månad,
        unitId,
      } as never,
      orgId,
      null,
    )
    return n.id
  }

  async function bt(opts: { ocr?: string; belopp: number; datum?: Date; beskrivning?: string }) {
    return prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        date: opts.datum ?? new Date(Date.UTC(2026, 0, 28)),
        amount: opts.belopp,
        ...(opts.ocr ? { rawOcr: opts.ocr } : {}),
        description: opts.beskrivning ?? 'l1-rigg',
        status: 'UNMATCHED',
      },
    })
  }

  async function läge(märke: string) {
    const [allokRader, verifikat, txar] = await Promise.all([
      prisma.rentNoticePayment.findMany({
        where: { rentNotice: { organizationId: orgId } },
        select: { amount: true },
      }),
      prisma.journalEntry.count({ where: { organizationId: orgId, source: 'PAYMENT' } }),
      prisma.bankTransaction.findMany({
        where: { organizationId: orgId },
        select: { status: true, matchedRentNoticeId: true, matchedBy: true },
      }),
    ])
    const status = txar
      .map((t) => t.status)
      .sort()
      .join(',')
    const summa = allokRader.reduce((x, a) => x.add(a.amount), new Decimal(0)).toString()
    const rad = {
      allokeringar: allokRader.length,
      Σallokerat: summa,
      betalverifikat: verifikat,
      txStatus: status,
    }
    utfall[märke] = rad
    return rad
  }

  // ── FALL A: entydig OCR-träff ─────────────────────────────────────────────
  it('A: entydig OCR-träff → matched=1', async () => {
    const ocr = `960000${++räknare}`
    await avi({ ocr, månad: 1 })
    await bt({ ocr, belopp: AVIBELOPP })
    const r = await service.autoMatchAll(orgId)
    const l = await läge('A_entydig_ocr')
    console.warn(`[autoMatchAll A] ${JSON.stringify(r)}  ${JSON.stringify(l)}`)
    expect(r).toMatchObject({ matched: 1, unmatched: 0, failed: 0, skippedUnresolvedOcr: 0 })
    expect(l).toMatchObject({ allokeringar: 1, betalverifikat: 1, txStatus: 'MATCHED' })
  }, 180_000)

  // ── FALL B: två avier med samma OCR ───────────────────────────────────────
  // Frågan här är autoMatchAll:s RÄKNING, inte vattenfallets fördelning —
  // den ägs av waterfall-allocation.db.spec.ts (#696). En transaktion som
  // fördelas över två avier ska räknas som EN matchning, inte två.
  it('B: en transaktion som vattenfaller över två avier räknas som EN matchning', async () => {
    const ocr = `9610001`
    await avi({ ocr, månad: 1 })
    await avi({ ocr, månad: 2 })
    await bt({ ocr, belopp: AVIBELOPP * 2 })
    const r = await service.autoMatchAll(orgId)
    const l = await läge('B_tva_avier_samma_ocr')
    console.warn(`[autoMatchAll B] ${JSON.stringify(r)}  ${JSON.stringify(l)}`)
    // Vattenfallet (`:941`) ska fördela över båda — inte stoppa.
    expect(r.matched).toBe(1)
    expect(l.allokeringar).toBe(2)
    expect(l.betalverifikat).toBe(2)
  }, 180_000)

  // ── FALL C: OCR matchar men beloppet avviker ──────────────────────────────
  it('C: OCR matchar, beloppet avviker → delbetalning eller UNMATCHED?', async () => {
    const ocr = `9620001`
    await avi({ ocr, månad: 1 })
    await bt({ ocr, belopp: AVIBELOPP / 2 })
    const r = await service.autoMatchAll(orgId)
    const l = await läge('C_ocr_belopp_avviker')
    console.warn(`[autoMatchAll C] ${JSON.stringify(r)}  ${JSON.stringify(l)}`)
    // Mätning, inte förväntan: skrivs det ut vad som faktiskt händer.
    expect(r.matched + r.unmatched).toBe(1)
  }, 180_000)

  // ── FALL D: ingen OCR, belopp + hyresgäst matchar ─────────────────────────
  it('D: ingen OCR men belopp matchar → fuzzy', async () => {
    // MÅNADEN ÄR LÅST. Hjälparens default varierar månaden med en global
    // räknare, och fuzzy-grenens fönster är ±90 dagar kring transaktionens
    // datum (`:1067-1069`). Med en drivande månad hamnade avin utanför
    // fönstret och riggen rapporterade "fuzzy matchar inte" — ett riggfel som
    // ser ut som ett fynd om koden.
    await avi({ ocr: `9630001`, månad: 1 })
    await bt({ belopp: AVIBELOPP, datum: new Date(Date.UTC(2026, 0, 28)) })
    const r = await service.autoMatchAll(orgId)
    const l = await läge('D_ingen_ocr_belopp_matchar')
    console.warn(`[autoMatchAll D] ${JSON.stringify(r)}  ${JSON.stringify(l)}`)
    expect(r.skippedUnresolvedOcr).toBe(0)
    expect(r.matched + r.unmatched).toBe(1)
    // Fuzzy SKA matcha här: unik kandidat, belopp inom 1 kr, inom fönstret.
    expect(r.matched).toBe(1)
  }, 180_000)

  // ── FALL D2: ingen OCR och beloppet stämmer INTE ──────────────────────────
  //
  // Motprovet till D, och det som gör kanariefågeln möjlig. Utan det här fallet
  // mäter riggen bara att fuzzy SÄGER JA när den ska — aldrig att den säger NEJ
  // när den ska.
  it('D2: ingen OCR och beloppet stämmer inte → ingen match', async () => {
    await avi({ ocr: `9631001`, månad: 1 })
    await bt({ belopp: AVIBELOPP + 5000, datum: new Date(Date.UTC(2026, 0, 28)) })
    const r = await service.autoMatchAll(orgId)
    const l = await läge('D2_belopp_stammer_inte')
    console.warn(`[autoMatchAll D2] ${JSON.stringify(r)}  ${JSON.stringify(l)}`)
    expect(r.matched).toBe(0)
    expect(r.unmatched).toBe(1)
    expect(l.allokeringar).toBe(0)
    expect(l.betalverifikat).toBe(0)
    expect(l.txStatus).toBe('UNMATCHED')
  }, 180_000)

  // ── FALL E: redan matchad transaktion ─────────────────────────────────────
  it('E: en redan MATCHED transaktion är inte kandidat', async () => {
    const ocr = `9640001`
    await avi({ ocr, månad: 1 })
    await bt({ ocr, belopp: AVIBELOPP })
    const första = await service.autoMatchAll(orgId)
    const andra = await service.autoMatchAll(orgId)
    const l = await läge('E_redan_matchad')
    console.warn(
      `[autoMatchAll E] första=${JSON.stringify(första)} andra=${JSON.stringify(andra)} ${JSON.stringify(l)}`,
    )
    expect(första.matched).toBe(1)
    // OMKÖRNINGEN får inte se transaktionen igen — kandidatfiltret är
    // status: 'UNMATCHED' (`:1867`).
    expect(andra).toMatchObject({ matched: 0, unmatched: 0, failed: 0 })
    expect(l.allokeringar).toBe(1)
    expect(l.betalverifikat).toBe(1)
  }, 180_000)

  // ── FALL F: körningen kastar halvvägs ─────────────────────────────────────
  it('F: en transaktion kastar mitt i → resten fortsätter, och omkörning är idempotent', async () => {
    const ok1 = `9650001`
    const trasig = `9650002`
    const ok2 = `9650003`
    await avi({ ocr: ok1, månad: 1 })
    const trasigAvi = await avi({ ocr: trasig, månad: 2 })
    await avi({ ocr: ok2, månad: 3 })
    // Ordningen är date asc (`:1868`) — datumen styr vilken som är "mitten".
    await bt({ ocr: ok1, belopp: AVIBELOPP, datum: new Date(Date.UTC(2026, 0, 10)) })
    await bt({ ocr: trasig, belopp: AVIBELOPP, datum: new Date(Date.UTC(2026, 0, 20)) })
    await bt({ ocr: ok2, belopp: AVIBELOPP, datum: new Date(Date.UTC(2026, 0, 30)) })

    // Gör MITTEN-avins bokföring omöjlig: ta bort dess accrual. Betalvägen är
    // fail-closed mot `rent-notice:<id>` (`:1765`) och kastar då.
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId, sourceId: `rent-notice:${trasigAvi}` } },
    })
    await prisma.journalEntry.deleteMany({
      where: { organizationId: orgId, sourceId: `rent-notice:${trasigAvi}` },
    })

    const första = await service.autoMatchAll(orgId)
    const efterFörsta = await läge('F_efter_forsta')
    const andra = await service.autoMatchAll(orgId)
    const efterAndra = await läge('F_efter_andra')
    console.warn(
      `[autoMatchAll F] första=${JSON.stringify(första)} läge=${JSON.stringify(efterFörsta)}\n` +
        `[autoMatchAll F] andra=${JSON.stringify(andra)} läge=${JSON.stringify(efterAndra)}`,
    )

    // Körningen avbryts INTE (`:1899` failed++ och vidare).
    expect(första.failed).toBe(1)
    expect(första.matched).toBe(2)
    // Den trasiga transaktionen rullades tillbaka helt — ingen halv allokering.
    expect(efterFörsta.allokeringar).toBe(2)
    expect(efterFörsta.betalverifikat).toBe(2)
    // OMKÖRNINGEN: de två lyckade är MATCHED och inte kandidater igen; den
    // trasiga försöker igen och kastar igen. Ingen dubblering.
    expect(andra).toMatchObject({ matched: 0, failed: 1 })
    expect(efterAndra.allokeringar).toBe(2)
    expect(efterAndra.betalverifikat).toBe(2)
  }, 180_000)

  // ── FALL G: EN MÄNNISKAS AVMATCHNING ÖVERLEVER NÄSTA AUTOKÖRNING ──────────
  //
  // `unmatchTransaction` sätter raden tillbaka till `UNMATCHED` (`:2919`) och
  // nollar länkarna — exakt det tillstånd `autoMatchAll`s kandidatfilter letar
  // efter (`:1867`). Före `autoMatchExcludedAt` åter-matchade nästa bulkkörning
  // samma transaktion mot samma avi, med ett TREDJE verifikat i huvudboken, och
  // operatörens beslut var ogjort utan att något sa ifrån.
  it('G: auto → unmatch → auto igen ger NOLL nya allokeringar och NOLL nya verifikat', async () => {
    const ocr = `9670001`
    const noticeId = await avi({ ocr, månad: 1 })
    const tx = await bt({ ocr, belopp: AVIBELOPP })

    const första = await service.autoMatchAll(orgId)
    const efterMatch = await läge('G_efter_match')

    await service.unmatchTransaction(tx.id, orgId, userId, 'riggens avmatchning')
    const efterUnmatch = await läge('G_efter_unmatch')

    const andra = await service.autoMatchAll(orgId)
    const efterOmkörning = await läge('G_efter_omkorning')

    const rad = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: tx.id },
      select: { status: true, autoMatchExcludedAt: true },
    })
    const notice = await prisma.rentNotice.findUniqueOrThrow({
      where: { id: noticeId },
      select: { status: true },
    })
    console.warn(
      `[autoMatchAll G] match=${JSON.stringify(första)} → ${JSON.stringify(efterMatch)}\n` +
        `[autoMatchAll G] unmatch → ${JSON.stringify(efterUnmatch)}\n` +
        `[autoMatchAll G] auto igen=${JSON.stringify(andra)} → ${JSON.stringify(efterOmkörning)} ` +
        `txStatus=${rad.status} stämplad=${rad.autoMatchExcludedAt !== null} avi=${notice.status}`,
    )

    expect(första.matched).toBe(1)
    // Stämpeln sattes av avmatchningen …
    expect(rad.autoMatchExcludedAt).not.toBeNull()
    // … och raden är fortfarande UNMATCHED, inte IGNORED: den SKA stämmas av,
    // bara inte av automatiken.
    expect(rad.status).toBe('UNMATCHED')
    // DEN BÄRANDE ASSERTIONEN: omkörningen ser den inte alls.
    expect(andra).toMatchObject({ matched: 0, unmatched: 0, failed: 0 })
    expect(efterOmkörning.allokeringar).toBe(efterUnmatch.allokeringar)
    expect(efterOmkörning.betalverifikat).toBe(efterUnmatch.betalverifikat)
    expect(notice.status).not.toBe('PAID')
  }, 180_000)

  // ── FALL H: MEN EN MÄNNISKA FÅR MATCHA OM ─────────────────────────────────
  //
  // Motprovet till G, och det som gör G till en avgränsning i stället för en
  // återvändsgränd. Fältet säger "automatiken hade fel", inte "rör den inte" —
  // `manualMatch` går inte via kandidatfiltret och ska lyckas direkt, utan att
  // något behöver nollställas.
  it('H: auto → unmatch → MANUELL match lyckas ändå', async () => {
    const ocr = `9680001`
    const noticeId = await avi({ ocr, månad: 1 })
    const tx = await bt({ ocr, belopp: AVIBELOPP })

    await service.autoMatchAll(orgId)
    await service.unmatchTransaction(tx.id, orgId, userId, 'riggens avmatchning')
    const efterUnmatch = await läge('H_efter_unmatch')

    await service.manualMatch(tx.id, { rentNoticeId: noticeId }, orgId, userId)
    const efterManuell = await läge('H_efter_manuell')

    const rad = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: tx.id },
      select: { status: true, autoMatchExcludedAt: true },
    })
    console.warn(
      `[autoMatchAll H] unmatch → ${JSON.stringify(efterUnmatch)} ` +
        `manuell → ${JSON.stringify(efterManuell)} txStatus=${rad.status} ` +
        `stämplad=${rad.autoMatchExcludedAt !== null}`,
    )

    expect(rad.status).toBe('MATCHED')
    expect(efterManuell.allokeringar).toBe(efterUnmatch.allokeringar + 1)
    // Stämpeln står kvar och behöver inte nollställas: raden är MATCHED och
    // faller därmed ur automatikens filter ändå.
    expect(rad.autoMatchExcludedAt).not.toBeNull()
  }, 180_000)
})
