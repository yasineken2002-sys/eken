import { Injectable, NotFoundException } from '@nestjs/common'
import type { BankTransaction, Invoice, InvoiceLine } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

interface JournalFilters {
  from?: string
  to?: string
  source?: string
}

// Default BAS accounts for Swedish property management
const DEFAULT_ACCOUNTS = [
  { number: 1510, name: 'Kundfordringar', type: 'ASSET' as const },
  { number: 1930, name: 'Företagskonto', type: 'ASSET' as const },
  { number: 2610, name: 'Utgående moms 25%', type: 'LIABILITY' as const },
  { number: 2612, name: 'Utgående moms 12%', type: 'LIABILITY' as const },
  { number: 2614, name: 'Utgående moms 6%', type: 'LIABILITY' as const },
  { number: 3010, name: 'Hyresintäkter', type: 'REVENUE' as const },
  { number: 3011, name: 'Serviceintäkter', type: 'REVENUE' as const },
  { number: 3012, name: 'Depositionsintäkter', type: 'REVENUE' as const },
]

// Map VAT rate to account number
const VAT_TO_ACCOUNT: Record<number, number> = {
  25: 2610,
  12: 2612,
  6: 2614,
}

@Injectable()
export class AccountingService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccounts(organizationId: string) {
    return this.prisma.account.findMany({
      where: { organizationId },
      orderBy: { number: 'asc' },
    })
  }

  async getJournalEntries(organizationId: string, filters?: JournalFilters) {
    return this.prisma.journalEntry.findMany({
      where: {
        organizationId,
        ...(filters?.from || filters?.to
          ? {
              date: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(filters?.source
          ? { source: filters.source as 'MANUAL' | 'INVOICE' | 'PAYMENT' | 'LEASE' }
          : {}),
      },
      include: {
        lines: {
          include: { account: true },
        },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })
  }

  async getJournalEntry(id: string, organizationId: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, organizationId },
      include: {
        lines: {
          include: { account: true },
        },
      },
    })
    if (!entry) throw new NotFoundException('Verifikation hittades inte')
    return entry
  }

  async seedDefaultAccounts(organizationId: string): Promise<void> {
    const existing = await this.prisma.account.count({ where: { organizationId } })
    if (existing > 0) return

    await this.prisma.account.createMany({
      data: DEFAULT_ACCOUNTS.map((a) => ({ ...a, organizationId })),
    })
  }

  async exportSie4(organizationId: string, from: string, to: string): Promise<Buffer> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, orgNumber: true },
    })

    const entries = await this.getJournalEntries(organizationId, { from, to })

    const fromCompact = from.replace(/-/g, '')
    const toCompact = to.replace(/-/g, '')

    const lines: string[] = [
      '#FLAGGA 0',
      '#FORMAT PC8',
      '#SIETYP 4',
      `#ORGNR ${org?.orgNumber ?? organizationId}`,
      `#FNAMN "${org?.name ?? 'Okänd organisation'}"`,
      `#RAR 0 ${fromCompact} ${toCompact}`,
      '',
    ]

    entries.forEach((entry, idx) => {
      const dateStr = entry.date.toISOString().slice(0, 10).replace(/-/g, '')
      lines.push(`#VER "AI" ${idx + 1} ${dateStr} "${entry.description}"`)
      lines.push('{')
      for (const l of entry.lines) {
        const amount = l.debit != null ? Number(l.debit) : -Number(l.credit ?? 0)
        lines.push(`  #TRANS ${l.account.number} {} ${amount.toFixed(2)}`)
      }
      lines.push('}')
      lines.push('')
    })

    return Buffer.from(lines.join('\n'), 'utf8')
  }

  async createJournalEntryForInvoice(
    invoice: Invoice & { lines: InvoiceLine[] },
    organizationId: string,
    createdById: string,
  ) {
    // Skip if journal entry already exists for this invoice
    const existing = await this.prisma.journalEntry.findFirst({
      where: { organizationId, sourceId: invoice.id },
    })
    if (existing) return existing

    // Look up account numbers
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const receivableId = accountByNumber.get(1510)
    const revenueId = accountByNumber.get(3010)

    // Skip if required accounts don't exist
    if (!receivableId || !revenueId) return null

    const subtotal = Number(invoice.subtotal)
    const vatTotal = Number(invoice.vatTotal)
    const total = Number(invoice.total)

    // Build journal lines
    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [
      // Debit receivables for full amount
      { accountId: receivableId, debit: total, description: `Faktura ${invoice.invoiceNumber}` },
      // Credit revenue for subtotal
      { accountId: revenueId, credit: subtotal, description: 'Hyresintäkt' },
    ]

    // Credit VAT accounts if applicable
    if (vatTotal > 0) {
      // Group VAT by rate
      const vatByRate = new Map<number, number>()
      for (const line of invoice.lines) {
        const vat = Number(line.quantity) * Number(line.unitPrice) * (line.vatRate / 100)
        vatByRate.set(line.vatRate, (vatByRate.get(line.vatRate) ?? 0) + vat)
      }

      for (const [rate, amount] of vatByRate) {
        const vatAccountNumber = VAT_TO_ACCOUNT[rate] ?? 2610
        const vatAccountId = accountByNumber.get(vatAccountNumber)
        if (vatAccountId && amount > 0) {
          lines.push({
            accountId: vatAccountId,
            credit: amount,
            description: `Moms ${rate}%`,
          })
        }
      }
    }

    return this.prisma.journalEntry.create({
      data: {
        organizationId,
        date: invoice.issueDate,
        description: `Faktura ${invoice.invoiceNumber}`,
        source: 'INVOICE',
        sourceId: invoice.id,
        createdById,
        lines: {
          create: lines.map((l) => ({
            accountId: l.accountId,
            ...(l.debit != null ? { debit: l.debit } : {}),
            ...(l.credit != null ? { credit: l.credit } : {}),
            ...(l.description ? { description: l.description } : {}),
          })),
        },
      },
      include: { lines: { include: { account: true } } },
    })
  }

  // BAS-bokning vid bankbetalning: 1930 (Företagskonto) Debet → 1510 (Kundfordringar) Kredit.
  // Idempotent — sourceId = bankTransaction.id, så samma transaktion kan inte
  // bokas två gånger även om matchen ångras och görs om.
  async createJournalEntryForPayment(
    invoice: Pick<Invoice, 'id' | 'invoiceNumber' | 'total'>,
    transaction: Pick<BankTransaction, 'id' | 'date' | 'amount'>,
    organizationId: string,
    createdById: string | null,
  ) {
    const existing = await this.prisma.journalEntry.findFirst({
      where: { organizationId, source: 'PAYMENT', sourceId: transaction.id },
    })
    if (existing) return existing

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))

    const bankAccountId = accountByNumber.get(1930)
    const receivableId = accountByNumber.get(1510)

    if (!bankAccountId || !receivableId) return null

    const amount = Number(transaction.amount)
    if (amount <= 0) return null

    return this.prisma.journalEntry.create({
      data: {
        organizationId,
        date: transaction.date,
        description: `Inbetalning faktura ${invoice.invoiceNumber}`,
        source: 'PAYMENT',
        sourceId: transaction.id,
        ...(createdById ? { createdById } : {}),
        lines: {
          create: [
            { accountId: bankAccountId, debit: amount, description: 'Inbetalning bank' },
            { accountId: receivableId, credit: amount, description: 'Reglering kundfordran' },
          ],
        },
      },
      include: { lines: { include: { account: true } } },
    })
  }

  // Reverse av betalningsverifikat: skapar ett motverifikat (debet/kredit byter
  // plats) — append-only, vi raderar aldrig en tidigare bokad post.
  async reverseJournalEntryForPayment(
    transactionId: string,
    organizationId: string,
    createdById: string | null,
  ): Promise<void> {
    const original = await this.prisma.journalEntry.findFirst({
      where: { organizationId, source: 'PAYMENT', sourceId: transactionId },
      include: { lines: true },
    })
    if (!original) return

    // Skapa inte dubbletter av reversal heller.
    const alreadyReversed = await this.prisma.journalEntry.findFirst({
      where: {
        organizationId,
        source: 'PAYMENT',
        sourceId: `reversal:${transactionId}`,
      },
    })
    if (alreadyReversed) return

    await this.prisma.journalEntry.create({
      data: {
        organizationId,
        date: new Date(),
        description: `Hävd matchning: ${original.description}`,
        source: 'PAYMENT',
        sourceId: `reversal:${transactionId}`,
        ...(createdById ? { createdById } : {}),
        lines: {
          create: original.lines.map((l) => ({
            accountId: l.accountId,
            // Byt debet/kredit
            ...(l.debit != null ? { credit: Number(l.debit) } : {}),
            ...(l.credit != null ? { debit: Number(l.credit) } : {}),
            ...(l.description ? { description: `Reversal: ${l.description}` } : {}),
          })),
        },
      },
    })
  }
}
