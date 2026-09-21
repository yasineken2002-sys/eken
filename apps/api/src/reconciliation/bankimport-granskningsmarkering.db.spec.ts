/**
 * GRANSKNINGSMARKERINGEN SOM SPÄRR — mätt mot riktig databas (#F034c).
 *
 * ── VAD SOM VAR FEL PÅ `07465332`, OCH VARFÖR DET INTE SYNTES ───────────────
 *
 * Importen fattade rätt beslut. `ingestFromFile` upptäckte att raden krockade
 * med en KONTOLÖS historisk rad, kunde inte avgöra om det var samma betalning,
 * lagrade raden, stämplade `identityReviewAt` och hoppade över matchningen.
 *
 * Beslutet höll i sekunder. `autoMatchAll` hämtar VARJE `UNMATCHED` rad i
 * organisationen — granskningsraden är per definition `UNMATCHED` — och
 * filtrerade bara på `autoMatchExcludedAt`. En operatör som tryckte "Matcha
 * alla" efter importen fick alltså raden allokerad, avin betald och ett
 * verifikat i huvudboken, för en betalning systemet just sagt att det inte vet
 * om den ägt rum. `matchTransaction` hade ingen egen spärr, så varje automatisk
 * väg dit gav samma svar.
 *
 * Ingenting larmade, därför att varje steg för sig var korrekt: importen sa
 * "granska", bulkmatchningen sa "matchade N". Det var bara ordningen som var
 * fel, och den syns inte i något av de två utfallen.
 *
 * UPPMÄTT PÅ `07465332` med den här filen (tjänsten återställd byte för byte
 * efteråt, sha256 kontrollerad): `autoMatchAll` svarade `matched: 2` där G2
 * kräver `1` — den stämplade raden matchades, allokerades och bokfördes. Sju av
 * tretton prov föll. Råutfallet ligger i
 * `T2/bevis/21-REPRODUKTION-punkt3-4-pa-07465332.log`.
 *
 * DE SEX SOM PASSERADE PÅ BASEN är lika viktiga: G1, G3-NK, G4, G5 och A3 mäter
 * beteende som SKULLE stå kvar. Att de var gröna både före och efter är det som
 * skiljer en rättelse från en omskrivning.
 *
 * ── DEN ANDRA DÖRREN: CROSS-SOURCE-DEDUPEN ──────────────────────────────────
 *
 * Uppmätt på samma revision: A1 fick `duplicates: 1, imported: 0` — filradens
 * betalning nådde aldrig databasen.
 *
 * `ingestFromFile` frågade FÖRST om någon PSD2-API-rad delar `dedupKey`, och
 * svarade `duplicate` om någon gjorde det. `dedupKey` är Stockholm-dag + belopp
 * + OCR och bär INGET konto — och `ingestFromApi` sätter i dag aldrig
 * `bankAccountId`. Varje API-rad är alltså kontolös, och grenen räknade okänd
 * kontotillhörighet som en SÄKER dubblett. Frågan besvarades dessutom FÖRE
 * kontokontrollen, så en verklig betalning på ett annat konto försvann tyst.
 *
 * ── VAD FILEN MÄTER, OCH VAD DEN INTE MÄTER ─────────────────────────────────
 *
 * Mäter: allokeringar, avistatus och VERIFIKAT, inte bara räknare. En spärr som
 * bara får en räknare att stå still har inte bevisat att ingenting bokfördes.
 *
 * Mäter inte: samtidighet (den ägs av `bankimport-filidempotens.db.spec.ts`),
 * matchningsreglerna (`auto-match-all.db.spec.ts`), och inte heller vad en
 * operatör SER — webbmärket har sitt eget prov.
 *
 * ── GRÄNSEN, MÄTT I STÄLLET FÖR PÅSTÅDD ─────────────────────────────────────
 *
 * G6 mäter något spärren INTE gör: kravtrappan känner inte till granskningskön.
 * Den gränsen är redovisad och oavgjord, inte löst — se noten i provet och
 * RAPPORT.md. Att den ligger som ett PROV och inte bara som en mening är
 * poängen: en gräns som bara står i prosa märker ingen när den ändras.
 *
 * ── NEGATIVKONTROLLEN ───────────────────────────────────────────────────────
 *
 * Varje spärrprov kör bulkmatchningen med TVÅ rader: den stämplade och en
 * ostämplad som ska matcha. Utan den hade "0 matchningar" kunnat betyda att
 * riggen inte kunde matcha någonting alls — en spärr som är grön för att
 * ingenting fungerar är ingen spärr. `matched: 1` i samma körning är det som
 * gör `UNMATCHED` på den stämplade raden till ett påstående om spärren.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, RentNoticeType } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { BankImportAttemptService } from './bank-import-attempt.service'
import { ReconciliationService, computeBankDedupKey } from './reconciliation.service'

const Decimal = Prisma.Decimal
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const POOL = 10
const BELOPP = 9000

function klient(): PrismaClient {
  const u = new URL(process.env.DATABASE_URL as string)
  u.searchParams.set('connection_limit', String(POOL))
  return new PrismaClient({ datasources: { db: { url: u.toString() } } })
}

function orört(namn: string): unknown {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`${namn} skulle inte röras`)
      },
    },
  )
}

const HUVUD = 'Datum,Text,Belopp,Referens'
const DATUM = '2026-03-02'
const TEXT = 'Insattning hyra'
function rad(ocr: string, belopp = BELOPP): string {
  return `${DATUM},${TEXT},${belopp}.00,${ocr}`
}
function csv(...ocr: string[]): Buffer {
  return Buffer.from([HUVUD, ...ocr.map((o) => rad(o))].join('\n'), 'utf8')
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('granskningsmarkeringen stoppar automatiken (#F034c)', () => {
  let prisma: PrismaClient
  let recon: ReconciliationService
  let orgId: string
  let tenantId: string
  let unitId: string
  let leaseId: string
  let userId: string
  let kontoA: string
  let kontoA2: string
  let ocrRäknare = 0
  let aviRäknare = 0
  const utfall: Record<string, unknown> = {}

  /** Ett OCR med giltig Luhn-kontrollsiffra, unikt per anrop. */
  function nyttOcr(): string {
    const bas = `9${String(++ocrRäknare).padStart(8, '0')}`
    let summa = 0
    let dubbla = true
    for (let i = bas.length - 1; i >= 0; i--) {
      let d = Number(bas[i])
      if (dubbla) {
        d *= 2
        if (d > 9) d -= 9
      }
      summa += d
      dubbla = !dubbla
    }
    return `${bas}${(10 - (summa % 10)) % 10}`
  }

  beforeAll(async () => {
    prisma = klient()
    const sfx = randomUUID().slice(0, 8)

    const org = await prisma.organization.create({
      data: {
        name: `gm-${sfx}`,
        email: `gm-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5562${sfx.slice(0, 6)}`,
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
        propertyDesignation: `GM ${sfx}`,
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
        monthlyRent: BELOPP,
        status: 'OCCUPIED',
      },
      select: { id: true },
    })
    unitId = unit.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'G',
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
        monthlyRent: BELOPP,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    leaseId = lease.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `u-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'Gransk',
        lastName: 'Rigg',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id

    const konto = async (namn: string) =>
      (
        await prisma.bankAccount.create({
          data: { organizationId: orgId, name: namn },
          select: { id: true },
        })
      ).id
    kontoA = await konto('Foretagskonto')
    kontoA2 = await konto('Klientmedelskonto')

    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    recon = Object.create(ReconciliationService.prototype) as ReconciliationService
    Object.assign(recon, {
      prisma,
      accounting,
      rentNoticeEvents: new RentNoticeEventsService(prisma as never),
      invoices: orört('invoices'),
      events: orört('events'),
      freshness: {
        recordImportStarted: async () => undefined,
        recordPaymentDataThrough: async () => undefined,
      },
      // Riktiga stubbar: kön och facit ANROPAS på de vägar som mäts här, och
      // en Proxy som kastar hade gjort dem till en förutsättning för
      // avstämningen — precis det de inte får vara.
      betalningsSkugga: { enqueue: async () => 'jobb' },
      betalningsFacit: {
        skrivFacitMatchad: async () => undefined,
        skrivFacitIngen: async () => undefined,
        nollstallFacit: async () => undefined,
      },
      attempts: new BankImportAttemptService(prisma as never),
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
    await prisma.bankImportAttempt.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.bankAccount.deleteMany({ where: { organizationId: orgId } })
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
    console.warn(`[granskningsmarkering] utfall: ${JSON.stringify(utfall, null, 1)}`)
    await prisma.$disconnect()
  })

  /**
   * En avi som den importerade raden KAN matcha, med bokfört fordringsverifikat.
   *
   * MÅNADEN VÄLJS AV RIGGEN. `RentNotice` bär `@@unique([leaseId, year, month,
   * type])`, och två avier i samma månad blir ett P2002 som ser ut som ett fynd
   * om koden. Räknaren gör kollisionen omöjlig i stället för att varje prov ska
   * behöva hålla reda på vilken månad det förra tog.
   */
  async function avi(ocr: string): Promise<string> {
    const månad = ((++aviRäknare - 1) % 12) + 1
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: ocr,
        month: månad,
        year: 2026,
        amount: BELOPP,
        totalAmount: BELOPP,
        dueDate: new Date(Date.UTC(2026, månad - 1, 27)),
        status: 'SENT',
        collectionStage: 'NONE',
        type: RentNoticeType.RENT,
      },
      select: { id: true, noticeNumber: true },
    })
    const acc = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    await acc.createJournalEntryForRentNotice(
      {
        id: n.id,
        noticeNumber: n.noticeNumber,
        amount: BELOPP,
        vatAmount: 0,
        totalAmount: BELOPP,
        year: 2026,
        month: månad,
        unitId,
      } as never,
      orgId,
      null,
    )
    return n.id
  }

  /**
   * Den KONTOLÖSA historiska raden. `IGNORED` med flit: en `UNMATCHED`
   * historikrad hade själv varit kandidat i bulkkörningen, och då hade provet
   * inte kunnat skilja "spärren höll" från "den andra raden tog avin först".
   */
  async function historiskRadUtanKonto(ocr: string): Promise<string> {
    const rad = await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        bankAccountId: null,
        date: new Date(`${DATUM}T00:00:00.000Z`),
        description: TEXT,
        amount: new Decimal(BELOPP),
        reference: ocr,
        rawOcr: ocr,
        status: 'IGNORED',
      },
      select: { id: true },
    })
    return rad.id
  }

  /** En PSD2-API-rad (`externalId` satt) med valfri kontotillhörighet. */
  async function apiRad(ocr: string, bankAccountId: string | null): Promise<string> {
    const dag = new Date(`${DATUM}T00:00:00.000Z`)
    const rad = await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        externalId: `psd2-${randomUUID()}`,
        bankAccountId,
        date: dag,
        description: TEXT,
        amount: new Decimal(BELOPP),
        rawOcr: ocr,
        dedupKey: computeBankDedupKey(dag, new Decimal(BELOPP), ocr),
        status: 'IGNORED',
      },
      select: { id: true },
    })
    return rad.id
  }

  /** Allokeringar, verifikat och avistatus — inte bara räknare. */
  async function bokföringsläge(noticeId: string) {
    const [allokeringar, verifikat, avin] = await Promise.all([
      prisma.rentNoticePayment.count({ where: { rentNoticeId: noticeId } }),
      prisma.journalEntry.count({ where: { organizationId: orgId } }),
      prisma.rentNotice.findUniqueOrThrow({
        where: { id: noticeId },
        select: { status: true, paidAt: true },
      }),
    ])
    return { allokeringar, verifikat, status: avin.status, paidAt: avin.paidAt }
  }

  // ══ PUNKT 3: SPÄRREN MOT SENARE AUTOMATIK ═════════════════════════════════

  it('G1: importen stämplar raden, matchar den inte, och lämnar bokföringen orörd', async () => {
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    await historiskRadUtanKonto(ocr)

    const r = await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)

    expect(r.imported).toBe(1)
    expect(r.behoverGranskas).toBe(1)
    expect(r.autoMatched).toBe(0)
    expect(r.duplicates).toBe(0)

    const rad = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, bankAccountId: kontoA },
      select: { status: true, identityReviewAt: true, identityReviewReason: true },
    })
    expect(rad.status).toBe('UNMATCHED')
    expect(rad.identityReviewAt).not.toBeNull()
    expect(rad.identityReviewReason).toBe('HISTORIK_UTAN_KONTO')

    // Fordringsverifikatet från avin finns; INGET betalningsverifikat tillkom.
    const läge = await bokföringsläge(noticeId)
    expect(läge.allokeringar).toBe(0)
    expect(läge.verifikat).toBe(1)
    expect(läge.status).toBe('SENT')
    utfall.G1 = läge
  })

  it('G2: autoMatchAll rör INTE granskningsraden — och matchar samtidigt en ostämplad rad', async () => {
    // Den stämplade raden.
    const ocrStämplad = nyttOcr()
    const stämpladAvi = await avi(ocrStämplad)
    await historiskRadUtanKonto(ocrStämplad)
    await recon.importBankStatement(csv(ocrStämplad), 'utdrag.csv', orgId, kontoA)
    const stämplad = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, bankAccountId: kontoA },
      select: { id: true },
    })

    // ── NEGATIVKONTROLLEN, I SAMMA KÖRNING ────────────────────────────────
    // En rad som är identisk i allt UTOM markeringen, mot en egen avi. Matchar
    // den inte heller är det riggen som inte kan matcha, och då säger
    // `UNMATCHED` på den stämplade raden ingenting om spärren.
    const ocrFri = nyttOcr()
    const friAvi = await avi(ocrFri)
    const fri = await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        bankAccountId: kontoA,
        date: new Date(`${DATUM}T00:00:00.000Z`),
        description: TEXT,
        amount: new Decimal(BELOPP),
        reference: ocrFri,
        rawOcr: ocrFri,
        status: 'UNMATCHED',
      },
      select: { id: true },
    })

    const bulk = await recon.autoMatchAll(orgId)

    // Negativkontrollen: körningen KUNDE matcha.
    expect(bulk.matched).toBe(1)
    expect(bulk.failed).toBe(0)
    const friEfter = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: fri.id },
      select: { status: true },
    })
    expect(friEfter.status).toBe('MATCHED')
    expect((await bokföringsläge(friAvi)).allokeringar).toBe(1)

    // Spärren: den stämplade raden är orörd, och ingenting bokfördes för den.
    const stämpladEfter = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: stämplad.id },
      select: { status: true, matchedAt: true, matchedRentNoticeId: true, invoiceId: true },
    })
    expect(stämpladEfter.status).toBe('UNMATCHED')
    expect(stämpladEfter.matchedAt).toBeNull()
    expect(stämpladEfter.matchedRentNoticeId).toBeNull()
    expect(stämpladEfter.invoiceId).toBeNull()

    const läge = await bokföringsläge(stämpladAvi)
    expect(läge.allokeringar).toBe(0)
    expect(läge.status).toBe('SENT')
    expect(läge.paidAt).toBeNull()
    utfall.G2 = { bulk, stämpladEfter, läge }
  })

  it('G2b: granskningsraden är inte ens en KANDIDAT — inget skuggförslag köas för den', async () => {
    const ocr = nyttOcr()
    await avi(ocr)
    await historiskRadUtanKonto(ocr)
    await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)

    const köade: string[] = []
    Object.assign(recon, {
      betalningsSkugga: {
        enqueue: async (j: { bankTransactionId: string }) => {
          köade.push(j.bankTransactionId)
          return 'jobb'
        },
      },
    })
    try {
      const bulk = await recon.autoMatchAll(orgId)
      // Raden fanns, men räknades inte ens som väntande: den lämnade
      // kandidatmängden i `where`, inte i loopen.
      expect(bulk.matched + bulk.unmatched + bulk.failed).toBe(0)
      expect(köade).toEqual([])
      utfall.G2b = { bulk, köade }
    } finally {
      Object.assign(recon, { betalningsSkugga: { enqueue: async () => 'jobb' } })
    }
  })

  it('G3: spärren sitter i matchTransaction, inte bara i bulkfrågans where', async () => {
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    await historiskRadUtanKonto(ocr)
    await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)
    const rad = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, bankAccountId: kontoA },
    })

    // Anropet går FÖRBI kandidatfiltret — det är så en framtida fjärde
    // automatikväg skulle se ut.
    const svar = await recon.matchTransaction(rad, orgId)

    expect(svar).toBe(false)
    const läge = await bokföringsläge(noticeId)
    expect(läge.allokeringar).toBe(0)
    expect(läge.verifikat).toBe(1)
    utfall.G3 = { svar, läge }
  })

  it('G3-NK: samma anrop matchar när markeringen saknas', async () => {
    // Negativkontroll till G3: utan `identityReviewAt` returnerar exakt samma
    // anrop `true`. Annars hade G3:s `false` kunnat bero på att raden inte gick
    // att matcha alls.
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    const rad = await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        bankAccountId: kontoA,
        date: new Date(`${DATUM}T00:00:00.000Z`),
        description: TEXT,
        amount: new Decimal(BELOPP),
        reference: ocr,
        rawOcr: ocr,
        status: 'UNMATCHED',
      },
    })

    expect(await recon.matchTransaction(rad, orgId)).toBe(true)
    const läge = await bokföringsläge(noticeId)
    expect(läge.allokeringar).toBe(1)
    expect(läge.status).toBe('PAID')
    utfall['G3-NK'] = läge
  })

  it('G4: MÄNNISKAN är oberörd — manuell matchning av granskningsraden fungerar', async () => {
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    await historiskRadUtanKonto(ocr)
    await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)
    const rad = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, bankAccountId: kontoA },
      select: { id: true },
    })

    await recon.manualMatch(rad.id, { rentNoticeId: noticeId }, orgId, userId)

    const efter = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: rad.id },
      select: { status: true, matchedRentNoticeId: true, identityReviewAt: true },
    })
    expect(efter.status).toBe('MATCHED')
    expect(efter.matchedRentNoticeId).toBe(noticeId)
    // Markeringen står kvar: den säger vad IMPORTEN visste, och det ändras inte
    // av att någon senare avgjorde frågan. Att sudda den hade tagit bort det
    // enda spåret av varför raden krävde ett beslut.
    expect(efter.identityReviewAt).not.toBeNull()

    const läge = await bokföringsläge(noticeId)
    expect(läge.allokeringar).toBe(1)
    expect(läge.verifikat).toBe(2)
    utfall.G4 = { efter, läge }
  })

  it('G5: den andra mänskliga utgången — raden går att lägga åt sidan', async () => {
    const ocr = nyttOcr()
    await avi(ocr)
    await historiskRadUtanKonto(ocr)
    await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)
    const rad = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, bankAccountId: kontoA },
      select: { id: true },
    })

    await recon.ignoreTransaction(rad.id, orgId)

    const efter = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: rad.id },
      select: { status: true },
    })
    expect(efter.status).toBe('IGNORED')
    utfall.G5 = efter
  })

  it('G6: GRÄNSEN — spärren håller kravtrappan helt oinformerad (känd, oavgjord)', async () => {
    // ── VAD DET HÄR PROVET ÄR, OCH VAD DET INTE ÄR ────────────────────────
    //
    // Det är INTE ett krav på att kravtrappan ska pausas. Det är en MÄTNING av
    // att den inte gör det, så att gränsen är ett faktum och inte en mening i
    // en rapport. Funnet av terminal 1 (fynd G2) ur vår egen underrättelse om
    // spärren, mätt i deras gren: `rent-reminder.service.ts:237` väljer
    // kandidater på `status: 'OVERDUE'`, `collectionStage: 'NONE'`,
    // `isBackfill: false` — och ingenting i hela kedjan läser något
    // identitetsspår. `identityReview` förekommer inte i `src/` utanför
    // avstämningen.
    //
    // VARFÖR DET ÄR NYTT. Före spärren kunde en omatchad rad plockas upp av
    // nästa `autoMatchAll` — fördröjningen var en fördröjning. Nu är
    // granskningsraderna uttryckligen undantagna från varje automatisk väg, så
    // enda utgången är att en människa avgör. Fönstret stänger sig inte längre
    // självt, och kravklockan går hela tiden: påminnelse, påminnelseavgift,
    // ränta och kravsteg fortsätter enligt schema för en betalning systemet
    // självt sagt att det inte kan avgöra.
    //
    // VARFÖR VI INTE RÄTTAR DET HÄR. Att fördröja ett krav mot en hyresgäst är
    // ett ägarbeslut, och kodbasen har redan en granne som visar hur ett sådant
    // beslut ser ut när det tagits: `isBackfill: false` i samma urval, med
    // skälet utskrivet (JB 12 kap 42 §). Men det finns också ett hinder som
    // inget ägarbeslut tar bort: EN GRANSKNINGSRAD HAR INGEN FASTSTÄLLD
    // KOPPLING TILL NÅGON AVI — det är hela skälet att den väntar. Att pausa
    // "den avi raden kan höra till" skulle antingen pausa ingenting, eller
    // pausa på en GISSNING om vilken avi det är — alltså återinföra exakt den
    // gissning granskningsutfallet finns för att vägra.
    //
    // Gränsen är därför redovisad, inte löst, och den står som ett eget stycke
    // i RAPPORT.md och i READY-FOR-REVIEW.json.
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    await historiskRadUtanKonto(ocr)
    await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)

    // Avin försätts i kravtrappans ingångsläge, precis som tiden hade gjort.
    await prisma.rentNotice.update({ where: { id: noticeId }, data: { status: 'OVERDUE' } })
    await recon.autoMatchAll(orgId)

    const avin = await prisma.rentNotice.findUniqueOrThrow({
      where: { id: noticeId },
      select: { status: true, collectionStage: true, isBackfill: true, paidAt: true },
    })

    // MÄTNINGEN: avin uppfyller varje villkor i kravtrappans kandidaturval,
    // trots att den enda betalning som kan gälla den ligger och väntar på ett
    // mänskligt beslut. Faller det här provet har NÅGON ÄNDRAT gränsen — och då
    // ska ändringen vara avsiktlig och motiverad, inte upptäckas i drift.
    expect(avin.status).toBe('OVERDUE')
    expect(avin.collectionStage).toBe('NONE')
    expect(avin.isBackfill).toBe(false)
    expect(avin.paidAt).toBeNull()

    // Och ingenting i vår kod har satt någon pausmarkering — vi har inte smugit
    // in halva regel nr 1.
    const pausade = await prisma.invoice.count({
      where: { organizationId: orgId, remindersPaused: true },
    })
    expect(pausade).toBe(0)
    utfall.G6 = { avin, pausade, gräns: 'KRAVTRAPPAN_KANNER_INTE_GRANSKNINGSKON' }
  })

  // ══ PUNKT 4: CROSS-SOURCE-DEDUPEN RESPEKTERAR KONTOT ══════════════════════

  it('A1: kontolös API-rad ger GRANSKNING, inte en säkerförklarad dubblett', async () => {
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    const api = await apiRad(ocr, null)

    const r = await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)

    // Före rättelsen: `duplicates: 1, imported: 0` — betalningen fanns inte.
    expect(r.duplicates).toBe(0)
    expect(r.imported).toBe(1)
    expect(r.behoverGranskas).toBe(1)
    expect(r.autoMatched).toBe(0)

    const rad = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, bankAccountId: kontoA },
      select: { id: true, status: true, identityReviewReason: true },
    })
    expect(rad.id).not.toBe(api)
    expect(rad.status).toBe('UNMATCHED')
    expect(rad.identityReviewReason).toBe('API_UTAN_KONTO')

    // Skyddet mot DUBBEL BOKFÖRING (#162-klassen) är kvar: raden är lagrad men
    // aldrig allokerad. Det var det grenen fanns för, och det håller utan att
    // betalningen behöver kastas.
    const läge = await bokföringsläge(noticeId)
    expect(läge.allokeringar).toBe(0)
    expect(läge.verifikat).toBe(1)
    utfall.A1 = { r, rad, läge }
  })

  it('A2: API-rad på ANNAT konto är en annan betalning — importeras och matchas normalt', async () => {
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    await apiRad(ocr, kontoA2)

    const r = await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)

    expect(r.duplicates).toBe(0)
    expect(r.imported).toBe(1)
    expect(r.behoverGranskas).toBe(0)
    expect(r.autoMatched).toBe(1)

    const läge = await bokföringsläge(noticeId)
    expect(läge.allokeringar).toBe(1)
    expect(läge.status).toBe('PAID')
    utfall.A2 = { r, läge }
  })

  it('A3: API-rad på SAMMA konto är samma betalning — dubblett, som förr', async () => {
    const ocr = nyttOcr()
    const noticeId = await avi(ocr)
    await apiRad(ocr, kontoA)

    const r = await recon.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoA)

    expect(r.duplicates).toBe(1)
    expect(r.imported).toBe(0)
    expect(r.behoverGranskas).toBe(0)

    // Ingen andra rad, ingen allokering: skyddet mot dubbel-allokering är intakt.
    expect(
      await prisma.bankTransaction.count({ where: { organizationId: orgId, externalId: null } }),
    ).toBe(0)
    expect((await bokföringsläge(noticeId)).allokeringar).toBe(0)
    utfall.A3 = r
  })

  it('A4a: SAMMA fil igen är en UPPSPELNING — filnamnet är inte en del av avtrycket', async () => {
    const ocr = nyttOcr()
    await avi(ocr)
    await apiRad(ocr, null)

    const först = await recon.importBankStatement(csv(ocr), 'ett.csv', orgId, kontoA)
    expect(först.behoverGranskas).toBe(1)
    const efterFörst = await prisma.bankTransaction.count({ where: { organizationId: orgId } })

    // ETT ANNAT FILNAMN GER INTE EN NY KÖRNING. Filnamnet ingår med flit inte i
    // importavtrycket — annars hade ett `mv` kringgått hela skyddet. Svaret är
    // därför förstakörningens, ordagrant, och INGENTING skrevs.
    const igen = await recon.importBankStatement(csv(ocr), 'tva.csv', orgId, kontoA)
    expect(igen.forsok?.replayed).toBe(true)
    expect(igen.behoverGranskas).toBe(1)
    expect(await prisma.bankTransaction.count({ where: { organizationId: orgId } })).toBe(
      efterFörst,
    )
    utfall.A4a = { först, igen }
  })

  it('A4b: en ÖVERLAPPANDE annan fil ger DUBBLETT på den delade raden — inte en andra granskningsrad', async () => {
    const ocr = nyttOcr()
    await avi(ocr)
    await apiRad(ocr, null)

    const först = await recon.importBankStatement(csv(ocr), 'ett.csv', orgId, kontoA)
    expect(först.behoverGranskas).toBe(1)

    // Annat INNEHÅLL → annat avtryck → en verklig ny körning. Nu är det
    // radnivåns kontoscopade dedup som måste svara, inte arrendet: den delade
    // raden finns redan LAGRAD (som granskningsrad) på samma konto, och en
    // granskningsrad är fortfarande en rad.
    const extra = nyttOcr()
    await avi(extra)
    const igen = await recon.importBankStatement(csv(ocr, extra), 'tva.csv', orgId, kontoA)
    expect(igen.forsok?.replayed).toBe(false)
    expect(igen.duplicates).toBe(1)
    expect(igen.imported).toBe(1)
    expect(igen.behoverGranskas).toBe(0)

    // EN granskningsrad, inte två. Hade den delade raden skapats om hade
    // operatören fått samma oavgjorda fråga en gång till för samma betalning.
    expect(
      await prisma.bankTransaction.count({
        where: { organizationId: orgId, identityReviewAt: { not: null } },
      }),
    ).toBe(1)
    utfall.A4b = { först, igen }
  })
})
