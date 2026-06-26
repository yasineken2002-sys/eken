import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma, RentNoticeType } from '@prisma/client'
import type { BankTransaction } from '@prisma/client'
import * as XLSX from 'xlsx'
import { PrismaService } from '../common/prisma/prisma.service'
import { InvoicesService } from '../invoices/invoices.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { AccountingService } from '../accounting/accounting.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { computeRentDebt } from '../avisering/rent-debt.service'
import {
  validateUploadedFile,
  DETECTED_SPREADSHEET_TYPES,
  MAX_CSV_BYTES,
} from '../common/utils/file-validation'

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
  unmatched: number
}

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

        // Duplicate check
        const existing = await this.prisma.bankTransaction.findFirst({
          where: {
            organizationId,
            date: row.date,
            description: row.description,
            amount: amountDecimal,
          },
        })
        if (existing) {
          result.duplicates++
          continue
        }

        // Extract OCR from reference or description
        const rawOcr = extractOcr(row.reference) ?? extractOcr(row.description)

        const tx = await this.prisma.bankTransaction.create({
          data: {
            organizationId,
            date: row.date,
            description: row.description,
            amount: amountDecimal,
            ...(row.balance !== undefined ? { balance: new Decimal(row.balance.toFixed(2)) } : {}),
            ...(row.reference ? { reference: row.reference } : {}),
            ...(rawOcr ? { rawOcr } : {}),
          },
        })
        result.imported++

        // Auto-match
        const matched = await this.matchTransaction(tx, organizationId)
        if (matched) {
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

        const existing = await this.prisma.bankTransaction.findFirst({
          where: {
            organizationId,
            date: txDate,
            amount: amountDecimal,
            ...(ocr ? { rawOcr: ocr } : {}),
          },
        })
        if (existing) {
          result.duplicates++
          continue
        }

        const tx = await this.prisma.bankTransaction.create({
          data: {
            organizationId,
            date: txDate,
            description,
            amount: amountDecimal,
            ...(ocr ? { rawOcr: ocr } : {}),
          },
        })
        result.imported++

        const matched = await this.matchTransaction(tx, organizationId)
        if (matched) result.autoMatched++
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
        await this.applyMatchToInvoice(
          transaction.id,
          invoice.id,
          invoice.total,
          transaction.date,
          null,
          null,
          db,
        )
        return true
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
        await this.applyMatchToInvoice(
          transaction.id,
          invoice.id,
          invoice.total,
          transaction.date,
          null,
          null,
          db,
        )
        return true
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
      // Optimistic claim: en parallell bank-import kan annars också matcha
      // samma faktura. Status-guardad updateMany serialiserar på rad-nivå
      // i Postgres — bara en körning får count=1.
      const claim = await db.invoice.updateMany({
        where: { id: candidate.id, status: { in: ['SENT', 'OVERDUE'] } },
        data: { status: 'PAID', paidAt: transaction.date },
      })
      if (claim.count === 0) return false

      await db.bankTransaction.update({
        where: { id: transaction.id },
        data: { status: 'MATCHED', invoiceId: candidate.id, matchedAt: new Date() },
      })

      await this.events.record(candidate.id, 'PAYMENT_RECEIVED', 'SYSTEM', null, {
        transactionId: transaction.id,
        amount: candidate.total.toNumber(),
        date: transaction.date.toISOString(),
        source: 'bank_reconciliation',
        previousStatus: candidate.status,
        newStatus: 'PAID',
        matchType: 'fuzzy',
      })

      try {
        await this.accounting.createJournalEntryForPayment(
          { id: candidate.id, invoiceNumber: candidate.invoiceNumber, total: candidate.total },
          { id: transaction.id, date: transaction.date, amount: candidate.total },
          organizationId,
          null,
        )
      } catch (err) {
        this.logger.error(
          'Accounting journal entry failed',
          err instanceof Error ? err.stack : String(err),
        )
      }
      return true
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
      )
    }

    return false
  }

  private async applyMatchToInvoice(
    transactionId: string,
    invoiceId: string,
    invoiceTotal: Decimal,
    transactionDate: Date,
    userId: string | null,
    actorLabel: string | null,
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, invoiceNumber: true, organizationId: true },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    // Kör statusövergången via state machine. transitionStatus validerar
    // SENT/OVERDUE/PARTIAL → PAID, skriver PAYMENT_RECEIVED-event och
    // triggar INVOICE_PAID-notifikationen — alla "vid PAID"-bieffekter
    // hålls på ett enda ställe.
    await this.invoices.transitionStatus(
      invoiceId,
      invoice.organizationId,
      'PAID',
      userId,
      userId ? 'USER' : 'SYSTEM',
      {
        transactionId,
        amount: invoiceTotal.toNumber(),
        date: transactionDate.toISOString(),
        source: 'bank_reconciliation',
        ...(actorLabel ? { actorLabel } : {}),
      },
    )

    // transitionStatus sätter paidAt = new Date(); skriv över med faktiskt
    // bankbetalningsdatum så att bokföring och historik matchar bankutdraget.
    await db.invoice.update({
      where: { id: invoiceId },
      data: { paidAt: transactionDate },
    })

    // Länka banktransaktionen till fakturan. matchedRentNoticeId nollställs
    // explicit för att respektera XOR-constraint vid eventuell re-match.
    await db.bankTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'MATCHED',
        invoiceId,
        matchedRentNoticeId: null,
        matchedAt: new Date(),
        ...(userId ? { matchedBy: userId } : {}),
      },
    })

    // Skapa bokföringspost — fire-and-forget. En saknad kontoplan får aldrig
    // blockera matchningen.
    try {
      await this.accounting.createJournalEntryForPayment(
        { id: invoiceId, invoiceNumber: invoice.invoiceNumber, total: invoiceTotal },
        { id: transactionId, date: transactionDate, amount: invoiceTotal },
        invoice.organizationId,
        userId,
      )
    } catch (err) {
      this.logger.error(
        'Accounting journal entry failed',
        err instanceof Error ? err.stack : String(err),
      )
    }
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
  ): Promise<boolean> {
    const tolerance = new Decimal('1.00')

    return this.prisma.$transaction(async (tx) => {
      // Rad-lås FÖRST: serialiserar samtidiga delbetalningar på samma avi.
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
      await tx.rentNoticePayment.create({
        data: {
          rentNoticeId: noticeId,
          bankTransactionId: transactionId,
          amount: allocationAmount,
          paidAt: transactionDate,
          source: 'BANK_RECONCILIATION',
        },
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
        await tx.rentNoticeEvent.create({
          data: {
            rentNoticeId: noticeId,
            type: 'NOTE_ADDED',
            actorType: userId ? 'USER' : 'SYSTEM',
            ...(userId ? { actorId: userId } : { actorLabel: 'System' }),
            payload: {
              action: 'collection-stage-reset',
              from: notice.collectionStage,
              reason: 'paid',
              source: 'bank_reconciliation',
            },
          },
        })
      }

      // Partialverifikatet ATOMISKT i samma tx. amount = det FAKTISKT allokerade
      // delbeloppet (1930 D / 1510 K). Faller bokföringen kastas felet → full rollback.
      const entry = await this.accounting.createJournalEntryForRentNoticePayment(
        { id: noticeId, noticeNumber: notice.noticeNumber },
        { id: transactionId, date: transactionDate, amount: allocationAmount },
        organizationId,
        userId,
        tx,
      )
      // null för en RENT-avi = saknat 1930/1510 → bokföringsfel (ej giltigt no-op).
      // Kasta så hela transaktionen rullas tillbaka — ingen allokering utan verifikat.
      if (entry === null && notice.type !== RentNoticeType.DEPOSIT) {
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
  ) {
    const where: Prisma.BankTransactionWhereInput = { organizationId }

    if (filters?.status) {
      where.status = filters.status as 'UNMATCHED' | 'MATCHED' | 'IGNORED'
    }
    if (filters?.from ?? filters?.to) {
      where.date = {}
      if (filters?.from) where.date.gte = new Date(filters.from)
      if (filters?.to) where.date.lte = new Date(filters.to)
    }

    return this.prisma.bankTransaction.findMany({
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
    for (const tx of candidates) {
      try {
        const ok = await this.matchTransaction(tx, organizationId)
        if (ok) matched++
      } catch {
        // Hoppa över transaktioner som inte kan matchas — fortsätt med resten.
      }
    }

    return { matched, unmatched: candidates.length - matched }
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
      await this.applyMatchToInvoice(
        transactionId,
        target.invoiceId,
        invoice.total,
        transaction.date,
        userId,
        null,
        this.prisma,
      )
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
    await this.prisma.$transaction(async (tx) => {
      // Bankavstämnings-härdning PR 1/3b — ta bort allokeringen som hörde till denna
      // bank-transaktion FÖRST, i SAMMA atomiska transaktion. bankTransactionId är
      // unikt → 0 eller 1 rad. Raderas före paidAmount-omräkningen nedan så Σ avser
      // KVARVARANDE allokeringar (kritiskt vid partiell unmatch: bara EN av flera
      // delbetalningar tas bort — paidAmount får inte spegla den borttagna).
      await tx.rentNoticePayment.deleteMany({
        where: { bankTransactionId: transactionId },
      })

      // PR 3b — för en matchad hyresavi: räkna om paidAmount = Σ KVARVARANDE
      // allokeringar och flippa avin tillbaka till obetald BARA om den åter har
      // OCR-skuld (en delbetalning kvar → avin förblir delbetald SENT med rätt cache;
      // en avmatchad slutbetalning → tillbaka till SENT). outstanding() läser ändå
      // allokeringarna direkt, men paidAmount-cachen får inte ljuga (stale).
      if (matchedNoticeId) {
        const remainingAllocs = await tx.rentNoticePayment.findMany({
          where: { rentNoticeId: matchedNoticeId },
          select: { amount: true },
        })
        const paidSum = remainingAllocs.reduce<Decimal>((s, a) => s.plus(a.amount), new Decimal(0))

        const noticeRow = await tx.rentNotice.findFirst({
          where: { id: matchedNoticeId, organizationId },
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
            where: { id: matchedNoticeId, organizationId },
            data: {
              paidAmount: paidSum.gt(0) ? paidSum : null,
              ...(reopen ? { status: 'SENT', paidAt: null } : {}),
            },
          })
        }
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
      // slår på sourceId=transaction.id (samma strategi för Invoice- och
      // RentNotice-betalningar) och är idempotent (sourceId reversal:<id>) — en
      // retry efter ett tidigare lyckat anrop dubbelbokför aldrig.
      await this.accounting.reverseJournalEntryForPayment(transactionId, organizationId, userId, tx)
    })

    this.logger.log(
      `[BFL] Avmatchade banktransaktion ${transactionId} (org ${organizationId}) — ` +
        `status återställd och motverifikat bokfört atomiskt.`,
    )
  }
}
