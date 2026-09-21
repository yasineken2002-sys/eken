/**
 * FILNIVÅNS IDEMPOTENS OCH SAMTIDIGHET I BANKIMPORTEN (#F034b) — mätt.
 *
 * ── VAD BASEN SJÄLV SA, OCH VAD MÄTNINGEN GAV ───────────────────────────────
 *
 * `reconciliation.service.ts` skrev ut luckan vid sin egen fält-dedup:
 *
 *     "Läs-sedan-skriv utan unikt index: två PARALLELLA importer av samma fil
 *      kan fortfarande passera båda. Det är en egen, känd brist
 *      (filnivå-idempotens, kräver migration) och den är varken införd eller
 *      lagad här."
 *
 * Kört mot bas `661e79e62007812d74746fc360177cffba0ac771`, med överlappet
 * tvingat av barriären nedan: en CSV med EN inbetalningsrad, importerad två
 * gånger samtidigt, gav **2 BankTransaction-rader**, och båda anropen svarade
 * `imported: 1, duplicates: 0`. Råutfallet ligger i
 * `arbete/byggledning-besiktning-bank-20260921/T2/bevis/01-REPRODUKTION-pa-basen.log`.
 *
 * F034/#902 rättade identiteten PER RAD. Den rörde inte filnivån. Det är den
 * här filen som mäter filnivån.
 *
 * ── VARFÖR EN BARRIÄR OCH INTE `Promise.all` ────────────────────────────────
 *
 * `Promise.all` startar två löften. Det bevisar INTE att den ena hann läsa
 * innan den andra skrev — och just den ordningen ÄR felet. En rigg som bara
 * startar två anrop och råkar få ett dubblettfel mäter schemaläggaren, inte
 * koden.
 *
 * Riggen tvingar därför överlappet: en Prisma-extension släpper inte igenom den
 * FÖRSTA anroparen vid en namngiven punkt förrän den ANDRA har nått samma
 * punkt. Barriären har en egen tidsgräns och KASTAR om överlappet uteblev — ett
 * uteblivet överlapp får aldrig se ut som ett grönt prov.
 *
 * ── TVÅ KLIENTER = TVÅ APPINSTANSER ─────────────────────────────────────────
 *
 * Varje sida har sin EGEN `PrismaClient` mot samma databas. Ett processlokalt
 * lås syns inte över den gränsen, och kravet är att skyddet ska hålla där.
 *
 * ── VAD FILEN INTE MÄTER ────────────────────────────────────────────────────
 *
 *  • Skalan. Två samtidiga importer, inte hundra.
 *  • Två verkliga appprocesser. Två Prisma-klienter i EN nodprocess delar
 *    fortfarande event loop. Skyddet ligger i databasen och är oberoende av
 *    det — men riggen kan inte bevisa den oberoendet.
 *  • Arrendets TTL i verklig tid. `IMPORT_LEASE_TTL_MS` är 15 minuter; provet
 *    åldrar `heartbeatAt` genom att skriva ett gammalt värde i stället för att
 *    vänta. Det mäter övertagandets MEKANIK, inte klockan.
 *  • Historiska rader med `identityKey = ''`. De skyddas av läsningen, inte av
 *    indexet — se det egna provet, som mäter just den skillnaden.
 */

// StorageService och PdfService drar in @aws-sdk/client-s3 respektive Puppeteer
// via importkedjan; @nodable/entities är ESM och jest kan inte parsa den. Samma
// två mockar som kodbasens övriga reconciliation-specar använder.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { BankImportAttemptService } from './bank-import-attempt.service'
import { BankStatementImportService } from './bank-statement-import.service'
import { IMPORT_LEASE_TTL_MS, hashaBytes } from './bank-import-identity'
import { ReconciliationService } from './reconciliation.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Poolen måste rymma båda sidorna plus riggens egen klient. */
const POOL = 12

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

function klient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, POOL) } },
  })
}

/**
 * Tvåpartsbarriär med tidsgräns. `passera()` returnerar först när BÅDA sidorna
 * har anropat den. Uteblir den andra sidan KASTAR barriären.
 */
class Barriär {
  private väntande: Array<() => void> = []
  private klockor: NodeJS.Timeout[] = []
  private släppt = false
  constructor(
    private readonly antal: number,
    private readonly timeoutMs = 8000,
  ) {}

  private släpp(): void {
    this.släppt = true
    for (const t of this.klockor) clearTimeout(t)
    this.klockor = []
    for (const r of this.väntande) r()
    this.väntande = []
  }

