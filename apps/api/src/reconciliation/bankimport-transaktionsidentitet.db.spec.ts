/**
 * F034 — BANKIMPORTENS TRANSAKTIONSIDENTITET, MÄTT GENOM DEN RIKTIGA VÄGEN IN.
 *
 * ── VAD FILEN ÄGER ──────────────────────────────────────────────────────────
 *
 * Frågan är EN: när säger importen "dubblett", och är det sant? Kedjan mäts hel
 * — filrad → tolkning → fält-dedup → lagrad `BankTransaction` → matchning →
 * `paymentDataThrough` — för alla tre filvägar som finns:
 *
 *   CSV/XLSX  `ReconciliationService.importBankStatement`
 *   BgMax     `ReconciliationService.importBgMaxFile`
 *   PDF       `BankStatementImportService.confirmImport`
 *
 * Filen prövar INTE matchningsreglerna (`waterfall-allocation.db.spec.ts`,
 * `auto-match-all.db.spec.ts` äger dem) och INTE `ingestFromFile` som funktion
 * (`reconciliation-ingest-core.spec.ts` äger den, med attrapper, och har rätt i
 * det den påstår: fält-dedupen är källans, inte kärnans). Det som saknades var
 * den omvända riktningen — att fält-dedupen kan svara `duplicate` om två rader
 * som INTE är samma betalning. Provet läggs till; ingen befintlig fixtur ändras.
 *
 * ── VARFÖR RIKTIG POSTGRES ──────────────────────────────────────────────────
 *
 * Dedupen ÄR en databasfråga över NULLBARA kolumner. Skillnaden mellan
 * `reference: null` (→ `IS NULL`) och ett utelämnat fält (→ inget villkor alls,
 * dvs. en JOKER som matchar vilken rad som helst) syns inte i en attrapp som
 * bara sparar undan argumentet. Den syns i vad Postgres returnerar. Därför
 * `.db.spec.ts`, och därför en kanariefågel som FÄLLER filen utan `DATABASE_URL`
 * i stället för att låta den skippas tyst (CLAUDE.md, "En sond som ger NOLL").
 *
 * ── FALLEN ──────────────────────────────────────────────────────────────────
 *
 *   A  Två hyresgäster, samma dag, samma belopp, samma banktext, OLIKA
 *      referens → TVÅ bankrader, var sin avi betald.        (F034, röd före)
 *   B  Verklig dubblett: samma fil igen → INGA nya rader, inga nya
 *      allokeringar, inga nya verifikat.                    (idempotens)
 *   C  BgMax utan OCR får inte ätas upp av en OCR-bärande rad samma dag och
 *      belopp.                                              (F034, röd före)
 *   D  PDF-vägen: två poster, samma dag/text/belopp, olika OCR → två rader.
 *                                                           (F034, röd före)
 *   E  Blandade giltiga/felaktiga rader: den giltiga raden importeras, felet
 *      redovisas, och färskhetsdatumet flyttas INTE fram.    (bevarad spärr)
 *   F  Gammal historik: en rad lagrad av en ÄLDRE kodversion, vars härledda
 *      `rawOcr` dagens tolkning inte längre producerar, känns fortfarande igen
 *      som dubblett vid återimport.                          (bakåtkompatibel)
 *
 * FALL F är också negativkontrollen mot den NÄRLIGGANDE FELRÄTTNINGEN. Att
 * lägga `rawOcr` i nyckeln (fyndets ordagranna förslag) gör A, C och D gröna —
 * och FALL F röd, tyst, mot kunddata: `rawOcr` är HÄRLEDD, och härledningen
 * ändrades i #556 (prosa kräver numera Luhn). En rad som lagrades med
 * `rawOcr="20260601"` ur bankens text får ingen `rawOcr` alls av dagens
 * tolkning, och en nyckel som innehåller fältet skulle därför skapa en ANDRA
 * bankrad vid återimport av gammal historik → dubbel allokering. `reference` är
 * kolumnen rå, lagrad ordagrant sedan importvägen fanns och aldrig omräknad.
 *
 * ── VAD FILEN INTE KAN SE ───────────────────────────────────────────────────
 *
 *  • Samtidighet. Fält-dedupen är läs-sedan-skriv utan unikt index (A044 fynd 1,
 *    egen rättning, kräver migration). Två PARALLELLA importer av samma fil kan
 *    fortfarande skapa två rader — före och efter den här ändringen lika.
 *  • Den yttersta identitetsgränsen: två VERKLIGT skilda betalningar som är
 *    lika i varje fält filen bär (samma dag, belopp, text OCH referens) är
 *    oskiljbara för varje nyckel som bara läser filen. Se PR-texten.
 *  • HTTP-lagret. Controllern anropar exakt de metoder som anropas här
 *    (`reconciliation.controller.ts:69`, `:104`, `:190`), men DTO/pipe-kedjan
 *    prövas inte (A045 §1).
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient, RentNoticeType } from '@prisma/client'
import { generateOcrNumber, isValidOcrNumber } from '@eken/shared'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { BankStatementImportService } from './bank-statement-import.service'
import { ReconciliationService } from './reconciliation.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const HYRA = 8500
const BETALDAG = '2026-05-01'
const SENARE_DAG = '2026-06-10'

// Bankens prosa är generisk med flit: det är HELA poängen med F034. Två olika
// hyresgästers inbetalningar får samma text av banken.
const BANKTEXT = 'Insättning'

function klient(): PrismaClient {
  const u = new URL(process.env.DATABASE_URL as string)
  u.searchParams.set('connection_limit', '5')
  return new PrismaClient({ datasources: { db: { url: u.toString() } } })
}

function csv(rader: Array<[string, string, string, string]>): Buffer {
  return Buffer.from(
    ['Datum;Text;Belopp;Referens', ...rader.map((r) => r.join(';'))].join('\n'),
    'utf8',
  )
}

// BgMax: 80 teckens fastformat. TC 05 bär sektionsdatum (pos 22-29), TC 20 bär
// OCR (pos 12-36) och belopp i öre (pos 37-54) — samma offsets som parsern.
function bgmax(datum: string, poster: Array<{ ocr: string; belopp: number }>): Buffer {
  const tc05 = ('05' + '0'.repeat(20) + datum.replace(/-/g, '')).padEnd(80, ' ')
  const rader = poster.map(
    ({ ocr, belopp }) =>
      ('20' +
        '0'.repeat(10) +
        ocr.padEnd(25, ' ') +
        String(Math.round(belopp * 100)).padStart(18, '0')) as string,
  )
  return Buffer.from([tc05, ...rader].join('\n'), 'utf8')
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('bankimportens transaktionsidentitet (F034)', () => {
  let prisma: PrismaClient
  let service: ReconciliationService
  let pdfImport: BankStatementImportService
  let orgId: string
  let unitA: string
  let unitB: string
  let leaseA: string
  let leaseB: string
  let tenantA: string
  let tenantB: string
  let ocrA: string
  let ocrB: string
  let ocrC: string

  beforeAll(async () => {
    prisma = klient()
    const sfx = randomUUID().slice(0, 8)

    const org = await prisma.organization.create({
      data: {
        name: `f034-${sfx}`,
        email: `f034-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5561${sfx.slice(0, 6)}`,
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
        propertyDesignation: `F034 ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })

    const enhet = async (nr: number): Promise<string> => {
      const u = await prisma.unit.create({
        data: {
          propertyId: prop.id,
          name: `Lgh ${nr}-${sfx}`,
          unitNumber: `${nr}-${sfx}`,
          type: 'APARTMENT',
          rooms: 2,
          area: 55,
          monthlyRent: HYRA,
          status: 'OCCUPIED',
        },
        select: { id: true },
      })
      return u.id
    }
    unitA = await enhet(1)
    unitB = await enhet(2)

    const hyresgäst = async (namn: string): Promise<string> => {
      const t = await prisma.tenant.create({
        data: {
          organizationId: orgId,
          type: 'INDIVIDUAL',
          firstName: namn,
          lastName: 'Hyresgäst',
          email: `${namn.toLowerCase()}-${sfx}@example.se`,
        },
        select: { id: true },
      })
      return t.id
    }
    tenantA = await hyresgäst('Anna')
    tenantB = await hyresgäst('Bertil')

    const avtal = async (unitId: string, tenantId: string, nr: number): Promise<string> => {
      const l = await prisma.lease.create({
        data: {
          organizationId: orgId,
          unitId,
          tenantId,
          contractNumber: `HK-${nr}-${sfx}`,
          monthlyRent: HYRA,
          depositAmount: 0,
          startDate: new Date('2026-01-01'),
          tenancyStartDate: new Date('2026-01-01'),
          status: 'ACTIVE',
        },
        select: { id: true },
      })
      return l.id
    }
    leaseA = await avtal(unitA, tenantA, 1)
    leaseB = await avtal(unitB, tenantB, 2)

    // Systemtilldelade OCR ur produktionsgeneratorn — inte hittepå-siffror.
    ocrA = generateOcrNumber(340001)
    ocrB = generateOcrNumber(340002)
    ocrC = generateOcrNumber(340003)

    const mail = { send: async () => undefined, sendToOrgRoles: async () => undefined }
    const freshness = new PaymentFreshnessService(prisma as never, mail as never)
    const accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    const kastare = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('orört beroende anropat')
        },
      },
    )

    service = new ReconciliationService(
      prisma as never,
      kastare as never, // invoices — hyresavivägen rör den inte
      kastare as never, // invoice events — d:o
      accounting as never,
      freshness as never,
      new RentNoticeEventsService(prisma as never) as never,
      { enqueue: async () => 'jobb' } as never,
      {
        skrivFacitMatchad: async () => undefined,
        skrivFacitIngen: async () => undefined,
        nollstallFacit: async () => undefined,
      } as never,
    )
    Object.assign(service, {
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })

    pdfImport = new BankStatementImportService(
      prisma as never,
      kastare as never, // PDF-parsern — confirmImport läser draften, tolkar inte om
      service,
      freshness as never,
    )
    Object.assign(pdfImport, {
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
    await prisma.bankStatementImport.deleteMany({ where: { organizationId: orgId } })
    // BARA `paymentDataThrough` nollställs. `paymentImportStartedAt` är
    // OFÖRÄNDERLIG i databasen — en trigger fäller varje ändring av ett satt
    // värde (`20260913090000_payment_import_start`, `PAYMENT_IMPORT_START_IMMUTABLE`).
    // Riggen får inte gå runt en produktionsinvariant för att städa efter sig.
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: null },
    })
  })

  afterAll(async () => {
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  async function avi(opts: {
    tenantId: string
    leaseId: string
    unitId: string
    ocr: string
    månad: number
    belopp?: number
  }): Promise<string> {
    const belopp = opts.belopp ?? HYRA
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId: opts.tenantId,
        leaseId: opts.leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: opts.ocr,
        month: opts.månad,
        year: 2026,
        amount: belopp,
        totalAmount: belopp,
        dueDate: new Date(Date.UTC(2026, opts.månad - 1, 27)),
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
        month: opts.månad,
        unitId: opts.unitId,
      } as never,
      orgId,
      null,
    )
    return n.id
  }

  async function bankrader() {
    return prisma.bankTransaction.findMany({
      where: { organizationId: orgId },
      orderBy: [{ amount: 'asc' }, { reference: 'asc' }],
      select: {
        id: true,
        date: true,
        description: true,
        amount: true,
        reference: true,
        rawOcr: true,
        status: true,
        matchedRentNoticeId: true,
      },
    })
  }

  async function färskhet(): Promise<Date | null> {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { paymentDataThrough: true },
    })
    return org.paymentDataThrough
  }

  // ── FALL A ────────────────────────────────────────────────────────────────
  it('FALL A — två hyresgäster, samma dag och belopp, olika referens: BÅDA betalningarna lagras och betalar var sin avi', async () => {
    const aviA = await avi({
      tenantId: tenantA,
      leaseId: leaseA,
      unitId: unitA,
      ocr: ocrA,
      månad: 5,
    })
    const aviB = await avi({
      tenantId: tenantB,
      leaseId: leaseB,
      unitId: unitB,
      ocr: ocrB,
      månad: 5,
    })

    const resultat = await service.importBankStatement(
      csv([
        [BETALDAG, BANKTEXT, '8500,00', ocrA],
        [BETALDAG, BANKTEXT, '8500,00', ocrB],
      ]),
      'kontoutdrag.csv',
      orgId,
    )

    expect(resultat.errors).toEqual([])
    expect(resultat.imported).toBe(2)
    expect(resultat.duplicates).toBe(0)
    expect(resultat.autoMatched).toBe(2)

    const rader = await bankrader()
    expect(rader).toHaveLength(2)
    expect(rader.map((r) => r.reference).sort()).toEqual([ocrA, ocrB].sort())

    // Pengarna ska ha landat på RÄTT avi — inte bara ha blivit två rader.
    const avier = await prisma.rentNotice.findMany({
      where: { organizationId: orgId },
      select: { id: true, ocrNumber: true, status: true },
    })
    expect(avier.every((a) => a.status === 'PAID')).toBe(true)

    const allokeringar = await prisma.rentNoticePayment.findMany({
      where: { rentNotice: { organizationId: orgId } },
      select: { rentNoticeId: true, amount: true },
    })
    expect(allokeringar).toHaveLength(2)
    expect(allokeringar.map((a) => a.rentNoticeId).sort()).toEqual([aviA, aviB].sort())
  })

  // ── FALL B ────────────────────────────────────────────────────────────────
  it('FALL B — oförändrad återimport av samma fil: inga nya bankrader, inga nya allokeringar, inga nya verifikat', async () => {
    await avi({ tenantId: tenantA, leaseId: leaseA, unitId: unitA, ocr: ocrA, månad: 5 })
    await avi({ tenantId: tenantB, leaseId: leaseB, unitId: unitB, ocr: ocrB, månad: 5 })

    const fil = csv([
      [BETALDAG, BANKTEXT, '8500,00', ocrA],
      [BETALDAG, BANKTEXT, '8500,00', ocrB],
    ])

    await service.importBankStatement(fil, 'kontoutdrag.csv', orgId)
    const efterFörsta = {
      rader: (await bankrader()).map((r) => r.id).sort(),
      allokeringar: await prisma.rentNoticePayment.count({
        where: { rentNotice: { organizationId: orgId } },
      }),
      verifikat: await prisma.journalEntry.count({ where: { organizationId: orgId } }),
    }

    const andra = await service.importBankStatement(fil, 'kontoutdrag.csv', orgId)

    expect(andra.imported).toBe(0)
    expect(andra.duplicates).toBe(2)
    expect((await bankrader()).map((r) => r.id).sort()).toEqual(efterFörsta.rader)
    expect(
      await prisma.rentNoticePayment.count({ where: { rentNotice: { organizationId: orgId } } }),
    ).toBe(efterFörsta.allokeringar)
    expect(await prisma.journalEntry.count({ where: { organizationId: orgId } })).toBe(
      efterFörsta.verifikat,
    )
  })

  // ── FALL B2 ───────────────────────────────────────────────────────────────
  it('FALL B2 — verklig dubblettrad INNE i filen (identisk i varje fält) räknas som dubblett, inte som betalning', async () => {
    await avi({ tenantId: tenantA, leaseId: leaseA, unitId: unitA, ocr: ocrA, månad: 5 })

    const resultat = await service.importBankStatement(
      csv([
        [BETALDAG, BANKTEXT, '8500,00', ocrA],
        [BETALDAG, BANKTEXT, '8500,00', ocrA],
      ]),
      'kontoutdrag.csv',
      orgId,
    )

    expect(resultat.imported).toBe(1)
    expect(resultat.duplicates).toBe(1)
    expect(await bankrader()).toHaveLength(1)
  })

  // ── FALL C ────────────────────────────────────────────────────────────────
  it('FALL C — BgMax: en post UTAN OCR äts inte upp av en OCR-bärande rad samma dag och belopp', async () => {
    await avi({ tenantId: tenantA, leaseId: leaseA, unitId: unitA, ocr: ocrA, månad: 5 })

    const första = await service.importBgMaxFile(
      bgmax(BETALDAG, [{ ocr: ocrA, belopp: HYRA }]),
      'bgmax.txt',
      orgId,
    )
    expect(första.imported).toBe(1)

    // Samma dag, samma belopp, ingen referens: en ANNAN betalning, som filen
    // inte kan knyta till en avi. Den ska ändå lagras — annars försvinner den.
    const andra = await service.importBgMaxFile(
      bgmax(BETALDAG, [{ ocr: '', belopp: HYRA }]),
      'bgmax-2.txt',
      orgId,
    )

    expect(andra.imported).toBe(1)
    expect(andra.duplicates).toBe(0)

    const rader = await bankrader()
    expect(rader).toHaveLength(2)
    expect(rader.filter((r) => r.rawOcr === null)).toHaveLength(1)

    // …och en tredje körning av den OCR-lösa filen får inte skapa en tredje rad.
    const tredje = await service.importBgMaxFile(
      bgmax(BETALDAG, [{ ocr: '', belopp: HYRA }]),
      'bgmax-2.txt',
      orgId,
    )
    expect(tredje.imported).toBe(0)
    expect(tredje.duplicates).toBe(1)
    expect(await bankrader()).toHaveLength(2)
  })

  // ── FALL D ────────────────────────────────────────────────────────────────
  it('FALL D — PDF-vägen: två poster med samma dag, text och belopp men olika OCR ger två bankrader', async () => {
    await avi({ tenantId: tenantA, leaseId: leaseA, unitId: unitA, ocr: ocrA, månad: 5 })
    await avi({ tenantId: tenantB, leaseId: leaseB, unitId: unitB, ocr: ocrB, månad: 5 })

    const draft = await prisma.bankStatementImport.create({
      data: {
        organizationId: orgId,
        fileName: 'utdrag.pdf',
        fileType: 'pdf',
        fileSize: 1234,
        status: 'PARSED',
        parsedData: {
          transactions: [
            { date: BETALDAG, description: BANKTEXT, ocr: ocrA, amount: HYRA, isIncoming: true },
            { date: BETALDAG, description: BANKTEXT, ocr: ocrB, amount: HYRA, isIncoming: true },
          ],
        },
      },
      select: { id: true },
    })

    const resultat = await pdfImport.confirmImport(draft.id, orgId, null)

    expect(resultat.created).toBe(2)
    expect(resultat.duplicates).toBe(0)
    expect(resultat.autoMatched).toBe(2)
    expect(await bankrader()).toHaveLength(2)
  })

  // ── FALL E ────────────────────────────────────────────────────────────────
  it('FALL E — blandade giltiga och felaktiga rader: den giltiga lagras, felet redovisas, färskhetsdatumet flyttas INTE fram', async () => {
    await avi({ tenantId: tenantA, leaseId: leaseA, unitId: unitA, ocr: ocrA, månad: 5 })

    // Först en ren fil, så att det finns ett färskhetsdatum att stå kvar på.
    await service.importBankStatement(
      csv([[BETALDAG, BANKTEXT, '8500,00', ocrA]]),
      'ren.csv',
      orgId,
    )
    const före = await färskhet()
    expect(före).not.toBeNull()

    // Därefter en fil med ett senare datum OCH en trasig rad. Hade spärren
    // inte hållit hade färskheten flyttats fram till SENARE_DAG.
    const trasig = await service.importBankStatement(
      csv([
        [SENARE_DAG, BANKTEXT, '4200,00', ocrC],
        ['inte-ett-datum', BANKTEXT, '999,00', ocrB],
      ]),
      'trasig.csv',
      orgId,
    )

    expect(trasig.imported).toBe(1)
    expect(trasig.errors).toHaveLength(1)
    expect(trasig.errors[0]).toContain('Ogiltigt datum')
    expect(trasig.errors[0]).toContain('Betalningsunderlagets datum uppdaterades inte')

    const efter = await färskhet()
    expect(efter?.toISOString()).toBe(före?.toISOString())
    expect(await bankrader()).toHaveLength(2)
  })

  // ── FALL F ────────────────────────────────────────────────────────────────
  it('FALL F — gammal historik: en rad vars lagrade rawOcr dagens tolkning inte längre producerar känns ändå igen som dubblett', async () => {
    // Prosasiffran som #556 (f3f47dc0) slutade räkna som OCR. Kanariefågel: om
    // den någon gång blir Luhn-giltig mäter fallet inte längre det det påstår.
    const PROSASIFFRA = '20260601'
    expect(isValidOcrNumber(PROSASIFFRA)).toBe(false)

    const text = `Inbetalning ${PROSASIFFRA}`

    // Raden som den ÄLDRE kodversionen lagrade den: rawOcr skrapad ur prosan,
    // ingen referenskolumn i filen.
    await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        date: new Date(BETALDAG),
        description: text,
        amount: 4200,
        rawOcr: PROSASIFFRA,
        status: 'UNMATCHED',
      },
    })

    // Samma fil importeras om i dag. Dagens tolkning ger INGEN rawOcr.
    const resultat = await service.importBankStatement(
      csv([[BETALDAG, text, '4200,00', '']]),
      'gammal-historik.csv',
      orgId,
    )

    expect(resultat.duplicates).toBe(1)
    expect(resultat.imported).toBe(0)
    expect(await bankrader()).toHaveLength(1)
  })
})
