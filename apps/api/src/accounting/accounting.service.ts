import { Injectable, NotFoundException } from '@nestjs/common'
import { CompanyForm } from '@prisma/client'
import type { BankTransaction, Invoice, InvoiceLine } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { basChartFor } from './bas-chart'

interface JournalFilters {
  from?: string
  to?: string
  source?: string
}

// Map VAT rate to account number. 0% (momsbefriad) ska INTE bokföras som
// momskredit alls — då hoppas raden över i createJournalEntryForInvoice.
const VAT_TO_ACCOUNT: Record<number, number> = {
  25: 2611,
  12: 2621,
  6: 2631,
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

  /**
   * Seeda BAS-kontoplan för en organisation. Hoppar över om kontona
   * redan är seedade — idempotent och säker att kalla flera gånger.
   *
   * Eget kapital-serien väljs baserat på companyForm:
   *   • AB             → 2080-serien (aktiekapital, reservfond, fritt kapital)
   *   • ENSKILD_FIRMA  → 2010-serien (eget kapital, egna uttag/insättningar)
   *   • HB / KB        → 2010-serien per delägare
   *   • FORENING       → 2065-serien
   *   • STIFTELSE      → 2070-serien
   *
   * Anropas både från AuthService.register() (vid org-skapande) och
   * från POST /v1/accounting/accounts/seed (manuell trigger för
   * importerade orgs som saknar kontoplan).
   */
  async seedDefaultAccounts(organizationId: string, companyForm?: CompanyForm): Promise<void> {
    const existing = await this.prisma.account.count({ where: { organizationId } })
    if (existing > 0) return

    let form: CompanyForm
    if (companyForm) {
      form = companyForm
    } else {
      // Fallback: läs upp från Organization-raden om anroparen inte
      // skickat med formen explicit. Default till AB om kolumnen är null.
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { companyForm: true },
      })
      form = org?.companyForm ?? CompanyForm.AB
    }

    const accounts = basChartFor(form)
    await this.prisma.account.createMany({
      data: accounts.map((a) => ({ ...a, organizationId })),
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

    // SIE4-format enligt SIE Gruppen specifikation 4B.
    // Källa: https://sie.se/wp-content/uploads/2020/05/SIE_filformat_ver_4B_080930.pdf
    const generatedAt = new Date()
    const genDate =
      generatedAt.getFullYear().toString() +
      String(generatedAt.getMonth() + 1).padStart(2, '0') +
      String(generatedAt.getDate()).padStart(2, '0')
    const lines: string[] = [
      '#FLAGGA 0',
      '#PROGRAM "Eveno" "1.0"',
      '#FORMAT PC8',
      `#GEN ${genDate}`,
      '#SIETYP 4',
      `#ORGNR ${org?.orgNumber ?? organizationId}`,
      `#FNAMN "${(org?.name ?? 'Okänd organisation').replace(/"/g, '')}"`,
      `#RAR 0 ${fromCompact} ${toCompact}`,
      '',
    ]

    // Kontoplan – krävs för att bokslutsprogram ska kunna mappa.
    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      orderBy: { number: 'asc' },
    })
    for (const acc of accounts) {
      lines.push(`#KONTO ${acc.number} "${acc.name.replace(/"/g, '')}"`)
    }
    lines.push('')

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
        // 0% är momsbefriat — bokförs inte mot momskonto.
        if (rate === 0 || amount <= 0) continue
        const vatAccountNumber = VAT_TO_ACCOUNT[rate]
        if (!vatAccountNumber) continue
        const vatAccountId = accountByNumber.get(vatAccountNumber)
        if (vatAccountId) {
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

  // BAS för registrering av deposition: 1510 D (kundfordran) / 2490 K (skuld
  // för mottagen deposition). Posten skrivs en gång per deposit (idempotent).
  async createJournalEntryForDepositInvoice(
    depositId: string,
    organizationId: string,
    amount: number,
    invoiceNumber: string,
    issueDate: Date,
    createdById: string | null,
  ) {
    const sourceId = `deposit-invoice:${depositId}`
    const existing = await this.prisma.journalEntry.findFirst({
      where: { organizationId, sourceId },
    })
    if (existing) return existing

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = accountByNumber.get(1510)
    const liabilityId = accountByNumber.get(2490)
    if (!receivableId || !liabilityId) return null

    return this.prisma.journalEntry.create({
      data: {
        organizationId,
        date: issueDate,
        description: `Deposition ${invoiceNumber}`,
        source: 'INVOICE',
        sourceId,
        ...(createdById ? { createdById } : {}),
        lines: {
          create: [
            { accountId: receivableId, debit: amount, description: 'Depositionsfordran' },
            { accountId: liabilityId, credit: amount, description: 'Mottagen deposition' },
          ],
        },
      },
    })
  }

  // BAS för återbetalning av deposition: 2490 D (skulden minskar)
  // / 1930 K (bank) för återbetald del. Eventuella avdrag krediteras 3040
  // (skadeersättningar) istället, så bokföringen alltid balanserar.
  async createJournalEntryForDepositRefund(
    depositId: string,
    organizationId: string,
    refundAmount: number,
    deductionsTotal: number,
    transactionDate: Date,
    createdById: string | null,
  ) {
    const sourceId = `deposit-refund:${depositId}`
    const existing = await this.prisma.journalEntry.findFirst({
      where: { organizationId, sourceId },
    })
    if (existing) return existing

    const total = refundAmount + deductionsTotal
    if (total <= 0) return null

    const accounts = await this.prisma.account.findMany({
      where: { organizationId },
      select: { id: true, number: true },
    })
    const accountByNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const liabilityId = accountByNumber.get(2490)
    const bankId = accountByNumber.get(1930)
    const damageRevenueId = accountByNumber.get(3040)
    if (!liabilityId || !bankId) return null

    const lines: Array<{
      accountId: string
      debit?: number
      credit?: number
      description: string
    }> = [{ accountId: liabilityId, debit: total, description: 'Återförd depositionsskuld' }]
    if (refundAmount > 0) {
      lines.push({ accountId: bankId, credit: refundAmount, description: 'Återbetalning bank' })
    }
    if (deductionsTotal > 0 && damageRevenueId) {
      lines.push({
        accountId: damageRevenueId,
        credit: deductionsTotal,
        description: 'Avdrag (skador)',
      })
    } else if (deductionsTotal > 0) {
      // Saknas 3040 — boka resten på 1510 (fordran) som fallback så att
      // bokföringen balanserar. Användaren får manuellt rätta efteråt.
      const receivableId = accountByNumber.get(1510)
      if (!receivableId) return null
      lines.push({
        accountId: receivableId,
        debit: 0,
        credit: deductionsTotal,
        description: 'Avdrag (manuell justering krävs — saknar konto 3040)',
      })
    }

    return this.prisma.journalEntry.create({
      data: {
        organizationId,
        date: transactionDate,
        description: `Återbetalning deposition`,
        source: 'PAYMENT',
        sourceId,
        ...(createdById ? { createdById } : {}),
        lines: { create: lines },
      },
    })
  }
}