  async passera(): Promise<void> {
    if (this.släppt) return
    return new Promise<void>((resolve, reject) => {
      this.väntande.push(resolve)
      if (this.väntande.length >= this.antal) {
        this.släpp()
        return
      }
      // Klockan RENSAS när barriären löser ut. En kvarlämnad timer håller
      // jests event loop vid liv och ger "Jest did not exit" — ett brus som med
      // tiden lär en att ignorera exakt den varning som en dag betyder något.
      const t = setTimeout(() => {
        if (!this.släppt) {
          reject(
            new Error(
              `BARRIÄREN LÖSTES ALDRIG: bara ${this.väntande.length} av ${this.antal} sidor ` +
                'nådde punkten inom tidsgränsen. Överlappet uppstod alltså ALDRIG, och ' +
                'provet mäter då ingenting — behandla det som ett riggfel, inte ett utfall.',
            ),
          )
        }
      }, this.timeoutMs)
      t.unref?.()
      this.klockor.push(t)
    })
  }
}

type Punkt = 'dedupläsning' | 'anspråk'

/**
 * Klient som passerar barriären vid en NAMNGIVEN punkt.
 *
 *   'dedupläsning'  efter `bankTransaction.count` — mäter radnivåns kapplöpning
 *   'anspråk'       före `bankImportAttempt.create` — mäter filnivåns
 */
function klientMedBarriär(barriär: Barriär, punkt: Punkt): PrismaClient {
  const bas = klient()
  if (punkt === 'dedupläsning') {
    return bas.$extends({
      query: {
        bankTransaction: {
          async count({ args, query }) {
            const r = await query(args)
            await barriär.passera()
            return r
          },
        },
      },
    }) as unknown as PrismaClient
  }
  return bas.$extends({
    query: {
      bankImportAttempt: {
        async create({ args, query }) {
          await barriär.passera()
          return query(args)
        },
      },
    },
  }) as unknown as PrismaClient
}

function orört(namn: string) {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`${namn} orört`)
      },
    },
  )
}

interface Riggtjänster {
  recon: ReconciliationService
  pdf: BankStatementImportService
  /** Vad färskhetstjänsten FAKTISKT anropades med. Används av A11. */
  täckning: Date[]
}

function nyaTjänster(p: PrismaClient): Riggtjänster {
  const accounting = new AccountingService(p as never, new VerifikationsnummerService(p as never))
  const täckning: Date[] = []
  // Färskheten är en RIKTIG del av importvägen. Attrappen registrerar vad den
  // anropades med i stället för att svälja det — A11 mäter att en låskonflikt
  // ALDRIG når hit.
  const freshness = {
    recordImportStarted: async () => undefined,
    recordPaymentDataThrough: async (_org: string, through: Date) => {
      täckning.push(through)
    },
  }
  const attempts = new BankImportAttemptService(p as never)

  const recon = Object.create(ReconciliationService.prototype) as ReconciliationService
  Object.assign(recon, {
    prisma: p,
    accounting,
    rentNoticeEvents: new RentNoticeEventsService(p as never),
    invoices: orört('invoices'),
    events: orört('events'),
    freshness,
    betalningsSkugga: { enqueue: async () => undefined },
    betalningsFacit: { registrera: async () => undefined },
    attempts,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  })

  const pdf = Object.create(BankStatementImportService.prototype) as BankStatementImportService
  Object.assign(pdf, {
    prisma: p,
    parser: orört('parser'),
    reconciliation: recon,
    freshness,
    attempts,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  })

  return { recon, pdf, täckning }
}

// ── Filer ────────────────────────────────────────────────────────────────────

