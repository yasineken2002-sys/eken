import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import type { BankTransaction, Prisma } from '@prisma/client'
import * as XLSX from 'xlsx'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { InvoiceEventsService } from '../invoices/invoice-events.service'

export interface ImportResult {
  imported: number
  duplicates: number
  autoMatched: number
  unmatched: number
  errors: string[]
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

const DATE_KEYS = /^(datum|date|bokföringsdag|transaktionsdag)$/i
const DESC_KEYS = /^(text|description|meddelande|specifikation|beskrivning)$/i
const AMOUNT_KEYS = /^(belopp|amount|transaktionsbelopp|kredit|debit)$/i
const BALANCE_KEYS = /^(saldo|balance)$/i
const REF_KEYS = /^(referens|reference|ocr|ref)$/i

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InvoiceEventsService,
  ) {}

  // ── Parse CSV ───────────────────────────────────────────────────────────────

  private parseCsv(buffer: Buffer): ParsedRow[] {
    const text = buffer.toString('utf-8')
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length < 2) return []

    // Detect delimiter
    const firstLine = lines[0] ?? ''
    const delimiter = firstLine.includes(';') ? ';' : ','
    const headers = firstLine.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''))
    const cols = detectColumns(headers)

    const rows: ParsedRow[] = []
    for (let i = 1; i < lines.length; i++) {
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
    return rows
  }

  // ── Parse XLSX ──────────────────────────────────────────────────────────────

  private parseXlsx(buffer: Buffer): ParsedRow[] {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return []
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) return []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jsonRows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, {
      raw: false,
      defval: '',
    })
    if (jsonRows.length === 0) return []

    // Detect column keys from first row keys
    const headers = Object.keys(jsonRows[0] ?? {})
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
    return rows
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  async importBankStatement(
    fileBuffer: Buffer,
    filename: string,
    organizationId: string,
  ): Promise<ImportResult> {
    const ext = filename.toLowerCase().split('.').pop() ?? ''
    let rows: ParsedRow[]

    if (ext === 'csv') {
      rows = this.parseCsv(fileBuffer)
    } else if (ext === 'xlsx' || ext === 'xls') {
      rows = this.parseXlsx(fileBuffer)
    } else {
      throw new BadRequestException('Endast CSV och Excel-filer (.csv, .xlsx, .xls) stöds')
    }

    const result: ImportResult = {
      imported: 0,
      duplicates: 0,
      autoMatched: 0,
      unmatched: 0,
      errors: [],
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

    return result
  }

  // ── Match ───────────────────────────────────────────────────────────────────

  async matchTransaction(
    transaction: BankTransaction,
    organizationId: string,
    prismaClient?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!transaction.rawOcr) return false

    const db = prismaClient ?? this.prisma
    const tolerance = new Decimal('1.00')

    // Exact OCR match
    const invoice = await db.invoice.findFirst({
      where: {
        organizationId,
        reference: transaction.rawOcr,
        status: { in: ['SENT', 'OVERDUE', 'PARTIAL'] },
      },
    })

    if (invoice) {
      const diff = invoice.total.minus(transaction.amount).abs()
      if (diff.lte(tolerance)) {
        await this.applyMatch(
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

    // Fuzzy fallback: amount match within tolerance, no OCR required but status/date range
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
    const dateFrom = new Date(transaction.date.getTime() - ninetyDaysMs)
    const dateTo = new Date(transaction.date.getTime() + ninetyDaysMs)

    const candidates = await db.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['SENT', 'OVERDUE'] },
        dueDate: { gte: dateFrom, lte: dateTo },
      },
    })

    const matching = candidates.filter((inv) =>
      inv.total.minus(transaction.amount).abs().lte(tolerance),
    )
    if (matching.length === 1 && matching[0]) {
      await this.applyMatch(
        transaction.id,
        matching[0].id,
        matching[0].total,
        transaction.date,
        null,
        null,
        db,
      )
      return true
    }

    return false
  }

  private async applyMatch(
    transactionId: string,
    invoiceId: string,
    invoiceTotal: Decimal,
    transactionDate: Date,
    userId: string | null,
    actorLabel: string | null,
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    await (db as PrismaService).$transaction(async (tx) => {
      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'MATCHED',
          invoiceId,
          matchedAt: new Date(),
          ...(userId ? { matchedBy: userId } : {}),
        },
      })

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'PAID', paidAt: transactionDate },
      })

      await this.events.record(
        invoiceId,
        'PAYMENT_RECEIVED',
        userId ? 'USER' : 'SYSTEM',
        userId,
        {
          transactionId,
          amount: invoiceTotal.toNumber(),
          date: transactionDate.toISOString(),
          source: 'bank_reconciliation',
          ...(actorLabel ? { actorLabel } : {}),
        },
        { tx },
      )
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

  // ── Manual match ─────────────────────────────────────────────────────────────

  async manualMatch(
    transactionId: string,
    invoiceId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const transaction = await this.prisma.bankTransaction.findFirst({
      where: { id: transactionId, organizationId },
    })
    if (!transaction) throw new NotFoundException('Transaktion hittades inte')

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    await this.applyMatch(
      transactionId,
      invoiceId,
      invoice.total,
      transaction.date,
      userId,
      null,
      this.prisma,
    )
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

  async unmatchTransaction(transactionId: string, organizationId: string): Promise<void> {
    const transaction = await this.prisma.bankTransaction.findFirst({
      where: { id: transactionId, organizationId },
      include: { invoice: true },
    })
    if (!transaction) throw new NotFoundException('Transaktion hittades inte')
    if (transaction.status !== 'MATCHED') {
      throw new ForbiddenException('Transaktionen är inte matchad')
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'UNMATCHED',
          invoiceId: null,
          matchedAt: null,
          matchedBy: null,
        },
      })

      // Revert invoice to SENT if it was paid by this transaction
      if (transaction.invoice && transaction.invoice.status === 'PAID') {
        await tx.invoice.update({
          where: { id: transaction.invoice.id },
          data: { status: 'SENT', paidAt: null },
        })
      }
    })
  }
}
