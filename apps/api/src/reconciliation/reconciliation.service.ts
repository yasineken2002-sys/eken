import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common'
import * as crypto from 'crypto'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma, RentNoticeType } from '@prisma/client'
import type { BankTransaction } from '@prisma/client'
import * as XLSX from 'xlsx'
import { PrismaService } from '../common/prisma/prisma.service'
import { InvoicesService } from '../invoices/invoices.service'
import { computeInvoiceDebt } from '../invoices/invoice-debt'
import { paymentTargetStatus, isPaymentTransitionAllowed } from '../invoices/invoice-payment-status'
import {
  paymentReversalTargetStatus,
  statusBeforePartialPayment,
} from '../invoices/invoice-payment-reversal'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { AccountingService, bankPaymentSourceId } from '../accounting/accounting.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { computeRentDebt } from '../avisering/rent-debt.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import {
  validateUploadedFile,
  DETECTED_SPREADSHEET_TYPES,
  MAX_CSV_BYTES,
} from '../common/utils/file-validation'
import {
  projectReconciliationTransaction,
  type ReconciliationTransactionView,
} from './bank-transaction-views'

export interface ImportResult {
  imported: number
  duplicates: number
  autoMatched: number
  unmatched: number
  errors: string[]
  bank?: BankFormat
}

export type BankFormat = 'GENERIC' | 'HANDELSBANKEN' | 'SEB' | 'SWEDBANK'

export interface AutoMatchResult {
  matched: number
  /**
   * Transaktioner som kördes utan fel men inte kunde matchas. FÖRVÄNTAT utfall —
   * de väntar på manuell matchning.
   */
  unmatched: number
  /**
   * Transaktioner där matchningen KASTADE. Inte "ingen match" utan ett FEL:
   * bokföringen sa nej, en transaktion timade ut, databasen svarade inte.
   *
   * Egen räknare med flit. Slås de ihop med `unmatched` blir ett driftfel
   * oskiljbart från ett normalt utfall — och en operatör som ser "3 väntar"
   * har ingen anledning att titta i loggen.
   */
  failed: number
  /**
   * Transaktioner som bar en OCR som inte löste ut, och som därför INTE
   * beloppsgissades. De ingår i `unmatched` — räknaren finns för att skilja
   * "ingen ledtråd alls" från "en ledtråd som inte stämde", vilket är två helt
   * olika saker för den som ska granska manuellt.
   */
  skippedUnresolvedOcr: number
}

/**
 * P0-refaktor (PSD2-förberedelse): den ENDA vägen in för en rå banktransaktion —
 * fält-dedup → bankTransaction.create → matchTransaction. Filimporterna (CSV/BgMax/
 * PDF) delar EXAKT denna kärna via `ingestFromFile`. PSD2-API-källan får sin egen
 * `ingestFromApi` (med obligatoriskt `externalId`) i P1. Den härdade matchnings-/
 * bokföringslogiken (`matchTransaction`, #161-166) rörs ALDRIG av denna refaktor.
 */
export interface FileIngestInput {
  // Fält-dedup, bevarad EXAKT per källa (CSV/PDF: description, BgMax: rawOcr).
  // `organizationId` injiceras av `ingestFromFile` och får aldrig komma från raw.
  dedup: Prisma.BankTransactionWhereInput
  data: Omit<Prisma.BankTransactionUncheckedCreateInput, 'organizationId'>
  // PSD2 P1 — fält för cross-source dedupKey (Stockholm-dag + belopp + OCR). Saknas
  // OCR → ingen dedupKey (betalning utan referens kan inte matchas cross-source).
  crossSource?: { date: Date; amount: Decimal; ocr?: string | undefined }
}

// Utfall per rå transaktion. `matchError` sätts när raden skapades men
// matchTransaction kastade — varje källa mappar det till sitt eget felbeteende
// (CSV/BgMax: radfel; PDF: logga + unmatched), precis som före refaktorn.
export type FileIngestResult =
  | { duplicate: true }
  | { duplicate: false; transactionId: string; matched: boolean; matchError?: Error }

/**
 * PSD2 P1 — rå transaktion från en bank-API-källa (aggregator). `bookingDate` är
 * en instant som normaliseras till Europe/Stockholm-kalenderdag. `booked=false`
 * (pending) avvisas — matchning förutsätter finaliserade fakta. `currency` måste
 * vara SEK. `amount<=0` (återförd/negativ) avvisas EXPLICIT (aldrig tyst drop).
 */
export interface ApiRawTransaction {
  bookingDate: Date
  booked: boolean
  currency: string
  amount: number
  description: string
  ocr?: string | undefined
  reference?: string | undefined
}

// Explicit utfall för API-ingest — INGET tyst bortfall. `rejected` med typad
// anledning gör att P2:s sync-lager kan agera (t.ex. återförd betalning → framtida
// reverserings-hantering) istället för att en transaktion försvinner spårlöst.
export type ApiIngestResult =
  | { outcome: 'imported'; transactionId: string; matched: boolean; matchError?: Error }
  | { outcome: 'duplicate'; transactionId: string; via: 'externalId' | 'dedupKey' }
  | { outcome: 'rejected'; reason: 'NOT_BOOKED' | 'NON_SEK' | 'NON_POSITIVE' }

export interface ReconciliationStats {
  total: number
  matched: number
  unmatched: number
  ignored: number
  totalAmount: number
  matchedAmount: number
}

interface ParsedRow {
  date: Date | null
  description: string
  amount: number
  balance: number | undefined
  reference: string | undefined
}

// ── Column detection helpers ──────────────────────────────────────────────────

const DATE_KEYS = /^(datum|date|bokföringsdag|transaktionsdag|valutadag)$/i
const DESC_KEYS =
  /^(text|description|meddelande|specifikation|beskrivning|rubrik|avsändare|motpart)$/i
const AMOUNT_KEYS = /^(belopp|amount|transaktionsbelopp|kredit|debit)$/i
const BALANCE_KEYS = /^(saldo|balance|bokfört saldo)$/i
const REF_KEYS = /^(referens|reference|ocr|ref|ocr-nummer|meddelande till mottagare)$/i

function detectColumns(headers: string[]): {
  date: number
  description: number
  amount: number
  balance: number
  reference: number
} {
  const idx = { date: -1, description: -1, amount: -1, balance: -1, reference: -1 }
  headers.forEach((h, i) => {
    const clean = h.trim()
    if (idx.date === -1 && DATE_KEYS.test(clean)) idx.date = i
    if (idx.description === -1 && DESC_KEYS.test(clean)) idx.description = i
    if (idx.amount === -1 && AMOUNT_KEYS.test(clean)) idx.amount = i
    if (idx.balance === -1 && BALANCE_KEYS.test(clean)) idx.balance = i
    if (idx.reference === -1 && REF_KEYS.test(clean)) idx.reference = i
  })
  return idx
}

// ── Bank format detection (header-fingerprint) ────────────────────────────────
// Svenska bankexporter har stabila men olika kolumnnamn. Auto-detect baseras
// på unika kolumnkombinationer; vid osäkerhet faller vi tillbaka till generic.
function detectBankFormat(headers: string[]): BankFormat {
  const norm = headers.map((h) => h.trim().toLowerCase())
  const has = (s: string) => norm.some((n) => n.includes(s))

  // Handelsbanken-export: "Bokföringsdag", "Specifikation", "Transaktionsbelopp", "Saldo"
  if (has('bokföringsdag') && has('transaktionsbelopp') && has('specifikation')) {
    return 'HANDELSBANKEN'
  }
  // SEB-export: "Bokföringsdatum", "Verifikationsnummer", "Text", "Belopp", "Saldo"
  if ((has('bokföringsdatum') || has('valutadag')) && has('verifikationsnummer')) {
    return 'SEB'
  }
  // Swedbank-export: "Radnummer", "Bokföringsdag", "Belopp", "Referens", "Bokfört saldo"
  if (has('radnummer') && has('bokfört saldo')) {
    return 'SWEDBANK'
  }
  return 'GENERIC'
}

// ── Date parsing ──────────────────────────────────────────────────────────────

function parseDate(raw: string | number | undefined): Date | null {
  if (raw === undefined || raw === null) return null

  // Excel serial date (number)
  if (typeof raw === 'number') {
    const d = XLSX.SSF.parse_date_code(raw)
    if (d) return new Date(d.y, d.m - 1, d.d)
  }

  const s = String(raw).trim()

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.slice(0, 10))
    return isNaN(d.getTime()) ? null : d
  }
  // DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const [day, month, year] = s.split('/')
    const d = new Date(`${year}-${month}-${day}`)
    return isNaN(d.getTime()) ? null : d
  }
  // YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

// ── Amount parsing ────────────────────────────────────────────────────────────

function parseAmount(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return NaN
  if (typeof raw === 'number') return raw
  // Swedish format: "1 234,56" → 1234.56; also handle "-1 234,56"
  const cleaned = String(raw).trim().replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

// ── OCR extraction ────────────────────────────────────────────────────────────

function extractOcr(text: string | undefined): string | null {
  if (!text) return null
  const matches = text.match(/\b(\d{4,20})\b/g)
  if (!matches || matches.length === 0) return null
  // Take the longest numeric sequence (most likely to be OCR)
  return matches.reduce((a, b) => (b.length > a.length ? b : a))
}

// ── PSD2 P1: Stockholm-dag + cross-source dedupKey ────────────────────────────

// Normaliserar en instant till Europe/Stockholm-KALENDERDAG, representerad som
// UTC-midnatt av den dagen — EXAKT samma representation som filimportens
// `new Date('YYYY-MM-DD')`, så att fil och API ger samma dedupKey för samma dag.
// (sv-SE ger 'YYYY-MM-DD'; samma mönster som notifications.service.ts.)
export function normalizeToStockholmDay(instant: Date): Date {
  const ymd = instant.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })
  return new Date(ymd)
}

// Deterministisk cross-source-nyckel. Fil OCH API stämplar denna likadant (samma
// Stockholm-dag, belopp med 2 decimaler, OCR/betalningsreferens) så att en
// betalning som ingestas via båda källorna känns igen som EN. Kräver OCR — utan
// betalningsreferens finns ingen pålitlig cross-source-identitet.
export function computeBankDedupKey(day: Date, amount: Decimal, ocr: string): string {
  return crypto
    .createHash('sha256')
    .update(`${day.toISOString().slice(0, 10)}|${amount.toFixed(2)}|${ocr}`)
    .digest('hex')
}

/**
 * #326 A — texten när avmatchning nekas för en överlämnad fordran.
 *
 * EN källa, TVÅ kontrollpunkter: den snabba förkontrollen och omprövningen
 * innanför radlåset kastar ordagrant samma fel. Skrevs texten på två ställen
 * kunde operatören få två olika förklaringar till samma nekande beroende på
 * exakt när i tiden anropet råkade landa.
 *
 * Säger INGENTING om vad inkassobolaget mottagit — se motiveringen vid
 * anropsstället.
 */