const HUVUD = 'Datum,Text,Belopp,Referens'
function csv(...rader: string[]): Buffer {
  return Buffer.from([HUVUD, ...rader].join('\n'), 'utf8')
}
const RAD_A = '2026-03-02,Insattning,9000.00,1234567897'
const RAD_B = '2026-03-03,Insattning,7500.00,9876543210'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('bankimportens filnivå-idempotens (#F034b)', () => {
  let prisma: PrismaClient
  let orgId: string
  let orgB: string

  async function nyOrg(): Promise<string> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `fil-${sfx}`,
        email: `fil-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5561${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    return org.id
  }

  const räknaRader = (org = orgId) =>
    prisma.bankTransaction.count({ where: { organizationId: org } })

  /**
   * FAIL-CLOSED PÅ RIGGENS EGNA MUTATIONER.
   *
   * Negativkontrollerna nedan DROPPAR ett index och återställer det i `finally`.
   * Avbryts körningen mitt i (tidsgräns, SIGINT) kan återställningen utebli —
   * och då hade NÄSTA körning mätt en databas utan skydd och ändå kunnat bli
   * grön på fel grund. Det är precis den sortens tyst försvagad kontroll som
   * kostar mest, eftersom ingenting ser annorlunda ut.
   *
   * Kontrollen körs FÖRE allt annat och säger vad som ska göras, inte bara att
   * något är fel.
   */
  async function kräv(index: string, tabell: string): Promise<void> {
    const rader = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
      tabell,
      index,
    )
    if (rader.length !== 1) {
      throw new Error(
        `RIGGEN STÅR I ETT MUTERAT LÄGE: indexet "${index}" på ${tabell} saknas i databasen. ` +
          'Det droppas bara av negativkontrollerna i den här filen, som återställer det i sitt ' +
          '`finally` — saknas det nu avbröts en tidigare körning innan återställningen. ' +
          'Kör `prisma migrate deploy` mot provdatabasen igen innan du tolkar något utfall här. ' +
          'Provet KASTAR i stället för att hoppa: en hoppad kontroll är grön.',
      )
    }
  }

  beforeAll(async () => {
    prisma = klient()
    await kräv('bank_transaction_identity_unique', 'BankTransaction')
    await kräv('BankImportAttempt_organizationId_fingerprint_key', 'BankImportAttempt')
    orgId = await nyOrg()
    orgB = await nyOrg()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    for (const o of [orgId, orgB]) {
      await prisma.bankTransaction.deleteMany({ where: { organizationId: o } })
      await prisma.bankImportAttempt.deleteMany({ where: { organizationId: o } })
      await prisma.bankStatementImport.deleteMany({ where: { organizationId: o } })
      await prisma.organization.update({
        where: { id: o },
        data: { paymentDataThrough: null, paymentImportStartedAt: null },
      })
    }
  })

  // ── A1 ─────────────────────────────────────────────────────────────────────

  it('A1: två SAMTIDIGA importer av samma fil — en kör, en får 409, EN rad', async () => {
    const barriär = new Barriär(2)
    const a = klientMedBarriär(barriär, 'anspråk')
    const b = klientMedBarriär(barriär, 'anspråk')
    const fil = csv(RAD_A)

    const utfall = await Promise.allSettled([
      nyaTjänster(a).recon.importBankStatement(fil, 'utdrag.csv', orgId),
      nyaTjänster(b).recon.importBankStatement(fil, 'utdrag.csv', orgId),
    ])
    await a.$disconnect()
    await b.$disconnect()

    const lyckade = utfall.filter((u) => u.status === 'fulfilled')
    const nekade = utfall.filter(
      (u) => u.status === 'rejected' && (u.reason as { status?: number })?.status === 409,
    )

    expect(lyckade).toHaveLength(1)
    expect(nekade).toHaveLength(1)
    expect(await räknaRader()).toBe(1)

    // Basen gav 2 rader här. Talet står i filhuvudet och i bevisloggen.
    const attempts = await prisma.bankImportAttempt.findMany({
      where: { organizationId: orgId },
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('SUCCEEDED')
  }, 30_000)

  // ── A2 ─────────────────────────────────────────────────────────────────────

  it('A2: upprepning efter SUCCEEDED spelas upp — noll nya rader', async () => {
    const { recon } = nyaTjänster(prisma)
    const fil = csv(RAD_A, RAD_B)

    const först = await recon.importBankStatement(fil, 'utdrag.csv', orgId)
    expect(först.imported).toBe(2)
    expect(först.forsok?.replayed).toBe(false)
    expect(först.forsok?.status).toBe('KLAR')
    const efterFörst = await räknaRader()

    const igen = await recon.importBankStatement(fil, 'utdrag.csv', orgId)

    expect(igen.forsok?.replayed).toBe(true)
    expect(igen.imported).toBe(först.imported)
    expect(igen.duplicates).toBe(först.duplicates)
    expect(await räknaRader()).toBe(efterFörst)
    // EN försöksrad, inte två: upprepningen skapade inget nytt försök.
    expect(await prisma.bankImportAttempt.count({ where: { organizationId: orgId } })).toBe(1)
  })

  // ── A3 ─────────────────────────────────────────────────────────────────────

  it('A3: avbrott (RUNNING med fallet arrende) övertas — redan lagrade rader bevaras', async () => {
    const { recon } = nyaTjänster(prisma)
    const fil = csv(RAD_A, RAD_B)

    // Efterlikna ett avbrott: raden ligger kvar RUNNING, och en av filens två
    // betalningar hann lagras innan processen dog.
    await recon.importBankStatement(fil, 'utdrag.csv', orgId)
    await prisma.bankTransaction.deleteMany({
      where: { organizationId: orgId, amount: new Decimal('7500.00') },
    })
    await prisma.bankImportAttempt.updateMany({
      where: { organizationId: orgId },
      data: {
        status: 'RUNNING',
        finishedAt: null,
        // Arrendet åldras genom att skrivas gammalt — mekaniken mäts, inte klockan.
        heartbeatAt: new Date(Date.now() - IMPORT_LEASE_TTL_MS - 60_000),
      },
    })
    expect(await räknaRader()).toBe(1)

    const igen = await recon.importBankStatement(fil, 'utdrag.csv', orgId)

    expect(igen.forsok?.replayed).toBe(false)
    expect(igen.forsok?.forsokNr).toBe(2)
    // Den bevarade raden räknas som dubblett; den saknade skapas.
    expect(igen.duplicates).toBe(1)
    expect(igen.imported).toBe(1)
    expect(await räknaRader()).toBe(2)
  })

  it('A3b: RUNNING med FÄRSKT arrende nekas — inget övertagande', async () => {
    const { recon } = nyaTjänster(prisma)
    const fil = csv(RAD_A)
    await recon.importBankStatement(fil, 'utdrag.csv', orgId)
    await prisma.bankImportAttempt.updateMany({
      where: { organizationId: orgId },
      data: { status: 'RUNNING', heartbeatAt: new Date() },
    })

    await expect(recon.importBankStatement(fil, 'utdrag.csv', orgId)).rejects.toMatchObject({
      status: 409,
    })
    expect(await räknaRader()).toBe(1)
  })

  // ── A4 ─────────────────────────────────────────────────────────────────────

  it('A4: partiellt fel ger DELVIS — inte KLAR — och får köras om', async () => {
    const { recon } = nyaTjänster(prisma)
    // Rad 2 har ogiltigt belopp → F19:s filfelspolicy slår till.
    const trasig = csv(RAD_A, '2026-03-03,Insattning,INTE-ETT-BELOPP,9876543210')

    const först = await recon.importBankStatement(trasig, 'utdrag.csv', orgId)
    expect(först.errors.length).toBeGreaterThan(0)
    expect(först.forsok?.status).toBe('DELVIS')
    expect(först.forsok?.replayed).toBe(false)

    const attempt = await prisma.bankImportAttempt.findFirst({
      where: { organizationId: orgId },
    })
    expect(attempt?.status).toBe('PARTIAL')

    // Ett PARTIAL spelas ALDRIG upp — det körs om.
    const igen = await recon.importBankStatement(trasig, 'utdrag.csv', orgId)
    expect(igen.forsok?.replayed).toBe(false)
    expect(igen.forsok?.forsokNr).toBe(2)
    // Den lyckade raden bevarades och räknas nu som dubblett.
    expect(igen.duplicates).toBe(1)
    expect(await räknaRader()).toBe(1)
  })

  // ── A5 ─────────────────────────────────────────────────────────────────────

  it('A5: RÄTTAD fil får nytt avtryck — den rättade raden lagras', async () => {
    const { recon } = nyaTjänster(prisma)
    const trasig = csv(RAD_A, '2026-03-03,Insattning,INTE-ETT-BELOPP,9876543210')
    await recon.importBankStatement(trasig, 'utdrag.csv', orgId)
    expect(await räknaRader()).toBe(1)

    const rättad = csv(RAD_A, RAD_B)
    const efter = await recon.importBankStatement(rättad, 'utdrag.csv', orgId)

    expect(efter.forsok?.replayed).toBe(false)
    expect(efter.errors).toHaveLength(0)
    expect(efter.forsok?.status).toBe('KLAR')
    expect(efter.duplicates).toBe(1) // den redan lagrade
    expect(efter.imported).toBe(1) // den rättade
    expect(await räknaRader()).toBe(2)
    // Två avtryck: den trasiga filen och den rättade är olika importer.
    expect(await prisma.bankImportAttempt.count({ where: { organizationId: orgId } })).toBe(2)
  })

  // ── A6 ─────────────────────────────────────────────────────────────────────

  it('A6: samma fil med ÄNDRAD bankmappning körs om — inget tyst gammalt svar', async () => {
    const { recon } = nyaTjänster(prisma)
    const fil = csv(RAD_A)

    const auto = await recon.importBankStatement(fil, 'utdrag.csv', orgId)
    expect(auto.forsok?.replayed).toBe(false)

    const medBank = await recon.importBankStatement(fil, 'utdrag.csv', orgId, 'SEB')

    // Körningen SKA ske på nytt — mappningen är en annan. Att den inte skapar
    // en andra rad är radnivåns förtjänst, inte filnivåns.
    expect(medBank.forsok?.replayed).toBe(false)
    expect(medBank.duplicates).toBe(1)
    expect(medBank.bank).toBe('SEB')
    expect(await räknaRader()).toBe(1)
  })

  // ── A8 ─────────────────────────────────────────────────────────────────────

  it('A8: två IDENTISKA verkliga rader i samma fil ger TVÅ bankrader (seq 0 och 1)', async () => {
    const { recon } = nyaTjänster(prisma)
    // Samma dag, samma belopp, samma text OCH samma referens. Basen lagrade EN.
    const fil = csv(RAD_A, RAD_A)

    const r = await recon.importBankStatement(fil, 'utdrag.csv', orgId)

    expect(r.imported).toBe(2)
    expect(r.duplicates).toBe(0)
    const rader = await prisma.bankTransaction.findMany({
      where: { organizationId: orgId },
      orderBy: { identitySeq: 'asc' },
      select: { identityKey: true, identitySeq: true },
    })
    expect(rader.map((x) => x.identitySeq)).toEqual([0, 1])
    expect(rader[0]?.identityKey).toBe(rader[1]?.identityKey)
  })

  it('A8b: en ANNAN fil med samma rad EN gång räknas som dubblett (summerar inte)', async () => {
    const { recon } = nyaTjänster(prisma)
    await recon.importBankStatement(csv(RAD_A, RAD_A), 'ett.csv', orgId)
    expect(await räknaRader()).toBe(2)

    // Annan fil (annat innehåll → annat avtryck) som bär betalningen EN gång.
    const andra = await recon.importBankStatement(csv(RAD_A, RAD_B), 'tva.csv', orgId)

    expect(andra.forsok?.replayed).toBe(false)
    expect(andra.duplicates).toBe(1) // RAD_A
    expect(andra.imported).toBe(1) // RAD_B
    expect(await räknaRader()).toBe(3) // 2 + 1, inte 4
  })

  // ── A9 ─────────────────────────────────────────────────────────────────────

  it('A9: två SAMTIDIGA importer av OLIKA filer som delar en rad → EN rad för den', async () => {
    const barriär = new Barriär(2)
    const a = klientMedBarriär(barriär, 'dedupläsning')
    const b = klientMedBarriär(barriär, 'dedupläsning')

    // VERKLIGT olika filer — inte bara olika filNAMN. Filnamnet ingår MED FLIT
    // inte i avtrycket: en omdöpt kopia av samma bytes är samma import, och att
    // låta namnet skilja dem hade gjort skyddet kringgåeligt med en `mv`.
    // Filerna delar RAD_A; fil två bär dessutom RAD_B.
    const utfall = await Promise.allSettled([
      nyaTjänster(a).recon.importBankStatement(csv(RAD_A), 'ett.csv', orgId),
      nyaTjänster(b).recon.importBankStatement(csv(RAD_A, RAD_B), 'tva.csv', orgId),
    ])
    await a.$disconnect()
    await b.$disconnect()

    expect(utfall.every((u) => u.status === 'fulfilled')).toBe(true)
    const räknare = utfall.map((u) =>
      u.status === 'fulfilled' ? (u.value as { imported: number; duplicates: number }) : null,
    )
    // Exakt EN av de två skapade den delade raden; den andra såg en dubblett.
    expect(räknare.filter((r) => r?.duplicates === 1)).toHaveLength(1)
    // RAD_A en gång + RAD_B en gång = två rader, inte tre.
    expect(await räknaRader()).toBe(2)
    expect(
      await prisma.bankTransaction.count({
        where: { organizationId: orgId, amount: new Decimal('9000.00') },
      }),
    ).toBe(1)
  }, 30_000)

  // ── A10 ────────────────────────────────────────────────────────────────────

  it('A10: byte-identisk fil i TVÅ organisationer — båda kör, ingen korsning', async () => {
    const { recon } = nyaTjänster(prisma)
    const fil = csv(RAD_A)

    const iA = await recon.importBankStatement(fil, 'utdrag.csv', orgId)
    const iB = await recon.importBankStatement(fil, 'utdrag.csv', orgB)

    expect(iA.forsok?.replayed).toBe(false)
    expect(iB.forsok?.replayed).toBe(false)
    expect(iB.imported).toBe(1)
    expect(iB.duplicates).toBe(0)
    expect(await räknaRader(orgId)).toBe(1)
    expect(await räknaRader(orgB)).toBe(1)
  })

  // ── A11 ────────────────────────────────────────────────────────────────────

  it('A11: en låskonflikt flyttar ALDRIG fram betalningstäckningen', async () => {
    const { recon } = nyaTjänster(prisma)
    const fil = csv(RAD_A)
    await recon.importBankStatement(fil, 'utdrag.csv', orgId)
    const efterLyckad = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { paymentDataThrough: true },
    })

    // Arrendet görs levande igen → nästa försök nekas.
    await prisma.bankImportAttempt.updateMany({
      where: { organizationId: orgId },
      data: { status: 'RUNNING', heartbeatAt: new Date() },
    })

    const rigg = nyaTjänster(prisma)
    // En SENARE fil som skulle ha flyttat fram täckningen — men samma avtryck.
    await expect(rigg.recon.importBankStatement(fil, 'utdrag.csv', orgId)).rejects.toMatchObject({
      status: 409,
    })

    // Färskhetstjänsten nåddes aldrig av det nekade försöket.
    expect(rigg.täckning).toHaveLength(0)
    const efterKonflikt = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { paymentDataThrough: true },
    })
    expect(efterKonflikt.paymentDataThrough?.toISOString() ?? null).toBe(
      efterLyckad.paymentDataThrough?.toISOString() ?? null,
    )
  })

  // ── A7: PDF-bekräftelsen ───────────────────────────────────────────────────

  async function nyDraft(transaktioner: Array<Record<string, unknown>>): Promise<string> {
    const rad = await prisma.bankStatementImport.create({
      data: {
        organizationId: orgId,
        fileName: 'utdrag.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        status: 'PARSED',
        originalParsedData: { transactions: transaktioner } as never,
        parsedData: { transactions: transaktioner } as never,
        transactionCount: transaktioner.length,
      },
      select: { id: true },
    })
    return rad.id
  }

  const PDF_RAD = {
    date: '2026-03-02',
    description: 'Insattning',
    ocr: '1234567897',
    amount: 9000,
    isIncoming: true,
  }

  it('A7: PDF-bekräftelse — upprepning med SAMMA lista spelas upp, ÄNDRAD lista körs om', async () => {
    const { pdf } = nyaTjänster(prisma)
    const id = await nyDraft([PDF_RAD])

    const först = await pdf.confirmImport(id, orgId, null, [PDF_RAD])
    expect(först.created).toBe(1)
    expect(först.forsok?.replayed).toBe(false)
    expect(await räknaRader()).toBe(1)

    // Samma lista → samma avtryck → uppspelning, inte "redan bekräftad"-fel.
    const igen = await pdf.confirmImport(id, orgId, null, [PDF_RAD])
    expect(igen.forsok?.replayed).toBe(true)
    expect(igen.created).toBe(1)
    expect(await räknaRader()).toBe(1)

    // ÄNDRAD lista → annat avtryck → körs om. Draften står i CONFIRMED, så
    // bekräftelsen NEKAS uttryckligen. Det viktiga är att svaret inte blir ett
    // tyst uppspelat "klart" för ett underlag som aldrig kördes.
    await expect(
      pdf.confirmImport(id, orgId, null, [{ ...PDF_RAD, amount: 9500 }]),
    ).rejects.toMatchObject({ status: 400 })
    expect(await räknaRader()).toBe(1)
  })

  it('A7b: två SAMTIDIGA bekräftelser av samma draft och lista — en kör, en nekas', async () => {
    const barriär = new Barriär(2)
    const a = klientMedBarriär(barriär, 'anspråk')
    const b = klientMedBarriär(barriär, 'anspråk')
    const id = await nyDraft([PDF_RAD])

    const utfall = await Promise.allSettled([
      nyaTjänster(a).pdf.confirmImport(id, orgId, null, [PDF_RAD]),
      nyaTjänster(b).pdf.confirmImport(id, orgId, null, [PDF_RAD]),
    ])
    await a.$disconnect()
    await b.$disconnect()

    expect(utfall.filter((u) => u.status === 'fulfilled')).toHaveLength(1)
    expect(
      utfall.filter(
        (u) => u.status === 'rejected' && (u.reason as { status?: number })?.status === 409,
      ),
    ).toHaveLength(1)
    expect(await räknaRader()).toBe(1)
    const draft = await prisma.bankStatementImport.findUniqueOrThrow({ where: { id } })
    expect(draft.status).toBe('CONFIRMED')
  }, 30_000)

  it('A7c: två SAMTIDIGA bekräftelser av samma draft med OLIKA listor — bara en skriver', async () => {
    // Två olika listor ger två olika AVTRYCK, så filnivåskyddet släpper med
    // rätta igenom båda — de är inte samma import. Det som måste hålla här är
    // anspråket på DRAFTEN: utan det hade båda skrivit bankrader från samma
    // underlag, alltså en andra bokföring.
    const barriär = new Barriär(2)
    const a = klientMedBarriär(barriär, 'anspråk')
    const b = klientMedBarriär(barriär, 'anspråk')
    const id = await nyDraft([PDF_RAD])

    const utfall = await Promise.allSettled([
      nyaTjänster(a).pdf.confirmImport(id, orgId, null, [PDF_RAD]),
      nyaTjänster(b).pdf.confirmImport(id, orgId, null, [{ ...PDF_RAD, amount: 9500 }]),
    ])
    await a.$disconnect()
    await b.$disconnect()

    expect(utfall.filter((u) => u.status === 'fulfilled')).toHaveLength(1)
    const nekad = utfall.find((u) => u.status === 'rejected') as PromiseRejectedResult | undefined
    // 409 (bekräftelsen pågår) eller 400 (redan bekräftad) — vilket beror på om
    // förloraren hann före eller efter vinnarens sista skrivning. BÅDA är rätt;
    // det som INTE får hända är att båda lyckas.
    expect([400, 409]).toContain((nekad?.reason as { status?: number })?.status)
    // EN lista skrevs, alltså EN bankrad. Två listor hade gett två.
    expect(await räknaRader()).toBe(1)
  }, 30_000)

  it('A7d: ett AVBRUTET commit (draft i CONFIRMING) återupptas av övertagandet', async () => {
    const { pdf } = nyaTjänster(prisma)
    const id = await nyDraft([PDF_RAD])

    // Efterlikna ett avbrott EFTER draft-anspråket men FÖRE commiten: draften
    // står i CONFIRMING, importförsöket i RUNNING med fallet arrende.
    await pdf.confirmImport(id, orgId, null, [PDF_RAD])
    await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
    await prisma.bankStatementImport.update({
      where: { id },
      data: { status: 'CONFIRMING', confirmedAt: null },
    })
    await prisma.bankImportAttempt.updateMany({
      where: { organizationId: orgId },
      data: {
        status: 'RUNNING',
        finishedAt: null,
        heartbeatAt: new Date(Date.now() - IMPORT_LEASE_TTL_MS - 60_000),
      },
    })

    const igen = await pdf.confirmImport(id, orgId, null, [PDF_RAD])

    // Utan `övertagande`-flaggan hade den här körningen nekats och draften
    // legat låst i CONFIRMING tills någon rättade den för hand.
    expect(igen.created).toBe(1)
    expect(igen.forsok?.replayed).toBe(false)
    expect(await räknaRader()).toBe(1)
    const draft = await prisma.bankStatementImport.findUniqueOrThrow({ where: { id } })
    expect(draft.status).toBe('CONFIRMED')
  })

  it('A7e: en FÖRSTA bekräftelse mot en CONFIRMING-draft nekas — inget övertagande', async () => {
    const { pdf } = nyaTjänster(prisma)
    const id = await nyDraft([PDF_RAD])
    await prisma.bankStatementImport.update({ where: { id }, data: { status: 'CONFIRMING' } })

    // DEN OMVÄNDA RIKTNINGEN mot A7d. Ett övertagande får plocka upp draften;
    // en helt ny bekräftelse får det inte, för då är CONFIRMING någon ANNANS
    // pågående arbete.
    await expect(
      pdf.confirmImport(id, orgId, null, [{ ...PDF_RAD, amount: 9500 }]),
    ).rejects.toMatchObject({ status: 409 })
    expect(await räknaRader()).toBe(0)
  })

  it('en draft i CONFIRMING kan inte avbrytas mitt i', async () => {
    const { pdf } = nyaTjänster(prisma)
    const id = await nyDraft([PDF_RAD])
    await prisma.bankStatementImport.update({ where: { id }, data: { status: 'CONFIRMING' } })

    // Utan spärren hade CANCELLED skrivits, commiten sedan skrivit CONFIRMED
    // över den, och bankraderna legat under en import operatören tror är
    // avbruten.
    await expect(pdf.cancelImport(id, orgId)).rejects.toMatchObject({ status: 409 })
    const draft = await prisma.bankStatementImport.findUniqueOrThrow({ where: { id } })
    expect(draft.status).toBe('CONFIRMING')
  })

  // ── Historiska rader ───────────────────────────────────────────────────────

  it('rader utan identitet (sentinel) skyddas av LÄSNINGEN, inte av indexet', async () => {
    // Efterlikna en rad skriven före migrationen: identityKey = '' (sentinel).
    await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        date: new Date('2026-03-02T00:00:00.000Z'),
        description: 'Insattning',
        amount: new Decimal('9000.00'),
        reference: '1234567897',
      },
    })
    const historisk = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId },
      select: { identityKey: true, identitySeq: true },
    })
    expect(historisk.identityKey).toBe('')

    // Två sådana rader kan samexistera — predikatet utesluter dem ur indexet.
    // Det är hela skälet till att indexet är partiellt.
    await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        date: new Date('2026-03-09T00:00:00.000Z'),
        description: 'Annan',
        amount: new Decimal('100.00'),
      },
    })

    const r = await nyaTjänster(prisma).recon.importBankStatement(csv(RAD_A), 'utdrag.csv', orgId)

    // Läsningen ser den historiska raden trots att indexet inte gör det.
    expect(r.duplicates).toBe(1)
    expect(r.imported).toBe(0)
    expect(await räknaRader()).toBe(2)
  })

  // ── NEGATIVKONTROLLER ──────────────────────────────────────────────────────

  it('A13 NEGATIVKONTROLL: utan det unika indexet producerar riggen dubbla rader', async () => {
    const fil = csv(RAD_A)
    // Säkrad definition före mutation — återställs exakt, inte ungefär.
    const [före] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'BankTransaction' AND indexname = 'bank_transaction_identity_unique'`
    expect(före?.indexdef).toContain('UNIQUE')

    try {
      await prisma.$executeRawUnsafe('DROP INDEX "bank_transaction_identity_unique"')

      const barriär = new Barriär(2)
      const a = klientMedBarriär(barriär, 'dedupläsning')
      const b = klientMedBarriär(barriär, 'dedupläsning')
      await Promise.allSettled([
        nyaTjänster(a).recon.importBankStatement(fil, 'ett.csv', orgId),
        nyaTjänster(b).recon.importBankStatement(csv(RAD_A, RAD_B), 'tva.csv', orgId),
      ])
      await a.$disconnect()
      await b.$disconnect()

      // RIGGEN KAN ALLTSÅ SE FELET: utan indexet lagras den DELADE raden TVÅ
      // gånger (9000-raden), alltså tre rader i stället för två. Utan den här
      // kontrollen hade A9:s gröna utfall lika gärna kunnat betyda att
      // överlappet aldrig uppstod.
      expect(
        await prisma.bankTransaction.count({
          where: { organizationId: orgId, amount: new Decimal('9000.00') },
        }),
      ).toBe(2)
    } finally {
      await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
      await prisma.$executeRawUnsafe(före!.indexdef)
      const [efter] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'BankTransaction' AND indexname = 'bank_transaction_identity_unique'`
      // EXAKT återställning: definitionen jämförs tecken för tecken.
      expect(efter?.indexdef).toBe(före?.indexdef)
    }
  }, 30_000)

  it('A13b NEGATIVKONTROLL: utan försöksradens unika villkor blir A1 två rader', async () => {
    const fil = csv(RAD_A)
    const [före] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'BankImportAttempt'
        AND indexname = 'BankImportAttempt_organizationId_fingerprint_key'`
    expect(före?.indexdef).toContain('UNIQUE')

    try {
      await prisma.$executeRawUnsafe(
        'DROP INDEX "BankImportAttempt_organizationId_fingerprint_key"',
      )

      const barriär = new Barriär(2)
      const a = klientMedBarriär(barriär, 'anspråk')
      const b = klientMedBarriär(barriär, 'anspråk')
      const utfall = await Promise.allSettled([
        nyaTjänster(a).recon.importBankStatement(fil, 'utdrag.csv', orgId),
        nyaTjänster(b).recon.importBankStatement(fil, 'utdrag.csv', orgId),
      ])
      await a.$disconnect()
      await b.$disconnect()

      // Utan villkoret tar BÅDA arrendet — ingen 409. Filnivåskyddet är alltså
      // det unika villkoret, inte koden runt det.
      expect(utfall.filter((u) => u.status === 'fulfilled')).toHaveLength(2)
      expect(await prisma.bankImportAttempt.count({ where: { organizationId: orgId } })).toBe(2)
      // Radnivån håller ändå — de två lagren är oberoende, och det syns här.
      expect(await räknaRader()).toBe(1)
    } finally {
      await prisma.bankImportAttempt.deleteMany({ where: { organizationId: orgId } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
      await prisma.$executeRawUnsafe(före!.indexdef)
      const [efter] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'BankImportAttempt'
          AND indexname = 'BankImportAttempt_organizationId_fingerprint_key'`
      expect(efter?.indexdef).toBe(före?.indexdef)
    }
  }, 30_000)

  it('A14 NEGATIVKONTROLL: utan mappningsledet får A6 FEL svar', async () => {
    const attempts = new BankImportAttemptService(prisma as never)
    const fil = csv(RAD_A)
    const gemensam = {
      organizationId: orgId,
      kind: 'CSV' as const,
      fileName: 'utdrag.csv',
      contentHash: hashaBytes(fil),
    }

    // Med ledet: två mappningar → två avtryck → båda kör.
    const m1 = await attempts.körEnGång({ ...gemensam, mappingHash: 'AUTO' }, async () => ({
      resultat: { v: 1 },
      partiellt: false,
    }))
    const m2 = await attempts.körEnGång({ ...gemensam, mappingHash: 'SEB' }, async () => ({
      resultat: { v: 2 },
      partiellt: false,
    }))
    expect(m1.replayed).toBe(false)
    expect(m2.replayed).toBe(false)
    expect(m2.resultat).toEqual({ v: 2 })

    // UTAN ledet (konstant mappningshash) → samma avtryck → den andra
    // mappningen får det FÖRSTAS svar, alltså en tolkning som aldrig kördes.
    let kördeAndra = false
    const k1 = await attempts.körEnGång(
      { ...gemensam, fileName: 'konst.csv', mappingHash: 'KONSTANT' },
      async () => ({ resultat: { v: 'auto' }, partiellt: false }),
    )
    const k2 = await attempts.körEnGång(
      { ...gemensam, fileName: 'konst.csv', mappingHash: 'KONSTANT' },
      async () => {
        kördeAndra = true
        return { resultat: { v: 'seb' }, partiellt: false }
      },
    )
    expect(k1.replayed).toBe(false)
    expect(k2.replayed).toBe(true)
    expect(kördeAndra).toBe(false)
    expect(k2.resultat).toEqual({ v: 'auto' }) // fel svar — det är poängen
  })
})