function collectionUnmatchBlockedMessage(invoiceNumber: string): string {
  return (
    `Faktura ${invoiceNumber} är överlämnad till inkasso och kan inte avmatchas. Backas ` +
    'matchningen växer restskulden tillbaka medan överlämningen bygger på det lägre beloppet ' +
    '— fordran skulle drivas in på fel underlag. Systemet har ingen väg att ta tillbaka en ' +
    'överlämnad fordran: kontakta supporten för att rätta matchningen och stämma av kravet.'
  )
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly events: InvoiceEventsService,
    private readonly accounting: AccountingService,
    // Bankavstämnings-härdning PR 4 (B) — varje lyckad import flyttar fram
    // paymentDataThrough (färskhetssignal som kravtrappans crons gatar på).
    private readonly freshness: PaymentFreshnessService,
    // #326 C — avi-sidans händelselogg. Egen tjänst i stället för en rå
    // `tx.rentNoticeEvent.create`, av samma skäl som fakturasidan använder
    // `InvoiceEventsService`: den DENORMALISERAR aktörsetiketten vid
    // skrivtillfället, så historiken bär ett namn även om användaren senare
    // raderas (`users.service.ts` gör en riktig delete, ingen soft-delete).
    private readonly rentNoticeEvents: RentNoticeEventsService,
  ) {}

  // Senaste giltiga transaktionsdatum i en importerad batch = den dag t.o.m. vilken
  // utdraget täcker betalningsdatan. Datakälls-agnostiskt: matar paymentDataThrough.
  //
  // OBS (medvetet val): BARA bulk-importer (CSV/BgMax/PDF) flyttar fram färskheten.
  // En MANUELL matchning (manualMatch) eller enskild auto-match flyttar INTE fram den
  // — en enskild matchad transaktion är inget KOMPLETTHETS-besked ("alla betalningar
  // t.o.m. X är kända"), bara att EN betalning hanterats. Att låta den flytta fram
  // paymentDataThrough vore att felaktigt intyga full täckning. En org som bara
  // matchar manuellt utan att importera utdrag förblir därför korrekt "ofärsk" tills
  // ett utdrag laddas upp.
  private latestCoverageDate(dates: Array<Date | null | undefined>): Date | null {
    let max: Date | null = null
    for (const d of dates) {
      if (d && !isNaN(d.getTime()) && (!max || d > max)) max = d
    }
    return max
  }

  private async advancePaymentFreshness(
    organizationId: string,
    coverage: Date | null,
  ): Promise<void> {
    if (!coverage) return
    try {
      await this.freshness.recordPaymentDataThrough(organizationId, coverage)
    } catch (err) {
      // Färskhetsuppdateringen får ALDRIG fälla en import (penganeutral sidoeffekt).
      this.logger.error(
        `paymentDataThrough kunde inte uppdateras för org ${organizationId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ── Delad ingest-kärna (fil-källor) ─────────────────────────────────────────
  // En rå banktransaktion in: fält-dedup → create → matchTransaction. Detta är den
  // gemensamma pipelinen som CSV/BgMax/PDF-importerna delar. `organizationId` sätts
  // här (aldrig från raw) — defense-in-depth för multi-tenant-scopingen. Kastar
  // vidare vid dedup-/create-fel (källans radloop hanterar det som förr); ett
  // matchTransaction-fel fångas och returneras som `matchError` så att varje källa
  // behåller sitt exakta räknar-/felbeteende.
  async ingestFromFile(organizationId: string, input: FileIngestInput): Promise<FileIngestResult> {
    // PSD2 P1 — cross-source-nyckel (fil OCH API stämplar likadant).
    const dedupKey = input.crossSource?.ocr
      ? computeBankDedupKey(input.crossSource.date, input.crossSource.amount, input.crossSource.ocr)
      : null

    // Migrationsöverlapp: en betalning som REDAN ingestats via PSD2-API (externalId
    // != null) får inte skapa en andra fil-rad → dubbel-allokering (#162-klassen).
    // Riktad ENBART mot API-rader, så fil-mot-fil-dedupen nedan är byte-identisk med
    // förr. No-op tills P2 börjar skapa API-rader (då finns inga → inget beteendeskifte).
    if (dedupKey) {
      const apiRow = await this.prisma.bankTransaction.findFirst({
        where: { organizationId, dedupKey, externalId: { not: null } },
        select: { id: true },
      })
      if (apiRow) return { duplicate: true }
    }

    // Fält-dedup — OFÖRÄNDRAD per källa (CSV/PDF: description, BgMax: rawOcr).
    const existing = await this.prisma.bankTransaction.findFirst({
      where: { organizationId, ...input.dedup },
    })
    if (existing) return { duplicate: true }

    const tx = await this.prisma.bankTransaction.create({
      data: { organizationId, ...input.data, ...(dedupKey ? { dedupKey } : {}) },
    })

    try {
      const matched = await this.matchTransaction(tx, organizationId)
      return { duplicate: false, transactionId: tx.id, matched }
    } catch (err) {
      return {
        duplicate: false,
        transactionId: tx.id,
        matched: false,
        matchError: err instanceof Error ? err : new Error(String(err)),
      }
    }
  }

  // ── PSD2-API-ingest (P1: väg byggd, ingen skarp källa förrän P2) ─────────────
  // Typad ingång för bank-API-källor. `externalId` är OBLIGATORISKT (till skillnad
  // från fil-vägen) → idempotens är strukturellt garanterad, inte disciplin.
  // `organizationId` sätts av anroparen från VÅR DB (BankConsent i P2), aldrig ur
  // aggregatorns råsvar. Rör ALDRIG matchTransaction/bokföringen — bara vägen in.
  async ingestFromApi(
    organizationId: string,
    externalId: string,
    raw: ApiRawTransaction,
  ): Promise<ApiIngestResult> {
    // Booked-only: pending kan byta id/belopp och kringgå externalId — matchning
    // förutsätter finaliserade fakta.
    if (!raw.booked) return { outcome: 'rejected', reason: 'NOT_BOOKED' }
    // Valuta: BankTransaction saknar valutafält; ett icke-SEK-belopp skulle
    // felmatcha tyst i 1-krons-toleransen. Avvisa EXPLICIT (aldrig felkonvertera).
    if (raw.currency !== 'SEK') return { outcome: 'rejected', reason: 'NON_SEK' }
    // Storno/negativa: får ALDRIG tyst droppas (tyst drop → felaktig PAID mot BFL).
    // Avvisas explicit så P2:s sync-lager kan agera (framtida reverserings-hantering).
    if (!(raw.amount > 0)) return { outcome: 'rejected', reason: 'NON_POSITIVE' }

    const date = normalizeToStockholmDay(raw.bookingDate)
    const amount = new Decimal(raw.amount.toFixed(2))
    const rawOcr = raw.ocr ?? extractOcr(raw.reference) ?? extractOcr(raw.description) ?? undefined
    const dedupKey = rawOcr ? computeBankDedupKey(date, amount, rawOcr) : null

    // Steg 1 (cross-source): en betalning som redan ingestats via FIL fångas här,
    // så API inte skapar en andra rad → dubbel-allokering (#162-klassen).
    if (dedupKey) {
      const crossSource = await this.prisma.bankTransaction.findFirst({
        where: { organizationId, dedupKey },
        select: { id: true },
      })
      if (crossSource)
        return { outcome: 'duplicate', transactionId: crossSource.id, via: 'dedupKey' }
    }

    // Steg 2 (atomär, API-vs-API): create-och-fånga-P2002 på @@unique(org, externalId).
    // ALDRIG findFirst-först — två samtidiga synkar skulle båda passera en förkontroll
    // och dubbel-dispatcha (TOCTOU, samma läxa som #162).
    let tx
    try {
      tx = await this.prisma.bankTransaction.create({
        data: {
          organizationId,
          externalId,
          date,
          description: raw.description,
          amount,
          ...(rawOcr ? { rawOcr } : {}),
          ...(raw.reference ? { reference: raw.reference } : {}),
          ...(dedupKey ? { dedupKey } : {}),
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.bankTransaction.findFirst({
          where: { organizationId, externalId },
          select: { id: true },
        })
        return {
          outcome: 'duplicate',
          transactionId: existing?.id ?? externalId,
          via: 'externalId',
        }
      }
      throw err
    }

    try {
      const matched = await this.matchTransaction(tx, organizationId)
      return { outcome: 'imported', transactionId: tx.id, matched }
    } catch (err) {
      return {
        outcome: 'imported',
        transactionId: tx.id,
        matched: false,
        matchError: err instanceof Error ? err : new Error(String(err)),
      }
    }
  }

  // ── Parse CSV ───────────────────────────────────────────────────────────────

  private parseCsv(buffer: Buffer): { rows: ParsedRow[]; bank: BankFormat } {
    const text = buffer.toString('utf-8')
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length < 2) return { rows: [], bank: 'GENERIC' }

    // Vissa banker (t.ex. Swedbank) lägger en metadata-rad före headerraden.
    // Heuristik: rätt headerrad innehåller "datum"/"bokföringsdag" + "belopp".
    let headerLineIdx = 0
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const lower = (lines[i] ?? '').toLowerCase()
      if (
        (lower.includes('datum') || lower.includes('bokföringsdag')) &&
        lower.includes('belopp')
      ) {
        headerLineIdx = i
        break
      }
    }
    const firstLine = lines[headerLineIdx] ?? ''
    const delimiter = firstLine.includes(';') ? ';' : ','
    const headers = firstLine.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''))
    const bank = detectBankFormat(headers)
    const cols = detectColumns(headers)

    const rows: ParsedRow[] = []
    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const cells = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''))
      const dateRaw: string | undefined = cols.date >= 0 ? cells[cols.date] : undefined
      const amountRaw: string | undefined = cols.amount >= 0 ? cells[cols.amount] : undefined
      const descRaw: string | undefined = cols.description >= 0 ? cells[cols.description] : cells[1]
      const balRaw: string | undefined = cols.balance >= 0 ? cells[cols.balance] : undefined
      const refRaw: string | undefined = cols.reference >= 0 ? cells[cols.reference] : undefined

      const date = parseDate(dateRaw)
      const amount = parseAmount(amountRaw)
      const description = descRaw ?? ''
      const balNum = parseAmount(balRaw)
      const balance: number | undefined = isNaN(balNum) ? undefined : balNum
      const reference: string | undefined = refRaw

      rows.push({ date, description, amount, balance, reference })
    }
    return { rows, bank }
  }

  // ── Parse XLSX ──────────────────────────────────────────────────────────────

  private parseXlsx(buffer: Buffer): { rows: ParsedRow[]; bank: BankFormat } {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return { rows: [], bank: 'GENERIC' }
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) return { rows: [], bank: 'GENERIC' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jsonRows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, {
      raw: false,
      defval: '',
    })
    if (jsonRows.length === 0) return { rows: [], bank: 'GENERIC' }

    // Detect column keys from first row keys
    const headers = Object.keys(jsonRows[0] ?? {})
    const bank = detectBankFormat(headers)
    const cols = detectColumns(headers)
    const headerByIdx = headers

    const rows: ParsedRow[] = []
    for (const row of jsonRows) {
      const dateKey = cols.date >= 0 ? headerByIdx[cols.date] : undefined
      const amountKey = cols.amount >= 0 ? headerByIdx[cols.amount] : undefined
      const descKey = cols.description >= 0 ? headerByIdx[cols.description] : undefined
      const balKey = cols.balance >= 0 ? headerByIdx[cols.balance] : undefined
      const refKey = cols.reference >= 0 ? headerByIdx[cols.reference] : undefined

      const dateRaw: string | undefined =
        dateKey !== undefined ? (row[dateKey] as string | undefined) : undefined
      const amountRaw: string | number | undefined =
        amountKey !== undefined ? (row[amountKey] as string | number | undefined) : undefined
      const descRaw: string | undefined =
        descKey !== undefined ? (row[descKey] as string | undefined) : undefined
      const balRaw: string | number | undefined =
        balKey !== undefined ? (row[balKey] as string | number | undefined) : undefined
      const refRaw: string | undefined =
        refKey !== undefined ? (row[refKey] as string | undefined) : undefined

      const date = parseDate(dateRaw)
      const amount = parseAmount(amountRaw)
      const description = descRaw ?? ''
      const balNum = parseAmount(balRaw)
      const balance: number | undefined = isNaN(balNum) ? undefined : balNum
      const reference: string | undefined = refRaw

      rows.push({ date, description, amount, balance, reference })
    }
    return { rows, bank }
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  async importBankStatement(
    fileBuffer: Buffer,
    filename: string,
    organizationId: string,
    bankOverride?: BankFormat,
  ): Promise<ImportResult> {
    const ext = filename.toLowerCase().split('.').pop() ?? ''
    let parsed: { rows: ParsedRow[]; bank: BankFormat }

    // SECURITY (H3): validera storlek + faktiskt innehåll innan parse. CSV är
    // ren text utan signatur (allowTextWithoutSignature), .xlsx/.xls måste ha
    // en giltig Excel-/OOXML-signatur — annars avvisas filen.
    validateUploadedFile(fileBuffer, {
      allowedDetectedMimes: DETECTED_SPREADSHEET_TYPES,
      maxBytes: MAX_CSV_BYTES,
      allowTextWithoutSignature: true,
    })

    if (ext === 'csv') {
      parsed = this.parseCsv(fileBuffer)
    } else if (ext === 'xlsx' || ext === 'xls') {
      parsed = this.parseXlsx(fileBuffer)
    } else {
      throw new BadRequestException('Endast CSV och Excel-filer (.csv, .xlsx, .xls) stöds')
    }

    const rows = parsed.rows
    const bank: BankFormat = bankOverride ?? parsed.bank

    const result: ImportResult = {
      imported: 0,
      duplicates: 0,
      autoMatched: 0,
      unmatched: 0,
      errors: [],
      bank,
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (!row) continue

      try {
        // Skip rows without a valid date
        if (!row.date || isNaN(row.date.getTime())) {
          result.errors.push(`Rad ${i + 2}: Ogiltigt datum`)
          continue
        }
        // Skip rows without a valid amount
        if (isNaN(row.amount)) {
          result.errors.push(`Rad ${i + 2}: Ogiltigt belopp`)
          continue
        }
        // Skip debits (outgoing payments)
        if (row.amount <= 0) continue

        const amountDecimal = new Decimal(row.amount.toFixed(2))

        // Extract OCR from reference or description
        const rawOcr = extractOcr(row.reference) ?? extractOcr(row.description)

        // Delad ingest-kärna: fält-dedup (org, date, description, amount) → create → match.
        const outcome = await this.ingestFromFile(organizationId, {
          dedup: { date: row.date, description: row.description, amount: amountDecimal },
          data: {
            date: row.date,
            description: row.description,
            amount: amountDecimal,
            ...(row.balance !== undefined ? { balance: new Decimal(row.balance.toFixed(2)) } : {}),
            ...(row.reference ? { reference: row.reference } : {}),
            ...(rawOcr ? { rawOcr } : {}),
          },
          crossSource: {
            date: row.date,
            amount: amountDecimal,
            ...(rawOcr ? { ocr: rawOcr } : {}),
          },
        })
        if (outcome.duplicate) {
          result.duplicates++
          continue
        }
        result.imported++
        // Matchfel → radfel (samma som när matchTransaction kastade i radens try förr).
        if (outcome.matchError) throw outcome.matchError
        if (outcome.matched) {
          result.autoMatched++
        } else {
          result.unmatched++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Rad ${i + 2}: ${msg}`)
      }
    }

    // PR 4 (B) — utdraget täcker betalningsdatan t.o.m. dess senaste radslut. Flyttar
    // fram paymentDataThrough oavsett om raderna var inbetalningar eller uttag: ett
    // utdrag UTAN inbetalningar är ändå färsk data som bekräftar "inga betalningar än".
    await this.advancePaymentFreshness(
      organizationId,
      this.latestCoverageDate(rows.map((r) => r?.date)),
    )

    return result
  }

  // ── BgMax-import (Bankgirot) ─────────────────────────────────────────────
  // 80-tecken-rader. TC 01 = filheader, TC 05 = sektionsstart (innehåller
  // bokföringsdatum), TC 20/21 = OCR-betalning, TC 70 = slutpost. Vi parsar
  // belopp i öre, OCR-referens och datum från sektionsraderna.
  //
  // Tidigare låg parsern dold inne i AI-tool-pathen — flyttat hit så HTTP-
  // endpointen, AI-toolet och eventuella framtida cron-jobb delar samma
  // implementation. Idempotency: dubblett-check på (org, date, amount, ocr).
  async importBgMaxFile(
    fileBuffer: Buffer,
    fileName: string,
    organizationId: string,
  ): Promise<ImportResult & { fileName: string }> {
    // SECURITY (H3): BgMax är ren text (fastformat 80 tecken). Tillåt
    // signaturlösa textfiler men avvisa allt med en binär signatur (en
    // omdöpt .exe/.zip osv) samt filer över taket.
    validateUploadedFile(fileBuffer, {
      allowedDetectedMimes: [],
      maxBytes: MAX_CSV_BYTES,
      allowTextWithoutSignature: true,
    })

    const text = fileBuffer.toString('utf8')
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0)

    const result: ImportResult & { fileName: string } = {
      fileName,
      imported: 0,
      duplicates: 0,
      autoMatched: 0,
      unmatched: 0,
      errors: [],
    }

    let sectionDate: Date | null = null
    let latestCoverage: Date | null = null
    for (const line of lines) {
      const tc = line.slice(0, 2)

      // TC 05: 0-1=tc, 2-11=BG(10), 12-21=PG(10), 22-29=date(8 YYYYMMDD)
      if (tc === '05') {
        const dateStr = line.slice(22, 30)
        if (/^\d{8}$/.test(dateStr)) {
          sectionDate = new Date(
            `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`,
          )
        }
        continue
      }

      // TC 20 / 21: OCR-betalning. Layout (Bankgirot v3):
      //   pos 1-2:   TC
      //   pos 3-12:  mottagar-bankgiro (10)
      //   pos 13-37: betalarens referens / OCR (25)
      //   pos 38-55: belopp i öre (18)
      if (tc !== '20' && tc !== '21') continue

      try {
        const ocr = line.slice(12, 37).trim()
        const amountOre = parseInt(line.slice(37, 55).trim(), 10)
        if (!Number.isFinite(amountOre) || amountOre <= 0) {
          result.errors.push('Rad: ogiltigt belopp')
          continue
        }
        const amount = amountOre / 100
        const txDate = sectionDate ?? new Date()
        // PR 4 (B) — täckningsdatum för paymentDataThrough (även dubbletter räknas:
        // datan finns redan, importen bekräftar att den är aktuell t.o.m. detta datum).
        if (!latestCoverage || txDate > latestCoverage) latestCoverage = txDate
        const description = `BgMax inbetalning${ocr ? ` (OCR ${ocr})` : ''}`
        const amountDecimal = new Decimal(amount.toFixed(2))

        // Delad ingest-kärna: fält-dedup (org, date, amount, rawOcr) → create → match.
        const outcome = await this.ingestFromFile(organizationId, {
          dedup: { date: txDate, amount: amountDecimal, ...(ocr ? { rawOcr: ocr } : {}) },
          data: {
            date: txDate,
            description,
            amount: amountDecimal,
            ...(ocr ? { rawOcr: ocr } : {}),
          },
          crossSource: { date: txDate, amount: amountDecimal, ...(ocr ? { ocr } : {}) },
        })
        if (outcome.duplicate) {
          result.duplicates++
          continue
        }
        result.imported++
        // Matchfel → radfel (samma som när matchTransaction kastade i radens try förr).
        if (outcome.matchError) throw outcome.matchError
        if (outcome.matched) result.autoMatched++
        else result.unmatched++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(msg)
      }
    }

    if (result.imported === 0 && result.duplicates === 0) {
      throw new BadRequestException(
        'Inga giltiga BgMax-poster hittades i filen. Kontrollera att det är en BgMax-fil från Bankgirot.',
      )
    }

    // PR 4 (B) — flytta fram paymentDataThrough till BgMax-filens senaste sektionsdatum.
    await this.advancePaymentFreshness(organizationId, latestCoverage)

    return result
  }

  // ── Match ───────────────────────────────────────────────────────────────────

  async matchTransaction(
    transaction: BankTransaction,
    organizationId: string,
    prismaClient?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const db = prismaClient ?? this.prisma
    const tolerance = new Decimal('1.00')

    // ── 1. OCR-match (deterministisk) ────────────────────────────────────
    // Sök i båda tabeller: kommersiell faktura och hyresavi. Hyresavin
    // (RentNotice) har egen OCR-serie genererad av OcrService — utan den
    // här grenen landar alla BgMax-betalningar för bostadshyror som
    // UNMATCHED, vilket var Bug 3 i bankavstämnings-flödet.
    if (transaction.rawOcr) {
      const invoice =
        (await db.invoice.findFirst({
          where: {
            organizationId,
            ocrNumber: transaction.rawOcr,
            status: { in: ['SENT', 'OVERDUE', 'PARTIAL'] },
          },
        })) ??
        (await db.invoice.findFirst({
          where: {
            organizationId,
            reference: transaction.rawOcr,
            status: { in: ['SENT', 'OVERDUE', 'PARTIAL'] },
          },
        }))

      if (invoice && invoice.total.minus(transaction.amount).abs().lte(tolerance)) {
        if (
          await this.applyMatchToInvoice(
            transaction.id,
            invoice.id,
            organizationId,
            invoice.total,
            transaction.amount,
            transaction.date,
            null,
            null,
            // Automatmatchning: ALDRIG partiell. Grenen nås bara när beloppet
            // redan ligger inom toleransen för fakturans total, och en maskinell
            // gissning ska inte kunna skapa en delbetalning.
            false,
          )
        ) {
          return true
        }
      }

      // OCR är per hyresgäst (samma OCR delas över ALLA månads-avier för
      // tenant X), så när hen har flera obetalda avier måste vi välja
      // ÄLDSTA först — det är så svenska banker hanterar OCR-betalningar
      // i praktiken. Utan orderBy returnerar Postgres en godtycklig rad,
      // vilket innebar att en betalning för maj kunde landa på juni-avin.
      const notice = await db.rentNotice.findFirst({
        where: {
          organizationId,
          ocrNumber: transaction.rawOcr,
          status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      })
      // PR 3b — partiell bankmatchning. Den DETERMINISTISKA OCR-grenen släpper nu
      // igenom amount < restskuld som en DELBETALNING (allokering + partialverifikat),
      // inte längre allt-eller-inget. Klassificering (full/partiell/överbetalning),
      // allokeringsbelopp och PAID-flip avgörs ATOMISKT inne i applyMatchToRentNotice
      // mot avins AKTUELLA ocrOutstanding. Äldsta obetalda avi väljs ovan (orderBy) —
      // ingen spillover till nästa avi. allowPartial=true: bara den deterministiska
      // OCR/referens-nyckeln får trigga en delbetalning (D3).
      if (notice) {
        const matched = await this.applyMatchToRentNotice(
          transaction.id,
          notice.id,
          organizationId,
          transaction.amount,
          transaction.date,
          null,
          true,
        )
        if (matched) return true

        // H3 PR B — VATTENFALL. Enskildvägen ovan avvisade (`false`), och det
        // vanligaste skälet är att beloppet överstiger den ÄLDSTA avins restskuld:
        // en klumpbetalning som täcker flera månader. Fram till nu blev den
        // UNMATCHED och hyresgästens pengar registrerades inte alls.
        //
        // Vattenfallet försöker fördela beloppet över hyresgästens öppna avier i
        // samma åldersordning. Det tar ALDRIG över ett fall enskildvägen klarar —
        // den koden är hårdare prövad — och avvisar självt om beloppet överstiger
        // hela skulden (#482).
        const vattenfall = await this.applyWaterfallToRentNotices(
          transaction.id,
          transaction.rawOcr,
          organizationId,
          transaction.amount,
          transaction.date,
          null,
        )
        if (vattenfall) return true
      }
    }

    // ── 2. Reference-match: fakturanummer / avinummer i description ─────
    // Banktransaktionens description innehåller ofta "F-2026-001" eller
    // "AVI-2026-06-0010" när betalaren manuellt skrivit in referens
    // istället för OCR. Vi extraherar mönstret och slår på det.
    const haystack = `${transaction.description ?? ''} ${transaction.reference ?? ''}`
    const invoiceNumberMatch = haystack.match(/\b(F-\d{4}-\d{3,})\b/i)
    const noticeNumberMatch = haystack.match(/\b(AVI-\d{4}-\d{2}-\d{4})\b/i)

    if (invoiceNumberMatch?.[1]) {
      const invoice = await db.invoice.findFirst({
        where: {
          organizationId,
          invoiceNumber: invoiceNumberMatch[1],
          status: { in: ['SENT', 'OVERDUE', 'PARTIAL'] },
        },
      })
      if (invoice && invoice.total.minus(transaction.amount).abs().lte(tolerance)) {
        if (
          await this.applyMatchToInvoice(
            transaction.id,
            invoice.id,
            organizationId,
            invoice.total,
            transaction.amount,
            transaction.date,
            null,
            null,
            // Automatmatchning: ALDRIG partiell. Grenen nås bara när beloppet
            // redan ligger inom toleransen för fakturans total, och en maskinell
            // gissning ska inte kunna skapa en delbetalning.
            false,
          )
        ) {
          return true
        }
      }
    }

    if (noticeNumberMatch?.[1]) {
      const notice = await db.rentNotice.findFirst({
        where: {
          organizationId,
          noticeNumber: noticeNumberMatch[1],
          status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
        },
      })
      // PR 3b — referensgrenen (avinummer i description) är lika deterministisk som
      // OCR och släpper därför också igenom delbetalningar. allowPartial=true.
      if (notice) {
        const matched = await this.applyMatchToRentNotice(
          transaction.id,
          notice.id,
          organizationId,
          transaction.amount,
          transaction.date,
          null,
          true,
        )
        if (matched) return true
      }
    }

    // ── M2: EN EXPLICIT MEN OLÖST OCR GISSAS INTE PÅ ──────────────────────
    //
    // Kommer vi hit med `rawOcr` SATT har betalaren angett en identifierare som
    // INTE löste ut — varken mot faktura, avi eller referensnummer. Att då gå
    // vidare till fuzzy är att ersätta ett känt fel med en kvalificerad
    // chansning: fuzzy matchar på BELOPP (unik kandidat inom 1 kr, 90 dagar) och
    // kan därför kreditera en TREDJE PARTS avi.
    //
    // ── VARFÖR JUST DEN HÄR GRENEN INTE SKA GISSA (mätt) ───────────────────
    //
    // Luhn-kontrollsiffran avgör vilka fel som ens blir en `rawOcr`:
    //
    //     enkelsiffrig felskrivning   0 av 396 passerar   (0,0 %)
    //     transponerade grannar       4 av 12  passerar   (33,3 %)
    //     två samtidiga fel          23 av 220 passerar   (10,5 %)
    //
    // En enkel felskrivning fångas alltså till HUNDRA procent — den blir aldrig
    // en `rawOcr` utan `rawOcr = null`, och går redan i dag till fuzzy helt
    // legitimt. Populationen som når hit består i stället av transpositioner som
    // klarade Luhn, OCR från en ANNAN organisation, och gamla OCR för redan
    // reglerade avier. I inget av de fallen är en beloppsgissning rätt svar.
    //
    // ── ORSAKEN, INTE BARA UTFALLET ───────────────────────────────────────
    //
    // Transaktionen förblir UNMATCHED, vilket redan betyder "väntar på manuell
    // matchning" — inget nytt tillstånd behövs. Det som saknades var ORSAKEN.
    // Det finns ingen händelsetabell för banktransaktioner, så orsaken bärs som
    // en TYPAD anledning i utfallet plus en loggrad, samma mönster som
    // `ApiIngestResult`s `rejected`-gren: "INGET tyst bortfall."
    if (transaction.rawOcr) {
      this.logger.warn(
        `[reconciliation] transaktion ${transaction.id} (org ${organizationId}) bär OCR ` +
          `${transaction.rawOcr} som inte löste ut mot någon faktura eller avi. Lämnas ` +
          'UNMATCHED för manuell granskning — beloppsgissning (fuzzy) hoppas över med flit.',
      )
      return false
    }

    // ── 3. Fuzzy-match: belopp + datum-fönster över BÅDA tabellerna ────
    // 90-dagarsfönstret håller oss inom rimligt sortiment och hindrar gamla
    // obetalda fakturor från att felmatcha mot dagsfärska betalningar.
    // Vi matchar bara om TOTALT en kandidat över båda tabellerna ligger
    // inom toleransen — annars för osäkert (AMBIGUOUS skulle kräva annan
    // status-modell, idag faller vi tillbaka till manuell matchning).
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
    const dateFrom = new Date(transaction.date.getTime() - ninetyDaysMs)
    const dateTo = new Date(transaction.date.getTime() + ninetyDaysMs)

    const invCandidates = await db.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['SENT', 'OVERDUE'] },
        dueDate: { gte: dateFrom, lte: dateTo },
      },
    })
    const noticeCandidates = await db.rentNotice.findMany({
      where: {
        organizationId,
        status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
        dueDate: { gte: dateFrom, lte: dateTo },
      },
    })

    const invMatches = invCandidates.filter((inv) =>
      inv.total.minus(transaction.amount).abs().lte(tolerance),
    )
    // Betalbar total = hyra + förbrukning (IMD) + övrig debitering (teknisk
    // förvaltning, Spår A) + påminnelseavgift (PR 2). Hyresgästen betalar EN summa
    // — denna måste matcha rentNoticePayableTotal/computeRentDebt.ocrOutstanding
    // exakt, annars auto-matchar inte en klumpbetalning och en betald avi
    // felaktigt eskaleras mot inkasso. Ränta exkluderas (ej OCR-reglerbar).
    const noticeMatches = noticeCandidates.filter((n) =>
      n.totalAmount
        .plus(n.consumptionAmount)
        .plus(n.miscChargeAmount)
        .plus(n.reminderFeeAmount)
        .minus(transaction.amount)
        .abs()
        .lte(tolerance),
    )

    if (invMatches.length + noticeMatches.length !== 1) return false

    if (invMatches.length === 1 && invMatches[0]) {
      const candidate = invMatches[0]
      // ── #326 F1: FUZZY GÅR GENOM DEN BEPRÖVADE VÄGEN ───────────────────────
      //
      // Här stod en HANDRULLAD matchningssekvens: status-guardad `updateMany`
      // till PAID (utan radlås och utan `organizationId` i WHERE), bank-länk,
      // händelse, och verifikatet i ett `try/catch` som SVALDE felet. Fem
      // separata skrivningar utan transaktion. Det var den ENDA fakturagrenen
      // som inte gick genom `applyMatchToInvoice` — alltså förbi allt som
      // byggts i #288/#290/#293/#307 C/#326.
      //
      // Vad det kostade:
      //   • INGEN allokering skapades. `computeInvoiceDebt` (total − Σ
      //     allokeringar) sa full restskuld medan huvudboken sa reglerad —
      //     #326:s divergens spegelvänd.
      //   • Depositionsfakturor är fuzzy-matchbara (kandidatfiltret har inget
      //     typfilter). Utan `applyMatchToInvoice`s Deposit-synk stod
      //     depositionen kvar PENDING för evigt → `refund()` nekade. Det är
      //     deposit-F1-buggen återinförd via en parallell väg.
      //   • Bokföringsfel var TYSTA i två riktningar: kastet fångades, och
      //     `null`-returen (saknat 1930/1510) ignorerades utan att ens loggas.
      //     Sentry har ingen logger-integration och `ErrorLog` skrivs bara av
      //     `GlobalExceptionFilter` — som aldrig nåddes. Fakturan kunde stå PAID
      //     utan att en krona bokförts (BFL 5 kap 1 §).
      //
      // ANTAGANDENA HÅLLER FÖR EN FUZZY-TRÄFF. Kandidaterna hämtas med
      // `status in ['SENT','OVERDUE']` (ovan), så PARTIAL ingår aldrig; utan
      // tidigare allokeringar är restskulden = totalen, och vägens
      // klassificering mot restskulden blir därmed matematiskt identisk med
      // fuzzy-filtrets mot totalen. Har fakturan mot förmodan en allokering
      // klassas beloppet som överbetalning → ingen match, faller till UNMATCHED.
      //
      // allowPartial=false — SAMMA REGEL SOM AVI-GRENEN NEDAN (D3). En
      // icke-deterministisk beloppsträff får aldrig bli en delbetalning; då
      // vore det en gissning om VILKEN faktura OCH om HUR MYCKET.
      //
      // PREMISSEN RÖRS INTE HÄR. Huruvida en gissning över huvud taget ska få
      // reglera en fordran automatiskt, i stället för att föreslås för en
      // människa, är ett produktbeslut (eget ärende) — inte något en bugfix ska
      // avgöra i förbifarten.
      return this.applyMatchToInvoice(
        transaction.id,
        candidate.id,
        organizationId,
        candidate.total,
        transaction.amount,
        transaction.date,
        null,
        null,
        false,
        'fuzzy',
      )
    }

    if (noticeMatches[0]) {
      const candidate = noticeMatches[0]
      // PR 3b — fuzzy förblir ALLT-ELLER-INGET (D3): allowPartial=false. En icke-
      // deterministisk beloppsträff får ALDRIG bli en delbetalning (det skulle gissa
      // fel avi). Fuzzy-filtret ovan kräver ändå ≈ full payable, så applyMatchToRentNotice
      // klassar träffen som full betalning; har avin redan en delbetalning blir det en
      // överbetalning → ingen match (faller till UNMATCHED). Bokföringen är ATOMISK i
      // applyMatchToRentNotice — inte längre fire-and-forget.
      return this.applyMatchToRentNotice(
        transaction.id,
        candidate.id,
        organizationId,
        transaction.amount,
        transaction.date,
        null,
        false,
        'fuzzy',
      )
    }

    return false
  }

  // HELA sekvensen (rad-lås → status-guardad PAID-claim → PAYMENT_RECEIVED-event →
  // bank-länk → betalningsverifikat) körs i ETT $transaction. Verifikatet bokförs
  // ATOMISKT (createJournalEntryForPayment(..., tx)) — ALDRIG fire-and-forget: faller
  // bokföringen kastas felet och HELA matchningen rullas tillbaka (ingen faktura kan
  // bli PAID utan verifikat, BFL 5 kap 6 §). Rad-låset + status-guarden (i
  // claimPaidWithinTx) serialiserar mot en samtidig manuell betalning
  // (markAsPaidManually — som sedan #288 tar samma lås, inte bara en status-guard)
  // så samma inbetalning aldrig dubbelbokförs. Speglar
  // applyMatchToRentNotice (den deterministiska hyresavi-vägen).
  //
  // Returnerar true om fakturan reglerades, false om den redan var betald/makulerad
  // (callern låter då transaktionen förbli UNMATCHED / falla vidare till nästa gren).
  // C4 — PARTIELL BANKMATCHNING MOT FAKTURA.
  //
  // Speglar applyMatchToRentNotice (hyresavins motsvarighet, i drift sedan PR 3b).
  //
  // Tidigare tog funktionen `invoiceTotal` och bokförde ALLTID det beloppet,
  // oavsett vad som faktiskt kommit in på kontot. En manuell matchning av en
  // inbetalning på 500 kr mot en faktura på 10 000 kr debiterade 1930 med
  // 10 000 kr — 1930 divergerade från kontoutdraget, och fakturan flippades
  // till PAID trots att 9 500 kr var obetalt.
  //
  // Nu allokeras det FAKTISKA transaktionsbeloppet (InvoicePayment) och
  // verifikatet bokförs på det. Restskulden är beräknad, aldrig lagrad.
  private async applyMatchToInvoice(
    transactionId: string,
    invoiceId: string,
    organizationId: string,
    invoiceTotal: Decimal,
    transactionAmount: Decimal,
    transactionDate: Date,
    userId: string | null,
    actorLabel: string | null,
    allowPartial: boolean,
    // ── #326 F1: HUR MATCHNINGEN GJORDES ────────────────────────────────────
    //
    // 'fuzzy' betyder att regleringen vilar på en GISSNING: belopp inom 1 kr,
    // 90-dagarsfönster, exakt en kandidat — ingen OCR, ingen referens. Det ska
    // gå att i efterhand plocka fram precis de regleringar som vilar på en
    // sannolikhet och granska dem särskilt (BFL 5 kap 11 §).
    //
    // EGEN PARAMETER, INTE `actorLabel`. Den senare betyder VEM överallt annars
    // i kodbasen ('System', 'Manuell markering', 'Inkassounderlag genererat')
    // och är dessutom en egen kolumn på händelsen. Att stoppa in 'fuzzy' där
    // hade sagt att aktören var fuzzy, och samtidigt tappat den `matchType`-
    // nyckel som redan var den sökbara formen. HUR och VEM är olika frågor.
    matchType?: 'fuzzy',
  ): Promise<boolean> {
    const claimedNumber = await this.prisma.$transaction(async (tx) => {
      // ── RADLÅS FÖRST (#307 C) ──────────────────────────────────────────────
      //
      // Låset är LASTBÄRANDE för statusrättningen, inte en allmän härdning: både
      // målstatusen och den `previousStatus` som skrivs till händelseloggen läses
      // ur den här raden. Läses den olåst kan båda vara inaktuella när de skrivs —
      // och en händelselogg som påstår fel utgångsstatus är precis defekten C
      // stänger.
      //
      // Låset fanns redan i den fulla betalningens gren (`claimPaidWithinTx` tar
      // samma `FOR UPDATE`) och i syskonvägen `applyMatchToRentNotice`. DELBETALNINGS-
      // grenen saknade det: `priorAllocations` lästes olåst, så restskulden — och
      // därmed klassificeringen full/del/överbetalning — kunde beräknas på inaktuell
      // grund vid samtidiga matchningar. Att flytta upp låset stänger den luckan på
      // köpet. Att ta det två gånger i den fulla grenen är en no-op (samma tx).
      //
      // LÅSORDNING OFÖRÄNDRAD: Invoice → BankTransaction → Deposit. Låset tas
      // tidigare i transaktionen, men Invoice låg först i BÅDA grenarna redan
      // (updateMany respektive claimPaidWithinTx föregick `bankTransaction.update`).
      // `unmatchTransaction` rör aldrig Invoice-status → ingen väg tar den motsatta
      // ordningen. Ingen ABBA.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} AND "organizationId" = ${organizationId} FOR UPDATE`

      const invoiceRow = await tx.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        select: { status: true, invoiceNumber: true },
      })
      if (!invoiceRow) return null
      const previousStatus = invoiceRow.status

      // Restskulden FÖRE denna betalning — beräknat tillstånd, inte lagrat.
      const priorAllocations = await tx.invoicePayment.findMany({
        where: { invoiceId },
        select: { amount: true },
      })
      const debtBefore = computeInvoiceDebt({
        total: invoiceTotal,
        allocations: priorAllocations.map((a) => a.amount),
      })
      const remaining = debtBefore.outstanding
      if (remaining.lte(0)) return null // redan fullt reglerad

      // Klassificera beloppet mot AKTUELL restskuld. Samma tolerans som
      // automatmatchningen (1 kr) för att fånga öresavrundning i bankfilen.
      // TOLERANS 1,00 kr — speglad från hyresavins bankmatchning. Fångar
      // öresavrundning i bankfilen så en inbetalning på 1249,99 mot en faktura
      // på 1250,00 räknas som full reglering i stället för att lämna en
      // öresskuld som aldrig regleras.
      // ⚠️ FLAGGAD FÖR REDOVISNINGSKONSULT: både att tolerans används och dess
      // storlek är ett affärsbeslut, inte en teknisk konstant.
      const tolerance = new Decimal('1.00')
      const diff = remaining.minus(transactionAmount)
      let allocation: Decimal
      let completesInvoice: boolean
      if (diff.abs().lte(tolerance)) {
        // Full reglering (inom tolerans) — allokera hela restskulden.
        allocation = remaining
        completesInvoice = true
      } else if (transactionAmount.lt(remaining.minus(tolerance))) {
        // Delbetalning.
        if (!allowPartial) return null
        allocation = transactionAmount
        completesInvoice = false
      } else {
        // Överbetalning — hanteras inte (se markAsPaidManually för samma regel).
        return null
      }
      const eventPayload = {
        transactionId,
        amount: allocation.toNumber(),
        outstandingAfter: remaining.minus(allocation).toNumber(),
        date: transactionDate.toISOString(),
        source: 'bank_reconciliation',
        ...(actorLabel ? { actorLabel } : {}),
        ...(matchType ? { matchType } : {}),
      }

      let invoiceNumber: string
      if (completesInvoice) {
        // Rad-lås + status-guardad PAID-claim + PAYMENT_RECEIVED-event i samma tx.
        const claim = await this.invoices.claimPaidWithinTx(
          tx,
          invoiceId,
          organizationId,
          transactionDate,
          userId,
          userId ? 'USER' : 'SYSTEM',
          eventPayload,
        )
        // Redan reglerad/makulerad (eller race-förlorare) → boka inget.
        if (!claim.claimed) return null
        invoiceNumber = claim.invoiceNumber
      } else {
        // Delbetalning: paidAt lämnas orörd (fakturan är inte betald).
        //
        // #307 C — MÅLSTATUSEN KOMMER UR `paymentTargetStatus`, samma källa som den
        // manuella vägen. Här stod tidigare `data: { status: 'PARTIAL' }` rakt av,
        // med SENT_TO_COLLECTION i WHERE-tillåtlistan: en delbetalning mot en
        // inkassofaktura flippade alltså statusen medan `remindersPaused` och
        // `sentToCollectionAt` stod kvar från överlämningen. Raden blev internt
        // motsägelsefull och fordran osynlig i både inkassovyn och kravtrappan.
        const newStatus = paymentTargetStatus(previousStatus, false)

        // Tillåtlistan är HÄRLEDD ur statusmaskinen i stället för handskriven.
        // Den gamla `in [...]`-listan räknade upp exakt de statusar varifrån
        // → PARTIAL är en giltig kant; `isPaymentTransitionAllowed` svarar på samma
        // fråga utan att listan kan glida isär från tabellen (jfr
        // COLLECTION_SOURCE_STATUSES i #307 PR 2b). DRAFT/VOID/PAID faller därmed
        // fortfarande igenom som förut — utan att stå uppräknade någonstans.
        if (!isPaymentTransitionAllowed(previousStatus, newStatus)) return null

        // WHERE nyckas på `previousStatus`: den utförda övergången är per
        // konstruktion den som validerades ovan.
        const partial = await tx.invoice.updateMany({
          where: { id: invoiceId, organizationId, status: previousStatus },
          data: { status: newStatus },
        })
        if (partial.count === 0) return null
        invoiceNumber = invoiceRow.invoiceNumber
        await this.events.record(
          invoiceId,
          'PAYMENT_PARTIAL',
          userId ? 'USER' : 'SYSTEM',
          userId,
          // FAKTISK utgångsstatus. Här stod `previousStatus: 'SENT'` hårdkodat —
          // vid delbetalning mot en inkassofaktura loggade alltså den enda historik
          // som finns över händelsen att fakturan gått från SENT. En
          // behandlingshistorik som säger fel är värre än ingen (BFL 5 kap 6–9 §).
          { previousStatus, newStatus, ...eventPayload },
          { tx },
        )
      }

      // Allokeringen — den registrerade, faktiska betalningen.
      // #326 D: id:t bär verifikatets idempotensnyckel (se nedan).
      const allocationRow = await tx.invoicePayment.create({
        data: {
          invoiceId,
          bankTransactionId: transactionId,
          amount: allocation,
          paidAt: transactionDate,
          source: 'BANK_RECONCILIATION',
        },
        select: { id: true },
      })

      // Länka banktransaktionen till fakturan. matchedRentNoticeId nollställs för XOR.
      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'MATCHED',
          invoiceId,
          matchedRentNoticeId: null,
          matchedAt: new Date(),
          ...(userId ? { matchedBy: userId } : {}),
        },
      })

      // Bokför inbetalningen i SAMMA tx — kastar (→ rollback) om kontoplanen saknas.
      const entry = await this.accounting.createJournalEntryForPayment(
        { id: invoiceId, invoiceNumber, total: invoiceTotal },
        // Det FAKTISKT mottagna (allokerade) beloppet — inte fakturans total.
        { id: transactionId, date: transactionDate, amount: allocation },
        organizationId,
        userId,
        // #326 D — nyckla på ALLOKERINGEN. Utan detta återanvänder en
        // ommatchning av samma transaktion det gamla, reverserade verifikatet.
        allocationRow.id,
        tx,
      )
      if (entry === null) {
        throw new InternalServerErrorException(
          `Betalningsverifikat kunde inte skapas för faktura ${invoiceNumber} — ` +
            'kontrollera att kontoplanen innehåller konto 1930 och 1510.',
        )
      }

      // deposit-F1: är fakturan en deposition-faktura (manuella deposits.create-
      // vägen, Deposit.invoiceId-länkad) → synka Deposit.status → PAID i SAMMA tx.
      // Utan detta stod en deposition betald via bankmatchning kvar PENDING för
      // evigt → refund() nekade och markRefundPendingForLease hittade den aldrig
      // (deposition kunde aldrig återbetalas). Status-guardad; för en icke-
      // deposition-faktura matchar `Deposit.invoiceId = invoiceId` ingen rad → no-op.
      // Ingen kontering ändras (fakturan bokförde redan 1510 D/2890 K vid create,
      // och createJournalEntryForPayment ovan stänger 1510 — samma som markPaid).
      // Bara vid FULL reglering — en delbetald deposition är inte betald.
      if (completesInvoice) {
        await tx.deposit.updateMany({
          where: { invoiceId, organizationId, status: 'PENDING' },
          data: { status: 'PAID', paidAt: transactionDate },
        })
      }

      return completesInvoice ? invoiceNumber : ''
    })

    if (claimedNumber === null) return false

    // Notis bara när fakturan faktiskt blev betald (tom sträng = delbetalning).
    if (claimedNumber !== '') {
      this.invoices.notifyInvoicePaid(organizationId, invoiceId, claimedNumber)
    }
    return true
  }

  // Match mot hyresavi. Bankavstämnings-härdning PR 3b — PARTIELL bankmatchning.
  //
  // HELA sekvensen (rad-lås → allokering → outstanding-läsning → status-flip →
  // bank-länk → partialverifikat) körs i ETT $transaction. Verifikatet bokförs
  // ATOMISKT (createJournalEntryForRentNoticePayment(..., tx)) — ALDRIG fire-and-
  // forget. Faller bokföringen kastas felet och hela transaktionen rullas tillbaka:
  // allokering + status + bank-länk ångras, bank-tx förblir UNMATCHED. En delbetalning
  // kan därmed aldrig hamna i ett halvtillstånd (seriens enda icke-penganeutrala PR).
  //
  // Callern väljer ÄLDSTA obetalda avi (orderBy dueDate) — ingen spillover till nästa
  // avi. Beloppet klassas mot avins AKTUELLA ocrOutstanding (allokeringsderiverad
  // restskuld, EXKL. ränta — samma waterfall-grind som kravtrappan i PR 3a):
  //   • FULL        |restskuld − amount| ≤ 1 kr → allokera restskulden (öre-fel
  //                  absorberas), flippa PAID, nollställ kravsteget.
  //   • PARTIELL    amount < restskuld − 1 kr → allokera amount, BEHÅLL status/steg.
  //                  Endast om allowPartial (deterministisk OCR/referens) — fuzzy är
  //                  allt-eller-inget (D3): allowPartial=false → en partiell-klass
  //                  avvisas (return false).
  //   • ÖVERBETALN. amount > restskuld + 1 kr → ingen match (D4, hanteras ej här).
  //
  // FOR UPDATE-låset serialiserar samtidiga delbetalningar på samma avi så Σ
  // allokeringar aldrig kan överstiga skulden via en race (READ COMMITTED skulle
  // annars låta två samtidiga delbetalningar båda läsa full restskuld).
  //
  // Returnerar true om en allokering registrerades, false annars (callern låter då
  // transaktionen falla vidare till nästa matchningsgren / förbli UNMATCHED).
  private async applyMatchToRentNotice(
    transactionId: string,
    noticeId: string,
    organizationId: string,
    transactionAmount: Decimal,
    transactionDate: Date,
    userId: string | null,
    allowPartial: boolean,
    // M2 PR 1: speglar fakturagrenens `matchType` — samma namn, samma värde.
    // 'fuzzy' betyder att regleringen vilar på en GISSNING (belopp inom 1 kr,
    // datum inom 90 dagar) i stället för på en deterministisk nyckel. Avi-grenen
    // saknade märkningen helt, så en gissning var oskiljbar från en OCR-träff i
    // historiken — och därmed omätbar.
    matchType?: 'fuzzy',
  ): Promise<boolean> {
    const tolerance = new Decimal('1.00')

    return this.prisma.$transaction(async (tx) => {
      // Rad-lås FÖRST: serialiserar samtidiga delbetalningar på samma avi.
      //
      // ⚠️ LÅSORDNINGEN ÄR EN SPÄRR, INTE BARA SERIALISERING (#296, #298).
      //
      // Det här låset är det ENDA som hindrar DEPOSIT-grenen nedan från att
      // dubbelbokföra mot en samtidig DepositsService.markPaid. Ordningen är:
      //
      //   denna väg:  RentNotice (lås här)  →  ...  →  Deposit (updateMany)
      //   markPaid:   Deposit (claim)       →  ...  →  RentNotice (updateMany)
      //
      // Motsatta riktningar. Krockar de sluts cirkeln och Postgres dödar en av
      // transaktionerna INNAN någon hunnit bokföra dubbelt. Skyddet är alltså en
      // sidoeffekt av låsordningen — inte en avsedd kontroll.
      //
      // MÄTT, INTE GISSAT (#296): 440 parallella försök mot riktig Postgres, elva
      // startförskjutningar i båda riktningarna → 440/440 gav ETT verifikat. Med
      // fönstret konstlat vidgat till 200 ms: fortfarande 40/40 ett verifikat.
      // Med DETTA LÅS BORTTAGET och samma vidgade fönster: 39/40 gav TVÅ verifikat,
      // 40 000 kr bokfört mot en fordran på 20 000.
      //
      // TAR DU BORT ELLER VÄNDER DEN HÄR ORDNINGEN tänder du ett penningfel i en
      // annan kodväg än den du ändrar. Fixa #296 (deposit-updateMany:ns count
      // kontrolleras aldrig, se kommentaren där) FÖRE eller SAMTIDIGT.
      await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${noticeId} AND "organizationId" = ${organizationId} FOR UPDATE`

      const notice = await tx.rentNotice.findFirst({
        where: { id: noticeId, organizationId },
        select: {
          id: true,
          noticeNumber: true,
          status: true,
          collectionStage: true,
          type: true,
          totalAmount: true,
          consumptionAmount: true,
          miscChargeAmount: true,
          reminderFeeAmount: true,
          interestAccruedAmount: true,
        },
      })
      if (!notice) throw new NotFoundException('Hyresavi hittades inte')

      // Bara öppna (obetalda) avier kan ta emot en betalning. En PAID/CANCELLED avi
      // (eller en race-förlorare) → ingen allokering; låt tx:n falla vidare.
      if (!['SENT', 'PENDING', 'OVERDUE'].includes(notice.status)) return false

      // #41: en DEPOSITIONS-avi hanteras separat. Den ingår ALDRIG i debt/kravtrappan
      // (computeRentDebt=0 för DEPOSIT, kravtrappan filtrerar type=RENT) — den lämnas
      // därför orörd av härdningen. Matchbar BARA om den har en länkad Deposit-rad
      // (som bokförts 1510 D/2890 K vid aktivering). Orphan-avier (ingen Deposit) →
      // return false (FAIL-CLOSED): annars skulle 1930 D/1510 K kreditera en 1510 som
      // aldrig debiterats (F1-fällan). Bygger på #109-carve-out (DEPOSIT-undantaget
      // i throw:et nedan) — vi bryter inte härdningen, vi fyller i den avsedda luckan.
      if (notice.type === RentNoticeType.DEPOSIT) {
        const deposit = await tx.deposit.findFirst({
          where: { rentNoticeId: noticeId, organizationId },
          select: { id: true, status: true },
        })
        if (!deposit || deposit.status !== 'PENDING') return false

        const priorDep = await tx.rentNoticePayment.findMany({
          where: { rentNoticeId: noticeId },
          select: { amount: true },
        })
        const paidDep = priorDep.reduce((s, a) => s.plus(new Decimal(a.amount)), new Decimal(0))
        const remainingDep = new Decimal(notice.totalAmount).minus(paidDep)
        if (remainingDep.lte(0)) return false
        // Deposition betalas i sin helhet (allt-eller-inget) — delbetalning ej meningsfull.
        if (transactionAmount.minus(remainingDep).abs().gt(tolerance)) return false

        // #326 D: id:t bär verifikatets idempotensnyckel.
        const depAllocation = await tx.rentNoticePayment.create({
          data: {
            rentNoticeId: noticeId,
            bankTransactionId: transactionId,
            amount: remainingDep,
            paidAt: transactionDate,
            source: 'BANK_RECONCILIATION',
          },
          select: { id: true },
        })
        await tx.rentNotice.updateMany({
          where: { id: noticeId, organizationId, status: { in: ['SENT', 'PENDING', 'OVERDUE'] } },
          data: { status: 'PAID', paidAt: transactionDate, paidAmount: notice.totalAmount },
        })
        // Deposition → PAID: sanningskällan för återbetalning (markRefundPendingForLease
        // hittar den vid uppsägning). Status-guardad mot samtidig markPaid-flip.
        //
        // ⚠️ #296: GUARDEN ÄR HALV — `count` kontrolleras ALDRIG. Uppdaterar den noll
        // rader (en samtidig markPaid hann claima depositionen efter läsningen ovan,
        // som är OLÅST) fortsätter transaktionen ändå: den skriver rentNoticePayment,
        // flippar avin och bokför ett EGET verifikat under en annan idempotensnyckel
        // än markPaids `deposit-manual-payment:<id>`. Två verifikat på samma
        // deposition, inget unikt index som fångar det.
        //
        // Att det inte händer idag beror ENBART på avins radlås högst upp i denna
        // transaktion — se låsordningskommentaren där. Bevisat i #296: med det låset
        // borttaget gav 39 av 40 parallella försök två verifikat och 40 000 kr
        // bokfört mot en fordran på 20 000.
        await tx.deposit.updateMany({
          where: { id: deposit.id, organizationId, status: 'PENDING' },
          data: { status: 'PAID', paidAt: transactionDate },
        })
        await tx.bankTransaction.update({
          where: { id: transactionId },
          data: {
            status: 'MATCHED',
            invoiceId: null,
            matchedRentNoticeId: noticeId,
            matchedAt: new Date(),
            ...(userId ? { matchedBy: userId } : {}),
          },
        })
        // 1930 D (bank) / 1510 K — stänger fordran som aktiveringen bokförde
        // 1510 D/2890 K. Netto över create+betalning = 1930 D / 2890 K (korrekt).
        const depEntry = await this.accounting.createJournalEntryForRentNoticePayment(
          // type=DEPOSIT → hoppar A2 rent-accrual-guarden (deposition gatas redan
          // ovan via länkad Deposit; dess accrual är deposit-invoice-nycklad).
          { id: noticeId, noticeNumber: notice.noticeNumber, type: RentNoticeType.DEPOSIT },
          { id: transactionId, date: transactionDate, amount: remainingDep },
          organizationId,
          userId,
          tx,
          depAllocation.id, // #326 D — nyckla på allokeringen
        )
        if (depEntry === null) {
          throw new InternalServerErrorException(
            `Betalningsverifikat kunde inte skapas för depositionsavi ${notice.noticeNumber} — ` +
              'kontrollera att kontoplanen innehåller konto 1930 och 1510.',
          )
        }
        return true
      }

      const priorAllocs = await tx.rentNoticePayment.findMany({
        where: { rentNoticeId: noticeId },
        select: { amount: true },
      })

      const debtInput = {
        type: notice.type,
        totalAmount: notice.totalAmount,
        consumptionAmount: notice.consumptionAmount,
        miscChargeAmount: notice.miscChargeAmount,
        reminderFeeAmount: notice.reminderFeeAmount,
        interestAccruedAmount: notice.interestAccruedAmount,
        allocations: priorAllocs.map((a) => a.amount),
      }
      const remaining = new Decimal(computeRentDebt(debtInput).ocrOutstanding)
      if (remaining.lte(0)) return false

      // Klassificera beloppet mot AKTUELL restskuld (ocrOutstanding).
      const diff = remaining.minus(transactionAmount)
      let allocationAmount: Decimal
      let completesNotice: boolean
      if (diff.abs().lte(tolerance)) {
        // FULL — absorbera öre-fel genom att allokera exakt restskulden.
        allocationAmount = remaining
        completesNotice = true
      } else if (transactionAmount.lt(remaining.minus(tolerance))) {
        // PARTIELL — genuin delbetalning. Endast via deterministisk nyckel (D3).
        if (!allowPartial) return false
        allocationAmount = transactionAmount
        completesNotice = false
      } else {
        // amount > restskuld + tolerans → överbetalning (D4): hanteras ej här.
        return false
      }

      // Allokeringen (bankTransactionId @unique skyddar mot dubbel-allokering).
      // #326 D: id:t bär verifikatets idempotensnyckel.
      const noticeAllocation = await tx.rentNoticePayment.create({
        data: {
          rentNoticeId: noticeId,
          bankTransactionId: transactionId,
          amount: allocationAmount,
          paidAt: transactionDate,
          source: 'BANK_RECONCILIATION',
        },
        select: { id: true },
      })

      // Σ allokeringar EFTER denna betalning — paidAmount-spegeln hålls i synk.
      const paidSum = computeRentDebt({
        ...debtInput,
        allocations: [...debtInput.allocations, allocationAmount],
      }).paid

      if (completesNotice) {
        // PAID + nollställ kravsteget. Statusguarden bevarar idempotensen tillsammans
        // med rad-låset; rad-låset garanterar att vi ser senaste committade allokeringar.
        await tx.rentNotice.updateMany({
          where: {
            id: noticeId,
            organizationId,
            status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
          },
          data: {
            status: 'PAID',
            paidAt: transactionDate,
            paidAmount: paidSum,
            collectionStage: 'NONE',
          },
        })
      } else {
        // Delbetalning: behåll status och kravsteg, uppdatera bara paidAmount-spegeln.
        // organizationId i WHERE som defense-in-depth (FIX 2-mönstret) trots att
        // raden redan org-validerats av findFirst + FOR UPDATE ovan.
        await tx.rentNotice.updateMany({
          where: { id: noticeId, organizationId },
          data: { paidAmount: paidSum },
        })
      }

      // M2 PR 1: mottagningshändelsen — se recordRentNoticePaymentReceived.
      await this.recordRentNoticePaymentReceived(tx, {
        rentNoticeId: noticeId,
        allocationId: noticeAllocation.id,
        transactionId,
        amount: allocationAmount,
        outstandingAfter: remaining.minus(allocationAmount),
        paidAt: transactionDate,
        userId,
        ...(matchType ? { matchType } : {}),
      })

      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'MATCHED',
          invoiceId: null,
          matchedRentNoticeId: noticeId,
          matchedAt: new Date(),
          ...(userId ? { matchedBy: userId } : {}),
        },
      })

      // Kravstegs-trail bara när vi faktiskt nollställde en aktiv trappa (full betalning).
      if (completesNotice && notice.collectionStage !== 'NONE') {
        // #340: via `record()`, inte en rå create. Den råa varianten satte
        // `actorLabel` BARA i SYSTEM-grenen — för en verklig användare skrevs
        // bara ett UUID. `users.service.ts` gör en riktig delete, ingen
        // soft-delete, så raderas användaren är namnet borta ur historiken för
        // alltid. Det är precis vad denormaliseringen i `record()` finns för.
        // Samma hål som #326 C stängde för PAYMENT_REVERSED, en nivå bort.
        await this.rentNoticeEvents.record(
          noticeId,
          'NOTE_ADDED',
          userId ? 'USER' : 'SYSTEM',
          userId ?? null,
          {
            action: 'collection-stage-reset',
            from: notice.collectionStage,
            reason: 'paid',
            source: 'bank_reconciliation',
          },
          { tx },
        )
      }

      // Partialverifikatet ATOMISKT i samma tx. amount = det FAKTISKT allokerade
      // delbeloppet (1930 D / 1510 K). Faller bokföringen kastas felet → full rollback.
      const entry = await this.accounting.createJournalEntryForRentNoticePayment(
        // RENT-avi → A2 fail-closed: kastar om avins accrual (rent-notice:<id>)
        // saknas (pre-A1-orphan) → hela matchningen rullas tillbaka, ingen spökkredit.
        { id: noticeId, noticeNumber: notice.noticeNumber, type: notice.type },
        { id: transactionId, date: transactionDate, amount: allocationAmount },
        organizationId,
        userId,
        tx,
        noticeAllocation.id, // #326 D — nyckla på allokeringen
      )
      // null = saknat 1930/1510 → bokföringsfel (ej giltigt no-op). Kasta så hela
      // transaktionen rullas tillbaka — ingen allokering utan verifikat. (DEPOSIT
      // hanteras i egen gren ovan; #109-carve-out är därmed konsumerat och den
      // tidigare `type !== DEPOSIT`-undantaget här är inte längre nödvändigt.)
      if (entry === null) {
        throw new InternalServerErrorException(
          `Betalningsverifikat kunde inte skapas för hyresavi ${notice.noticeNumber} — ` +
            'kontrollera att kontoplanen innehåller konto 1930 och 1510.',
        )
      }

      return true
    })
  }

  // ── Get transactions ─────────────────────────────────────────────────────────

  async getTransactions(
    organizationId: string,
    filters?: { status?: string; from?: string; to?: string },
  ): Promise<ReconciliationTransactionView[]> {
    const where: Prisma.BankTransactionWhereInput = { organizationId }

    if (filters?.status) {
      where.status = filters.status as 'UNMATCHED' | 'MATCHED' | 'IGNORED'
    }
    if (filters?.from ?? filters?.to) {
      where.date = {}
      if (filters?.from) where.date.gte = new Date(filters.from)
      if (filters?.to) where.date.lte = new Date(filters.to)
    }

    const rader = await this.prisma.bankTransaction.findMany({
      where,
      include: {
        invoice: { select: { id: true, invoiceNumber: true, status: true } },
        matchedRentNotice: {
          select: { id: true, noticeNumber: true, status: true, totalAmount: true },
        },
      },
      orderBy: { date: 'desc' },
      take: 200,
    })
    // HANDPROJICERING, inte bara en typ. En deklarerad returtyp ensam hade
    // ändrat vad TypeScript VISAR anroparen medan `balance` och `matchedBy`
    // fortsatte gå över tråden — TransformInterceptor wrappar bara i
    // { success, data } och kodbasen har ingen ClassSerializerInterceptor.
    // Typen hade då påstått något osant, vilket är sämre än ingen typ.
    return rader.map(projectReconciliationTransaction)
  }

  // ── Stats ────────────────────────────────────────────────────────────────────

  async getStats(organizationId: string): Promise<ReconciliationStats> {
    const grouped = await this.prisma.bankTransaction.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: { id: true },
      _sum: { amount: true },
    })

    const stats: ReconciliationStats = {
      total: 0,
      matched: 0,
      unmatched: 0,
      ignored: 0,
      totalAmount: 0,
      matchedAmount: 0,
    }

    for (const g of grouped) {
      const count = g._count.id
      const amount = g._sum.amount?.toNumber() ?? 0
      stats.total += count
      stats.totalAmount += amount
      if (g.status === 'MATCHED') {
        stats.matched = count
        stats.matchedAmount = amount
      } else if (g.status === 'UNMATCHED') {
        stats.unmatched = count
      } else if (g.status === 'IGNORED') {
        stats.ignored = count
      }
    }

    return stats
  }

  // ── Bulk auto-match (kör matchTransaction på alla UNMATCHED) ────────────────

  async autoMatchAll(organizationId: string): Promise<AutoMatchResult> {
    const candidates = await this.prisma.bankTransaction.findMany({
      where: { organizationId, status: 'UNMATCHED' },
      orderBy: { date: 'asc' },
    })

    let matched = 0
    let failed = 0
    // M2: transaktioner som bar en OCR som inte löste ut. Härledbart utan att
    // ändra `matchTransaction`s signatur — den tidiga returen är EXAKT fallet
    // "rawOcr satt och ingen match", eftersom varje väg som löser ut en satt OCR
    // returnerar true.
    let skippedUnresolvedOcr = 0
    for (const tx of candidates) {
      try {
        const ok = await this.matchTransaction(tx, organizationId)
        if (ok) matched++
        else if (tx.rawOcr) skippedUnresolvedOcr++
      } catch (err) {
        // ── FÖRVÄNTAT vs FEL ──────────────────────────────────────────────
        //
        // `matchTransaction` returnerar `false` när ingenting matchar — det är
        // ett normalt utfall och räknas som `unmatched`. Att den KASTAR är något
        // annat: bokföringen kunde inte skapa verifikatet
        // (InternalServerErrorException, se applyMatchTo*), avin försvann under
        // körningen, transaktionen timade ut (Prisma P2028, default 5 s), eller
        // databasen svarade inte.
        //
        // Förut delade de två fallen samma tysta gren. Ett driftfel såg då exakt
        // ut som "ingen match hittades" — i utfallet OCH i loggen, eftersom det
        // inte fanns någon logg. Den som körde bulkmatchningen fick "12 väntar"
        // och ingen anledning att misstänka något.
        //
        // Körningen avbryts INTE: en trasig transaktion ska inte hindra de
        // övriga från att matchas. Men den räknas separat och skrivs ut.
        failed++
        this.logger.error(
          `[reconciliation] auto-match kastade för banktransaktion ${tx.id} (org ${organizationId}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        )
      }
    }

    // Sammanfattningsrad bara när något faktiskt gick fel — annars är den brus.
    // Speglar cron-jobbens summeringsrader (`Inkasso-redo: … 0 fel`).
    if (failed > 0) {
      this.logger.error(
        `[reconciliation] auto-match för org ${organizationId}: ${matched} matchade, ` +
          `${candidates.length - matched - failed} väntar, ${failed} FEL (se raderna ovan).`,
      )
    }

    // `unmatched` är resten EFTER att felen räknats bort — den får inte längre
    // svälja dem. matched + unmatched + failed === candidates.length, alltid.
    if (skippedUnresolvedOcr > 0) {
      this.logger.warn(
        `[reconciliation] auto-match för org ${organizationId}: ${skippedUnresolvedOcr} ` +
          'transaktion(er) bar en OCR som inte löste ut och beloppsgissades därför INTE. ' +
          'De väntar på manuell granskning.',
      )
    }

    return {
      matched,
      unmatched: candidates.length - matched - failed,
      failed,
      skippedUnresolvedOcr,
    }
  }

  /**
   * VATTENFALL (H3 PR B) — en klumpbetalning fördelas över flera avier.
   *
   * ── VAD DEN ERSÄTTER, OCH VARFÖR D4 REVS ────────────────────────────────────
   *
   * En hyresgäst med tre obetalda avier à 10 000 kr som betalar 30 000 kr fick
   * INGENTING registrerat: `applyMatchToRentNotice` klassade beloppet mot ENDA
   * den äldsta avins restskuld, såg en överbetalning och returnerade false. Hela
   * matchningen avvisades och transaktionen blev UNMATCHED — hyresgästens pengar
   * fanns på kontot men inte i systemet.
   *
   * Det beteendet hette D4 och stod i #109 under "De fyra låsta besluten (hålls)".
   * **Skälet fanns aldrig nedskrivet** — varken i #105, #106, #107, i koden eller i
   * docs. Det enda närliggande argumentet gäller de MANUELLA vägarna:
   *
   *   "Att tyst acceptera mer än restskulden skulle skapa en kundkredit som
   *    systemet inte har någon modell för; att klampa beloppet skulle bokföra
   *    mindre än vad som faktiskt kommit in."
   *
   * Det motiverar inte ett vattenfall: ett vattenfall accepterar inte tyst och
   * klampar inte — det allokerar HELA beloppet över flera avier. Låset revs
   * alltså med öppna ögon, inte för att det var glömt.
   *
   * ── VARFÖR SCOPET KORSAR AVTAL ──────────────────────────────────────────────
   *
   * Hyresgästen betalar sin SKULD, inte sitt avtal. OCR:t är hyresgästens
   * betalningsidentitet (`assignOcrToTenant`), och en inbetalning med den
   * strängen är avsedd för hens förfallna skuld i åldersordning — oavsett vilket
   * avtal den uppstod under. Uppslaget har därför aldrig haft något leaseId-filter.
   *
   * Att korsa avtal är bokföringsmässigt neutralt, VERIFIERAT: betalningen bokförs
   * `1930 D / 1510 K`, och `JournalEntryLine` bär bara `accountId`, `debit`,
   * `credit` och `description` — ingen `unitId`, `leaseId` eller `propertyId`.
   * Ingen intäkt och inget objekt flyttas. (Intäkten bokfördes när avin skapades.)
   *
   * ── TRE FORMER, INGEN FJÄRDE ────────────────────────────────────────────────
   *
   *   täcker N avier exakt          → N × PAID
   *   täcker N-1 helt + del av N     → (N-1) × PAID + 1 × PARTIAL
   *   överstiger allt                → UNMATCHED, INGENTING allokeras (#482)
   *
   * Den sista är medveten och speglar de andra vägarna: `assertPaymentWithinDebt`
   * (#483) avvisar på båda manuella vägarna, enskild avi avvisar. EN regel, tre
   * vägar, samma utfall. Att låta ett svar falla ut här vore att fatta #482:s
   * beslut utan att någon märkte det.
   *
   * ── TOLERANSEN GÄLLER SUMMAN ────────────────────────────────────────────────
   *
   * Enskild avi absorberar ±1 kr. Samma regel på totalen här — annars vore
   * 30 000,50 mot tre avier avvisad medan 10 000,50 mot en avi absorberas, en ny
   * asymmetri av precis den sort vi rensat bort. De överskjutande örena läggs på
   * SISTA avin, precis som enskildvägen lägger dem på sin enda.
   *
   * ── SAME-TENANT-INVARIANTEN ─────────────────────────────────────────────────
   *
   * Kandidaterna väljs på OCR-STRÄNGEN, inte på hyresgäst. I det riktiga flödet
   * kan de inte divergera (`Tenant.ocrNumber` skrivs en gång, `RentNotice.ocrNumber`
   * bara vid create, `RentNotice.tenantId` aldrig) — men att gå från EN avi till
   * FLERA förstärker konsekvensen om antagandet någon gång bryts: en betalning
   * skulle kunna svepa över avier hos olika hyresgäster.
   *
   * Därför en hård invariant: skiljer sig `tenantId` åt STANNAR vi och allokerar
   * ingenting. Det kostar inget i normalfallet och gör skaderisken omöjlig.
   */
  private async applyWaterfallToRentNotices(
    transactionId: string,
    ocrNumber: string,
    organizationId: string,
    transactionAmount: Decimal,
    transactionDate: Date,
    userId: string | null,
  ): Promise<boolean> {
    const tolerance = new Decimal('1.00')

    return this.prisma.$transaction(async (tx) => {
      // ORDNINGEN ÄR ALLOKERINGSREGELN, inte en presentationsdetalj: den avgör
      // vilka avier som blir betalda när pengarna tar slut. Identisk med
      // enskildvägens `orderBy` — dueDate först, createdAt som tie-break — så att
      // två avier med samma förfallodag hanteras deterministiskt i stället för
      // efter databasens infall.
      const kandidater = await tx.rentNotice.findMany({
        where: {
          organizationId,
          ocrNumber,
          status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
          // DEPOSIT har sitt eget 1510/2890-flöde (#41) och ingår aldrig i
          // kravtrappan — den lämnas orörd av vattenfallet, precis som av
          // enskildvägens carve-out.
          type: RentNoticeType.RENT,
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          tenantId: true,
          noticeNumber: true,
          status: true,
          collectionStage: true,
          type: true,
          totalAmount: true,
          consumptionAmount: true,
          miscChargeAmount: true,
          reminderFeeAmount: true,
          interestAccruedAmount: true,
        },
      })
      if (kandidater.length < 2) return false

      // SAME-TENANT-INVARIANTEN. Fail-closed: stanna hellre än att sprida en
      // betalning över främmande avier.
      const tenantIds = [...new Set(kandidater.map((k) => k.tenantId))]
      if (tenantIds.length > 1) {
        throw new InternalServerErrorException(
          `Banktransaktion ${transactionId}: OCR ${ocrNumber} pekar på avier hos FLERA ` +
            `hyresgäster (${tenantIds.join(', ')}). Vattenfallet avbryts — ingen allokering ` +
            'gjord. Kontakta supporten.',
        )
      }

      // Radlås i samma ordning som allokeringen sker — samma riktning varje gång,
      // så två samtidiga vattenfall inte kan sluta cirkeln mot varandra.
      for (const k of kandidater) {
        await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${k.id} AND "organizationId" = ${organizationId} FOR UPDATE`
      }

      // Restskuld per avi, läst EFTER låset.
      const rester: Array<{
        notice: (typeof kandidater)[number]
        kvar: Decimal
        debtInput: Parameters<typeof computeRentDebt>[0]
      }> = []
      for (const k of kandidater) {
        const priorAllocs = await tx.rentNoticePayment.findMany({
          where: { rentNoticeId: k.id },
          select: { amount: true },
        })
        const debtInput = {
          type: k.type,
          totalAmount: k.totalAmount,
          consumptionAmount: k.consumptionAmount,
          miscChargeAmount: k.miscChargeAmount,
          reminderFeeAmount: k.reminderFeeAmount,
          interestAccruedAmount: k.interestAccruedAmount,
          allocations: priorAllocs.map((a) => a.amount),
        }
        const kvar = new Decimal(computeRentDebt(debtInput).ocrOutstanding)
        if (kvar.gt(0)) rester.push({ notice: k, kvar, debtInput })
      }
      if (rester.length < 2) return false

      const total = rester.reduce((s, r) => s.plus(r.kvar), new Decimal(0))

      // ÖVERBETALNING: > total + tolerans → ingenting allokeras (#482).
      if (transactionAmount.gt(total.plus(tolerance))) return false
      // Ryms beloppet i den ÄLDSTA avin ensam är detta inget vattenfall —
      // enskildvägen äger det fallet och är den hårdare prövade koden.
      if (transactionAmount.lte(rester[0]!.kvar.plus(tolerance))) return false

      // FULL mot summan (inom toleransen) → varje avi får sin restskuld, och
      // öresdifferensen absorberas på den sista.
      const täckerAllt = total.minus(transactionAmount).abs().lte(tolerance)

      let kvarAttFördela = täckerAllt ? total : transactionAmount
      let allokerade = 0

      for (const r of rester) {
        if (kvarAttFördela.lte(0)) break
        const belopp = Decimal.min(r.kvar, kvarAttFördela)
        const reglerar = belopp.gte(r.kvar)

        const allokering = await tx.rentNoticePayment.create({
          data: {
            rentNoticeId: r.notice.id,
            bankTransactionId: transactionId,
            amount: belopp,
            paidAt: transactionDate,
            source: 'BANK_RECONCILIATION',
          },
          select: { id: true },
        })

        const paidSum = computeRentDebt({
          ...r.debtInput,
          allocations: [...r.debtInput.allocations, belopp],
        }).paid

        await tx.rentNotice.updateMany({
          where: reglerar
            ? { id: r.notice.id, organizationId, status: { in: ['SENT', 'PENDING', 'OVERDUE'] } }
            : { id: r.notice.id, organizationId },
          data: reglerar
            ? {
                status: 'PAID',
                paidAt: transactionDate,
                paidAmount: paidSum,
                collectionStage: 'NONE',
              }
            : { paidAmount: paidSum },
        })

        // Verifikatet per allokering — samma idempotensnyckel som enskildvägen
        // (#326 D). Kastar bokföringen rullas HELA vattenfallet tillbaka.
        const entry = await this.accounting.createJournalEntryForRentNoticePayment(
          { id: r.notice.id, noticeNumber: r.notice.noticeNumber, type: r.notice.type },
          // Beloppet som bokförs är DENNA avis del, inte hela inbetalningen.
          { id: transactionId, date: transactionDate, amount: belopp },
          organizationId,
          userId,
          tx,
          allokering.id,
        )
        if (entry === null) {
          throw new InternalServerErrorException(
            `Betalningsverifikat kunde inte skapas för hyresavi ${r.notice.noticeNumber} — ` +
              'kontrollera att kontoplanen innehåller konto 1930 och 1510.',
          )
        }

        // M2 PR 1: EN mottagningspost per allokering — samma granularitet som
        // #489 gav reverseringen.
        await this.recordRentNoticePaymentReceived(tx, {
          rentNoticeId: r.notice.id,
          allocationId: allokering.id,
          transactionId,
          amount: belopp,
          outstandingAfter: r.kvar.minus(belopp),
          paidAt: transactionDate,
          userId,
        })

        kvarAttFördela = kvarAttFördela.minus(belopp)
        allokerade++
      }

      if (allokerade < 2) return false

      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'MATCHED',
          invoiceId: null,
          // Spegeln pekar på den ÄLDSTA avin — den som betalningen började på.
          // Avmatchningen (PR A) läser allokeringarna, inte spegeln, så den bär
          // hela kedjan även när spegeln bara kan peka på en.
          matchedRentNoticeId: rester[0]!.notice.id,
          matchedAt: new Date(),
          ...(userId ? { matchedBy: userId } : {}),
        },
      })

      this.logger.log(
        `[reconciliation] vattenfall: transaktion ${transactionId} fördelad över ${allokerade} avier ` +
          `(org ${organizationId}, OCR ${ocrNumber}).`,
      )
      return true
    })
  }

  /**
   * MOTTAGNINGSHÄNDELSEN — spegelbild av #326 C:s `PAYMENT_REVERSED`.
   *
   * ── GAPET SOM STÄNGS (upptäckt under M2) ────────────────────────────────────
   *
   * #326 speglade REVERSERINGEN till båda sidorna: B gav fakturan sin
   * `PAYMENT_REVERSED`, C gav avin sin. Men MOTTAGANDET speglades aldrig.
   * Fakturagrenen skriver `PAYMENT_RECEIVED`/`PAYMENT_PARTIAL` för varje
   * betalning; avi-grenen skrev ingenting alls. Avins historik kunde alltså visa
   * att en betalning återtogs — utan att någonsin ha visat att den togs emot.
   *
   * Mätt i dev innan ändringen: noll `PAYMENT_RECEIVED` på `RentNoticeEvent`,
   * medan `NOTE_ADDED` (kravstegs-nollställningen) fanns i 104 exemplar.
   *
   * ── PARBARHET ───────────────────────────────────────────────────────────────
   *
   * Fälten är avsiktligt desamma som reverseringens, så att någon som läser
   * spåret kan para ihop dem: samma `transactionId`, samma `amount`, samma
   * `allocationId`. Det sista är NYTT PÅ BÅDA — utan det går ett vattenfalls N
   * mottaganden inte att para mot dess N reverseringar när beloppen är lika.
   *
   * ── GRANULARITET ────────────────────────────────────────────────────────────
   *
   * EN post per ALLOKERING, inte per transaktion — samma granularitet som
   * #489 gav reverseringen. Ett vattenfall över tre avier ger tre mottaganden
   * och, vid avmatchning, tre reverseringar.
   *
   * ── INGET NYTT ENUM-VÄRDE ───────────────────────────────────────────────────
   *
   * `RentNoticeEventType` saknar `PAYMENT_PARTIAL` (fakturans enum har det).
   * Delbetalning uttrycks i stället med `PAYMENT_RECEIVED` + `outstandingAfter`
   * i payloaden: noll betyder full reglering, positivt betyder delbetalning.
   * Det är härledbart och kräver ingen migration.
   *
   * ── SPÅRET BÖRJAR MITT I HISTORIEN ──────────────────────────────────────────
   *
   * Betalningar registrerade FÖRE den här ändringen får ingen retroaktiv post.
   * Frånvaro av `PAYMENT_RECEIVED` före 2026-08-16 betyder att LOGGNINGEN inte
   * fanns — inte att betalningen uteblev. Ingen backfill görs: prod hade noll
   * allokeringar när ändringen skrevs, så det finns ingen historik att fylla i.
   */
  private async recordRentNoticePaymentReceived(
    tx: Prisma.TransactionClient,
    input: {
      rentNoticeId: string
      allocationId: string
      transactionId: string
      amount: Decimal
      outstandingAfter: Decimal
      paidAt: Date
      userId: string | null
      matchType?: 'fuzzy'
    },
  ): Promise<void> {
    await this.rentNoticeEvents.record(
      input.rentNoticeId,
      'PAYMENT_RECEIVED',
      input.userId ? 'USER' : 'SYSTEM',
      input.userId,
      {
        transactionId: input.transactionId,
        allocationId: input.allocationId,
        amount: input.amount.toNumber(),
        outstandingAfter: input.outstandingAfter.toNumber(),
        paidAt: input.paidAt.toISOString(),
        allocationSource: 'BANK_RECONCILIATION',
        source: 'bank_reconciliation',
        ...(input.matchType ? { matchType: input.matchType } : {}),
      },
      { tx },
    )
  }

  // ── Manual match ─────────────────────────────────────────────────────────────

  async manualMatch(
    transactionId: string,
    target: { invoiceId?: string; rentNoticeId?: string },
    organizationId: string,
    userId: string,
  ): Promise<void> {
    if (!target.invoiceId && !target.rentNoticeId) {
      throw new BadRequestException('Ange invoiceId eller rentNoticeId')
    }
    if (target.invoiceId && target.rentNoticeId) {
      throw new BadRequestException(
        'Ange endast en av invoiceId / rentNoticeId — en transaktion kan inte matchas mot båda',
      )
    }

    const transaction = await this.prisma.bankTransaction.findFirst({
      where: { id: transactionId, organizationId },
    })
    if (!transaction) throw new NotFoundException('Transaktion hittades inte')

    if (target.invoiceId) {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: target.invoiceId, organizationId },
      })
      if (!invoice) throw new NotFoundException('Faktura hittades inte')
      // C4: manuell matchning respekterar det FAKTISKA transaktionsbeloppet.
      // allowPartial=true — operatören har deterministiskt valt fakturan, precis
      // som i hyresavins motsvarighet.
      const matched = await this.applyMatchToInvoice(
        transactionId,
        target.invoiceId,
        organizationId,
        invoice.total,
        transaction.amount,
        transaction.date,
        userId,
        null,
        true,
      )
      if (!matched) {
        throw new BadRequestException(
          'Kunde inte matcha transaktionen mot fakturan: den är redan reglerad eller ' +
            'makulerad. Avmatcha den befintliga transaktionen först.',
        )
      }
    } else if (target.rentNoticeId) {
      const notice = await this.prisma.rentNotice.findFirst({
        where: { id: target.rentNoticeId, organizationId },
      })
      if (!notice) throw new NotFoundException('Hyresavi hittades inte')
      // PR 3b — manuell matchning respekterar det FAKTISKA transaktionsbeloppet:
      // ett delbelopp blir en delbetalning (avin förblir obetald, allokering +
      // partialverifikat registreras), inte en full PAID-bokning av hela payable.
      // allowPartial=true (operatören har deterministiskt valt avin). Belopp som
      // överstiger restskulden (överbetalning, D4) avvisas — hanteras inte i denna PR.
      const matched = await this.applyMatchToRentNotice(
        transactionId,
        target.rentNoticeId,
        organizationId,
        transaction.amount,
        transaction.date,
        userId,
        true,
      )
      if (!matched) {
        throw new BadRequestException(
          'Kunde inte matcha transaktionen mot avin: beloppet överstiger avins restskuld ' +
            '(överbetalning hanteras inte), eller så är avin redan reglerad/avbruten. ' +
            'Kontrollera beloppet eller avmatcha den befintliga transaktionen först.',
        )
      }
    }
  }

  // ── Ignore ───────────────────────────────────────────────────────────────────

  async ignoreTransaction(transactionId: string, organizationId: string): Promise<void> {
    const transaction = await this.prisma.bankTransaction.findFirst({
      where: { id: transactionId, organizationId },
    })
    if (!transaction) throw new NotFoundException('Transaktion hittades inte')

    await this.prisma.bankTransaction.update({
      where: { id: transactionId },
      data: { status: 'IGNORED' },
    })
  }

  // ── Unmatch ───────────────────────────────────────────────────────────────────

  async unmatchTransaction(
    transactionId: string,
    organizationId: string,
    userId: string | null = null,
    // ── #326 C: SKÄLET ÄR RÄKENSKAPSINFORMATION ─────────────────────────────
    //
    // AI-verktyget `unmatch_transaction` KRÄVER redan ett `reason` av
    // användaren — och kastade bort det: strängen ekades tillbaka i chatt-svaret
    // och skrevs aldrig någonstans. Att fråga efter ett skäl, få det, och sedan
    // slänga det är sämre än att inte fråga: användaren tror att det är
    // dokumenterat.
    //
    // Skälet är just det motverifikatet INTE kan bära. En reversering av
    // debet/kredit ser likadan ut oavsett om betalningen var felallokerad,
    // återbetald eller registrerad på fel avi — och det är skillnaden en
    // granskare behöver (BFL 5 kap 11 §).
    //
    // Valfritt: HTTP-vägen har inget skäl-fält idag (eget ärende). Saknas det
    // skrivs händelsen ändå — utan påhittad text.
    reason?: string,
  ): Promise<void> {
    const transaction = await this.prisma.bankTransaction.findFirst({
      where: { id: transactionId, organizationId },
      include: { invoice: true, matchedRentNotice: true },
    })
    if (!transaction) throw new NotFoundException('Transaktion hittades inte')
    if (transaction.status !== 'MATCHED') {
      throw new ForbiddenException('Transaktionen är inte matchad')
    }

    // PAID är terminal i state machine — kan inte återställas via en vanlig
    // statusövergång. För att häva en bokförd betalning måste användaren
    // skapa en kreditnota (samma flöde som Fortnox/Visma).
    if (transaction.invoice && transaction.invoice.status === 'PAID') {
      throw new BadRequestException(
        'Fakturan är markerad som betald och kan inte avmatchas. Skapa en kreditnota för att häva betalningen.',
      )
    }

    // ── #326 A: EN ÖVERLÄMNAD FORDRAN AVMATCHAS INTE ────────────────────────
    //
    // VARFÖR SPÄRR OCH INTE STÄDNING. Metoden raderar `rentNoticePayment` men
    // ALDRIG `invoicePayment`, och rör aldrig `Invoice.status`. Avmatchas en
    // delbetald faktura reverseras alltså verifikatet medan allokeringen ligger
    // kvar: huvudboken visar hela fordran på 1510, `computeInvoiceDebt` visar
    // total − allokering. De två divergerar, och det är den lägre siffran
    // inkassoexportens skuldgrind och kravbelopp läser (#318).
    //
    // Det är #307 A spegelvänt. Där visade inkassoytorna ursprungsbeloppet i
    // stället för restskulden; här skulle inkassobolaget sitta kvar med ett krav
    // byggt på en restskuld som just växt tillbaka — och gäldenären krävas på
    // för lite. Att kräva för lite av fel skäl är inte en mildare variant av att
    // kräva för mycket: fordran är densamma, kravunderlaget är fel, och ingen
    // upptäcker det eftersom båda siffrorna ser rimliga ut var för sig.
    //
    // PAID-spärren ovan är samma resonemang en status längre fram, och den här
    // grinden lånar dess form med flit: en tydlig, tidig neka framför ett
    // halvvägs städat tillstånd.
    //
    // MEN INTE DESS STATUSKOD. PAID-spärren kastar 400; den här kastar 409.
    // Begäran är välformad — det är resursens NUVARANDE tillstånd som hindrar
    // den, vilket är definitionen av en konflikt. #297 (deposits.service.ts)
    // etablerade 409 för exakt den här klassen efter granskning, och det är rätt
    // referenspunkt att spegla, inte den äldre 400:an intill. Att harmonisera
    // PAID-spärren är ett eget ärende — den ändras inte här.
    //
    // ATT NEKA STÄNGER INGEN FUNGERANDE VÄG. Den enda operation spärren tar bort
    // är den som lämnar systemet i det divergerade tillståndet. Ingen intern
    // anropare finns (bara HTTP-routen och AI-verktyget `unmatch_transaction`,
    // som båda går genom just den här metoden), och ingen kravtrappa eller cron
    // avmatchar.
    //
    // MEDDELANDET LOVAR INGEN VÄG SOM INTE FINNS. `INVOICE_TRANSITIONS` ger
    // SENT_TO_COLLECTION exakt två utgångar — PAID och VOID — och VOID spärras
    // av allokeringsgrinden (invoices.service.ts) så snart en `InvoicePayment`
    // finns, vilket den per definition gör här. Det finns alltså ingen
    // återkallningsväg i produkten att hänvisa till, och då är rätt svar att
    // säga det. (VOID-grindens egen text säger "avmatcha/återbetala" och pekar
    // på just den här metoden — den blir en rundgång så länge allokeringen inte
    // städas. Den texten hör till B och rörs inte här.)
    //
    // AVGRÄNSNING — SPÄRREN ÄR INTE FIXEN. Divergensen finns kvar för
    // PARTIAL och för alla andra statusar; den stängs av #326 B (radera
    // allokeringen + återställ status), som kräver en ny kant i statusmaskinen
    // och därför är ett eget beslut. Den här spärren är slutläge tills
    // produktbeslutet om en rättelseväg för överlämnade fordringar är fattat.
    // Avi-vägen (RentNotice) har egna hål och rörs inte — de hör till B/C.
    //
    // MEDDELANDET PÅSTÅR INGET OM VAD INKASSOBOLAGET FAKTISKT MOTTAGIT.
    // `claimForExport` sätter statusen FÖRE uppladdningen, och
    // `markSentToCollection` används när överlämningen skett i ett externt
    // system utan underlag i vår lagring (`collectionExportKey` är då null).
    // Att skriva "inkassobolaget har fått ett kravunderlag" vore alltså ett
    // påstående om en extern händelse vi inte kan verifiera. (FAR-granskning.)
    if (transaction.invoice && transaction.invoice.status === 'SENT_TO_COLLECTION') {
      throw new ConflictException(
        collectionUnmatchBlockedMessage(transaction.invoice.invoiceNumber),
      )
    }

    const matchedNoticeId = transaction.matchedRentNotice?.id ?? null

    // BFL 5 kap 5 §/9 §: statusåterställningen och motverifikatet måste ske
    // ATOMISKT. Tidigare kördes reverseJournalEntryForPayment som
    // fire-and-forget EFTER att statusen flippats — om reverseringen fallerade
    // (saknad kontoplan, DB-glapp) lämnades systemet inkonsistent: avi=SENT
    // (obetald) men bokföring=PAID (verifikatet kvar). Nästa BgMax/PDF-import
    // kunde då matcha avin igen och DUBBELBOKA intäkten. Nu körs allt i en
    // transaktion — fallerar motverifikatet rullas hela unmatchen tillbaka
    // (avin förblir PAID, banktransaktionen MATCHED) och operatören får felet.
    // (Issue #33; samma awaited-mönster som faktura-bokföringen i PR #27 H3.)
    // #326 D — nyckeln till det betalningsverifikat som ska reverseras. Sätts
    // inne i transaktionen av den gren (faktura eller avi) som faktiskt hittar
    // en allokering; lämnas tom för poster skrivna före D, som då hittas via
    // reverseringens legacy-fallback på transaktions-id.
    // En lista, inte ett värde: ett vattenfall ger flera allokeringar och därmed
    // flera verifikat att reversera. Fakturagrenen fyller den med exakt ett
    // element (dess bankTransactionId är fortsatt @unique).
    let reversalSourceIds: string[] = []

    await this.prisma.$transaction(async (tx) => {
      // ── #326 A: OMPRÖVNINGEN INNANFÖR RADLÅSET ÄR DEN LASTBÄRANDE ─────────
      //
      // Förkontrollen ovan läser statusen OLÅST, utanför transaktionen. Den är
      // en snabb väg till ett tydligt fel — inte en garanti. `claimForExport`
      // (collection-export.service.ts) tar medvetet INGET radlås utan claimar
      // med en status-guardad `updateMany`, så en pågående inkassoexport kan
      // committa PARTIAL → SENT_TO_COLLECTION i fönstret mellan vår läsning och
      // vår skrivning. Utan den här omprövningen skulle avmatchningen då rulla
      // vidare på en inaktuell status och lämna exakt den divergens spärren
      // finns för — på en faktura som FAKTISKT är överlämnad.
      //
      // Samma resonemang som #307 C:s radlås i `applyMatchToInvoice`: statusen
      // ett beslut fattas på måste läsas under det lås som skrivningen håller,
      // annars uttalar sig grinden om ett tillstånd som redan passerat.
      //
      // LÅSORDNING OFÖRÄNDRAD: Invoice → BankTransaction → Deposit. Invoice tas
      // som FÖRSTA sats i transaktionen, före `bankTransaction.updateMany` längre
      // ned. `claimForExport` och `markSentToCollection` rör aldrig
      // BankTransaction, och Invoice/RentNotice är ömsesidigt uteslutande (XOR)
      // på en banktransaktion — ingen väg tar den motsatta ordningen. Ingen ABBA.
      //
      // PAID-SPÄRREN RÖRS INTE. Den har samma teoretiska fönster (en samtidig
      // betalning kan flippa till PAID), men att stänga det ändrar beteendet på
      // en befintlig grind och är ett eget ärende — inte något den här spärren
      // ska smyga in.
      if (transaction.invoice) {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${transaction.invoice.id} AND "organizationId" = ${organizationId} FOR UPDATE`
        const current = await tx.invoice.findFirst({
          where: { id: transaction.invoice.id, organizationId },
          select: { status: true, invoiceNumber: true },
        })
        if (current?.status === 'SENT_TO_COLLECTION') {
          throw new ConflictException(collectionUnmatchBlockedMessage(current.invoiceNumber))
        }

        // ── #326 B: ALLOKERINGEN FÖLJER HUVUDBOKEN ─────────────────────────
        //
        // Fram till nu raderade den här metoden `rentNoticePayment` men ALDRIG
        // `invoicePayment`. En avmatchad delbetalning reverserade alltså
        // verifikatet medan allokeringen låg kvar: 1510 visade hela fordran,
        // `computeInvoiceDebt` visade total − allokering. Den LÄGRE siffran är
        // den inkassoexportens skuldgrind och kravbelopp läser (#318) — en
        // gäldenär kunde krävas på för lite utan att någon såg det.
        //
        // FAR:s beslut (#326-förgranskningen): HUVUDBOKEN ÄR FACIT. Avmatchning
        // påstår inte att pengarna lämnat banken — den upphäver kopplingen till
        // just den här fordran. Banktransaktionen består som UNMATCHED och kan
        // matchas rätt. Allokeringen ska därför följa det reverserade verifikatet.
        //
        // RADERING ÄR TILLÅTEN, MEN BARA MED SPÅR. `InvoicePayment` är
        // sidoordnad bokföring (BFL 5 kap 4 §), inte verifikationen (5 kap 6 §) —
        // den får korrigeras. Men delete UTAN spår bryter 5 kap 11 §
        // (behandlingshistorik): då försvinner till och med att en allokering
        // funnits. Därför skrivs `PAYMENT_REVERSED` i SAMMA transaktion nedan.
        // `JournalEntry`/`-Line` rörs aldrig — de motverifikeras, aldrig raderas.
        //
        // Allokeringen läses FÖRE raderingen: beloppet och betalningsdatumet ska
        // in i händelseloggen, och finns inte kvar efteråt. `bankTransactionId`
        // är @unique → 0 eller 1 rad.
        //
        // 0 RADER ÄR INGET FEL, OCH INGEN TYST LUCKA. En fakturamatchad
        // banktransaktion utan allokering kan bara komma från fuzzy-grenen
        // (`matchTransaction`, som flippar PAID utan att allokera) — och en PAID
        // faktura spärras redan av PAID-grinden ovan. Finns ingen allokering
        // finns heller ingenting att rätta: ingen radering, ingen
        // statusåterställning, ingen händelse. Att statusåterställa på en
        // allokering vi ALDRIG tog bort vore att rätta något annat än det
        // anropet avser. (Fuzzy-grenens saknade allokering är ett eget ärende.)
        const removedAllocation = await tx.invoicePayment.findFirst({
          where: { bankTransactionId: transactionId },
          select: { id: true, invoiceId: true, amount: true, paidAt: true, source: true },
        })
        // #326 D — verifikatet är nycklat på allokeringen; reverseringen måste
        // få samma nyckel eller den hittar ingenting och blir en tyst no-op.
        if (removedAllocation) {
          reversalSourceIds = [bankPaymentSourceId('invoice', removedAllocation.id)]
        }

        if (removedAllocation) {
          // `current` är null bara om fakturan inte finns i den här
          // organisationen — invarianten som håller `BankTransaction.invoiceId`
          // org-intern är applikationsnivå, inte DB-nivå. PR A:s grind ovan
          // lämnar det fallet orört (den frågar bara efter SENT_TO_COLLECTION),
          // men rättelsen KAN inte köras utan att veta statusen. Fail-closed
          // hellre än att rätta i blindo.
          if (!current) {
            throw new InternalServerErrorException(
              `Fakturan för transaktion ${transactionId} kunde inte läsas i organisationen. ` +
                'Avmatchningen avbryts — kontakta supporten.',
            )
          }
          if (removedAllocation.invoiceId !== transaction.invoice.id) {
            // FAIL-CLOSED. Allokeringen och banktransaktionen ska per
            // konstruktion peka på samma faktura (`applyMatchToInvoice` skriver
            // båda i en transaktion). Gör de inte det är det datadrift, och då
            // ska vi varken röra en ANNAN fakturas allokering eller tyst låta
            // divergensen stå kvar — vi ska stanna och säga till.
            //
            // DEFENSE-IN-DEPTH, INTE EN FULLSTÄNDIG TOCTOU-STÄNGNING.
            // `transaction.invoice.id` kommer från den OLÅSTA läsningen ovan;
            // bara statusen omprövas under låset (PR A). Jämförelsen fångar
            // alltså drift mellan de två läsningarna, men `invoice.id` i sig
            // omprövas aldrig. Fönstret är smalt — det kräver att
            // `BankTransaction.invoiceId` byter värde mellan läsningen och
            // transaktionen, och `manualMatch` skriver bara det fältet via
            // `applyMatchToInvoice`. Samma accepterade nivå som PR A. (FAR-granskning.)
            throw new InternalServerErrorException(
              `Betalningsallokeringen för transaktion ${transactionId} pekar på en annan ` +
                'faktura än banktransaktionen. Avmatchningen avbryts — kontakta supporten.',
            )
          }

          await tx.invoicePayment.deleteMany({ where: { bankTransactionId: transactionId } })

          // Σ KVARVARANDE allokeringar — läses EFTER raderingen, av samma skäl
          // som avi-vägen gör det: en av flera delbetalningar kan tas bort och
          // beslutet ska avse det som faktiskt är kvar.
          const remaining = await tx.invoicePayment.findMany({
            where: { invoiceId: transaction.invoice.id },
            select: { amount: true },
          })

          // Utgångsstatusen GISSAS INTE — den läses ur append-only-loggen.
          // `PAYMENT_PARTIAL` bär `previousStatus` sedan #307 C, som infördes
          // just för att en händelselogg som säger fel är värre än ingen.
          const partialEvents = await tx.invoiceEvent.findMany({
            where: { invoiceId: transaction.invoice.id, type: 'PAYMENT_PARTIAL' },
            select: { payload: true },
            orderBy: { createdAt: 'desc' },
          })

          const decision = paymentReversalTargetStatus({
            current: current.status,
            hasRemainingAllocations: remaining.length > 0,
            statusBeforePartial: statusBeforePartialPayment(partialEvents),
          })

          // FAIL-CLOSED: PARTIAL utan kvarvarande allokeringar MÅSTE kunna
          // återställas. Kan utgångsstatusen inte läsas ur loggen skriver vi
          // hellre ingenting alls än en påhittad status (BFL 5 kap 11 §).
          if (
            current.status === 'PARTIAL' &&
            remaining.length === 0 &&
            decision.action !== 'restore'
          ) {
            throw new InternalServerErrorException(
              `Faktura ${current.invoiceNumber} kan inte återställas: utgångsstatusen före ` +
                'delbetalningen saknas i händelseloggen. Avmatchningen avbryts — kontakta ' +
                'supporten.',
            )
          }

          if (decision.action === 'restore') {
            // NAMNGIVEN RÄTTELSEVÄG, INTE `transitionStatus`. Se
            // invoice-payment-reversal.ts: `INVOICE_TRANSITIONS` beskriver
            // affärshändelser, och en avmatchning är en rättelse av ett misstag.
            // WHERE nyckas på statusen vi läste under låset.
            await tx.invoice.updateMany({
              where: { id: transaction.invoice.id, organizationId, status: 'PARTIAL' },
              data: { status: decision.target, paidAt: null },
            })
          }

          // BFL 5 kap 11 § — behandlingshistoriken. Posten bär BELOPP och
          // TRANSAKTION i payload; AKTÖR (actorId/actorType/actorLabel) och
          // TIDPUNKT (createdAt) är `InvoiceEvent`s egna kolumner och skrivs av
          // `record()`. Samma transaktion som raderingen: den får varken skrivas
          // utan att raderingen skedde eller utebli efter den.
          await this.events.record(
            transaction.invoice.id,
            'PAYMENT_REVERSED',
            userId ? 'USER' : 'SYSTEM',
            userId,
            {
              transactionId,
              amount: removedAllocation.amount.toNumber(),
              paidAt: removedAllocation.paidAt.toISOString(),
              allocationSource: removedAllocation.source,
              previousStatus: current.status,
              newStatus: decision.action === 'restore' ? decision.target : current.status,
              statusRestored: decision.action === 'restore',
              ...(decision.action === 'keep' ? { statusKeptReason: decision.reason } : {}),
              remainingAllocations: remaining.length,
              source: 'bank_reconciliation_unmatch',
              // #326 C — operatörens/AI:ns skäl. TILLKOMMER bara när det finns;
              // #326 B:s post är i övrigt oförändrad i typ, tidpunkt, villkor
              // och samtliga befintliga fält.
              ...(reason ? { reason } : {}),
            },
            { tx },
          )
        }
      }

      // Bankavstämnings-härdning PR 1/3b — ta bort allokeringen som hörde till denna
      // bank-transaktion FÖRST, i SAMMA atomiska transaktion. bankTransactionId är
      // unikt → 0 eller 1 rad. Raderas före paidAmount-omräkningen nedan så Σ avser
      // KVARVARANDE allokeringar (kritiskt vid partiell unmatch: bara EN av flera
      // delbetalningar tas bort — paidAmount får inte spegla den borttagna).
      // #326 D — läs FÖRE raderingen: allokeringens id är verifikatets
      // idempotensnyckel, och raden finns inte kvar efteråt.
      // #326 C — belopp, betalningsdatum och källa läses här av samma skäl som
      // id:t: raden finns inte kvar när händelsen ska skrivas.
      // N-MEDVETEN (H3, PR A). Var `findFirst` — `bankTransactionId` var @unique,
      // så det kunde bara finnas 0 eller 1. Vattenfallet (PR B) låter EN
      // banktransaktion allokeras över FLERA avier, och då måste avmatchningen ta
      // med sig ALLA: `deleteMany` nedan raderade redan alla, medan bara den
      // första reverserades. Med N > 1 hade det lämnat N−1 verifikat i huvudboken
      // vars allokeringar var borta — 1510 krediterad för betalningar som inte
      // längre finns.
      //
      // Ordningen är stabil (allokeringens id) så att reverseringarna sker
      // deterministiskt och loggen går att läsa i efterhand.
      const removedNoticeAllocations = await tx.rentNoticePayment.findMany({
        where: { bankTransactionId: transactionId },
        select: { id: true, rentNoticeId: true, amount: true, paidAt: true, source: true },
        orderBy: { id: 'asc' },
      })
      if (removedNoticeAllocations.length > 0) {
        // FAIL-CLOSED PÅ XOR-INVARIANTEN. En banktransaktion är antingen
        // faktura- eller avi-matchad, aldrig båda — men det är app-lagrets
        // disciplin, inte en DB-constraint. Hittas allokeringar i BÅDA
        // tabellerna skulle den här raden tyst skriva över fakturagrenens
        // nyckel, och fakturans verifikat aldrig reverseras: allokeringen
        // raderad, statusen återställd, huvudboken orörd. Exakt den divergens
        // #326 B stängde, i motsatt riktning.
        //
        // Speglar faktura-grenens egen drift-kontroll några rader upp
        // (`removedAllocation.invoiceId !== transaction.invoice.id`) — samma
        // princip: stanna hellre än att rätta i blindo. (Säkerhetsgranskning
        // av #326 D.)
        if (reversalSourceIds.length > 0) {
          throw new InternalServerErrorException(
            `Banktransaktion ${transactionId} har betalningsallokeringar i BÅDA tabellerna ` +
              '(faktura och hyresavi). Avmatchningen avbryts — kontakta supporten.',
          )
        }
        reversalSourceIds = removedNoticeAllocations.map((a) =>
          bankPaymentSourceId('rent-notice', a.id),
        )
      }

      await tx.rentNoticePayment.deleteMany({
        where: { bankTransactionId: transactionId },
      })

      // PR 3b — för en matchad hyresavi: räkna om paidAmount = Σ KVARVARANDE
      // allokeringar och flippa avin tillbaka till obetald BARA om den åter har
      // OCR-skuld (en delbetalning kvar → avin förblir delbetald SENT med rätt cache;
      // en avmatchad slutbetalning → tillbaka till SENT). outstanding() läser ändå
      // allokeringarna direkt, men paidAmount-cachen får inte ljuga (stale).
      // N-MEDVETEN: räkna om VARJE avi som en borttagen allokering rörde, inte bara
      // banktransaktionens spegelfält. Med ett vattenfall pekar spegeln på EN avi
      // medan pengarna låg på flera — att bara räkna om spegelns hade lämnat de
      // övriga med en paidAmount som ljuger och en PAID-status utan täckning.
      //
      // Unionen med `matchedNoticeId` bevarar det gamla beteendet för en
      // transaktion vars allokering redan hunnit raderas (spegeln kvar, rad borta).
      const berördaAvier = [
        ...new Set([
          ...removedNoticeAllocations.map((a) => a.rentNoticeId),
          ...(matchedNoticeId ? [matchedNoticeId] : []),
        ]),
      ]
      for (const avaktuellId of berördaAvier) {
        const remainingAllocs = await tx.rentNoticePayment.findMany({
          where: { rentNoticeId: avaktuellId },
          select: { amount: true },
        })
        const paidSum = remainingAllocs.reduce<Decimal>((s, a) => s.plus(a.amount), new Decimal(0))

        const noticeRow = await tx.rentNotice.findFirst({
          where: { id: avaktuellId, organizationId },
          select: {
            type: true,
            status: true,
            totalAmount: true,
            consumptionAmount: true,
            miscChargeAmount: true,
            reminderFeeAmount: true,
            interestAccruedAmount: true,
          },
        })
        if (noticeRow) {
          const ocrLeft = computeRentDebt({
            type: noticeRow.type,
            totalAmount: noticeRow.totalAmount,
            consumptionAmount: noticeRow.consumptionAmount,
            miscChargeAmount: noticeRow.miscChargeAmount,
            reminderFeeAmount: noticeRow.reminderFeeAmount,
            interestAccruedAmount: noticeRow.interestAccruedAmount,
            allocations: remainingAllocs.map((a) => a.amount),
          }).ocrOutstanding

          // En PAID avi som efter avmatchningen åter har OCR-skuld flippas tillbaka
          // till SENT (det finns ingen kreditnota-mekanism för avier). Kravsteget
          // lämnas MEDVETET på NONE (juristnotering: re-eskalering kräver en NY
          // inkasso-ready-granskning, INV-B, som kristalliserar om dröjsmålsräntan
          // per faktisk löptid, RL 9 §). En redan obetald (delbetald) avi rör vi inte
          // statusen på — bara paidAmount-spegeln.
          const reopen = noticeRow.status === 'PAID' && ocrLeft > 0
          // organizationId i WHERE som defense-in-depth (FIX 2-mönstret).
          await tx.rentNotice.updateMany({
            where: { id: avaktuellId, organizationId },
            data: {
              paidAmount: paidSum.gt(0) ? paidSum : null,
              ...(reopen ? { status: 'SENT', paidAt: null } : {}),
            },
          })
        }
      }

      // ── #326 C: BEHANDLINGSHISTORIKEN (BFL 5 kap 11 §) ────────────────────
      //
      // Avmatchningen raderade `RentNoticePayment` utan att lämna något spår.
      // Motverifikatet räcker inte: en vänd debet/kredit ser likadan ut oavsett
      // om betalningen var felallokerad, återbetald eller registrerad på fel
      // avi — och `logger.log` är inte räkenskapsinformation (loggen roterar
      // bort och går inte att söka i produkten).
      //
      // Allokeringstabellerna är sidoordnad bokföring (BFL 5 kap 4 §) och FÅR
      // korrigeras. Men delete UTAN spår raderar även det faktum att en
      // allokering funnits — och det är kombinationen som bryter 5 kap 11 §.
      // Fakturasidan fick sin post i #326 B; den här är dess spegling, med
      // SAMMA fyra fält: BELOPP och TRANSAKTION i payload, AKTÖR och TIDPUNKT
      // i händelsens egna kolumner.
      //
      // SAMMA TRANSAKTION som raderingen — posten får varken skrivas utan att
      // raderingen skedde eller utebli efter den.
      // EN POST PER BORTTAGEN ALLOKERING. Med ett vattenfall raderas flera, och
      // varje raderad allokering är sin egen behandlingshändelse — en samlad post
      // hade dolt vilka avier som faktiskt rördes och med vilka belopp.
      for (const allok of removedNoticeAllocations) {
        // FAIL-CLOSED PÅ SPEGELN. `matchedRentNoticeId` på banktransaktionen är
        // ett härlett fält; allokeringen bär sitt eget `rentNoticeId`. Går de isär
        // skulle spåret hamna på EN avi medan paidAmount/status räknas om på en
        // ANNAN — en tyst inkonsekvens mellan logg och tillstånd.
        //
        // N-MEDVETEN: med flera allokeringar kan spegeln omöjligt peka på alla.
        // Kontrollen gäller därför bara när det finns EXAKT en — då är den
        // oförändrad. Med flera kräver vi i stället att spegeln finns BLAND de
        // berörda avierna, vilket fångar samma drift utan att fälla det
        // legitima N > 1-fallet.
        const speglenÄrEnAvDem =
          !matchedNoticeId ||
          removedNoticeAllocations.some((a) => a.rentNoticeId === matchedNoticeId)
        if (!speglenÄrEnAvDem) {
          throw new InternalServerErrorException(
            `Betalningsallokeringen för transaktion ${transactionId} pekar på en annan hyresavi ` +
              'än banktransaktionens spegelfält. Avmatchningen avbryts — kontakta supporten.',
          )
        }

        // NYCKLAS PÅ ALLOKERINGENS EGET `rentNoticeId`: spåret ska följa raden
        // som faktiskt togs bort, inte spegeln.
        await this.rentNoticeEvents.record(
          allok.rentNoticeId,
          'PAYMENT_REVERSED',
          userId ? 'USER' : 'SYSTEM',
          userId,
          {
            transactionId,
            // M2 PR 1: NYTT — utan allokeringens id går ett vattenfalls N
            // reverseringar inte att para mot dess N mottaganden när beloppen
            // är lika. Additivt: äldre poster saknar fältet.
            allocationId: allok.id,
            amount: allok.amount.toNumber(),
            paidAt: allok.paidAt.toISOString(),
            allocationSource: allok.source,
            source: 'bank_reconciliation_unmatch',
            ...(reason ? { reason } : {}),
          },
          { tx },
        )
      }

      // Övriga statusar lämnas oförändrade — vi länkar bara bort
      // banktransaktionen. updateMany med organizationId som defense-in-depth:
      // även om transactionId från en annan org skulle läcka in (via bug i
      // auth-laget) påverkar vi bara denna orgs data.
      await tx.bankTransaction.updateMany({
        where: { id: transactionId, organizationId },
        data: {
          status: 'UNMATCHED',
          invoiceId: null,
          matchedRentNoticeId: null,
          matchedAt: null,
          matchedBy: null,
        },
      })

      // Motverifikatet inom samma transaktion. reverseJournalEntryForPayment
      // slår sedan #326 D på ALLOKERINGENS nyckel (`reversalSourceId` ovan) med
      // transaktions-id som legacy-fallback för poster skrivna före D — samma
      // strategi för Invoice- och RentNotice-betalningar. Reverseringen är
      // idempotent (sourceId `reversal:<sourceId>`) — en retry efter ett
      // tidigare lyckat anrop dubbelbokför aldrig.
      // ETT MOTVERIFIKAT PER ALLOKERING. `reverseJournalEntryForPayment` slår på
      // allokeringens nyckel (#326 D), så N allokeringar kräver N reverseringar —
      // annars står N−1 verifikat kvar i huvudboken utan sin allokering.
      //
      // Är listan tom (inget att reversera, eller en post skriven före #326 D)
      // anropas den ändå EN gång utan nyckel, så legacy-fallbacken på
      // transaktions-id bevaras oförändrad.
      if (reversalSourceIds.length === 0) {
        await this.accounting.reverseJournalEntryForPayment(
          transactionId,
          organizationId,
          userId,
          tx,
          undefined,
        )
      } else {
        for (const sourceId of reversalSourceIds) {
          await this.accounting.reverseJournalEntryForPayment(
            transactionId,
            organizationId,
            userId,
            tx,
            sourceId,
          )
        }
      }
    })

    this.logger.log(
      `[BFL] Avmatchade banktransaktion ${transactionId} (org ${organizationId}) — ` +
        `status återställd och motverifikat bokfört atomiskt.`,
    )
  }
}
