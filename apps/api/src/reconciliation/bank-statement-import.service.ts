import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import {
  PdfStatementParserService,
  type ParsedBankStatement,
  type ParsedTransaction,
} from './pdf-statement-parser.service'
import { ReconciliationService } from './reconciliation.service'
import {
  validateUploadedFile,
  DETECTED_PDF_TYPES,
  MAX_PDF_BYTES,
} from '../common/utils/file-validation'

export interface ImportCommitResult {
  importId: string
  created: number
  duplicates: number
  autoMatched: number
  unmatched: number
}

@Injectable()
export class BankStatementImportService {
  private readonly logger = new Logger(BankStatementImportService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: PdfStatementParserService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  // ── Steg 1: ladda upp PDF, parse, spara som DRAFT (PARSED) ────────────
  async uploadAndParsePdf(
    fileBuffer: Buffer,
    fileName: string,
    organizationId: string,
    userId: string | null,
  ): Promise<{ id: string; status: string; parsed: ParsedBankStatement }> {
    // SECURITY (H3): verifiera att filen faktiskt är en PDF (magiska byten
    // %PDF) och inte överskrider taket innan vi skickar den till Claude som
    // document-block. Den klient-deklarerade filändelsen räcker inte.
    validateUploadedFile(fileBuffer, {
      allowedDetectedMimes: DETECTED_PDF_TYPES,
      maxBytes: MAX_PDF_BYTES,
    })

    const fileSize = fileBuffer.length

    // Skapa raden FÖRST (status=PARSING) så vi har en audit-trail även om
    // AI-tolkningen kraschar mid-flight. Vid fel uppdaterar vi till FAILED.
    const draft = await this.prisma.bankStatementImport.create({
      data: {
        organizationId,
        fileName,
        fileType: 'pdf',
        fileSize,
        status: 'PARSING',
        ...(userId ? { uploadedById: userId } : {}),
      },
    })

    let parsed: ParsedBankStatement
    try {
      parsed = await this.parser.parse(fileBuffer, organizationId, userId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.prisma.bankStatementImport.update({
        where: { id: draft.id },
        data: { status: 'FAILED', errorMessage: message },
      })
      throw err
    }

    const updated = await this.prisma.bankStatementImport.update({
      where: { id: draft.id },
      data: {
        status: 'PARSED',
        bank: parsed.bank,
        accountNumber: parsed.accountNumber,
        ...(parsed.periodStart ? { periodStart: new Date(parsed.periodStart) } : {}),
        ...(parsed.periodEnd ? { periodEnd: new Date(parsed.periodEnd) } : {}),
        parsedData: { transactions: parsed.transactions } as unknown as Prisma.InputJsonValue,
        transactionCount: parsed.transactions.length,
      },
    })

    return { id: updated.id, status: updated.status, parsed }
  }

  // ── Hämta DRAFT (för granskningsvyn) ────────────────────────────────────
  async getImport(id: string, organizationId: string) {
    const row = await this.prisma.bankStatementImport.findFirst({
      where: { id, organizationId },
    })
    if (!row) throw new NotFoundException('Importen hittades inte')
    return row
  }

  // ── Steg 2: användaren bekräftar → commit BankTransaction-rader ──────
  // Tar emot eventuellt redigerad lista av transaktioner från klienten.
  // Vi ersätter parsedData med den slutgiltiga listan så audit-trailen
  // speglar vad som faktiskt skrevs.
  async confirmImport(
    id: string,
    organizationId: string,
    userId: string | null,
    edited?: unknown[],
  ): Promise<ImportCommitResult> {
    const draft = await this.prisma.bankStatementImport.findFirst({
      where: { id, organizationId },
    })
    if (!draft) throw new NotFoundException('Importen hittades inte')
    if (draft.status === 'CONFIRMED') {
      throw new BadRequestException('Importen är redan bekräftad och kan inte bekräftas igen.')
    }
    if (draft.status !== 'PARSED') {
      throw new BadRequestException(
        `Importen är i status ${draft.status} och kan inte bekräftas — bara PARSED-importer.`,
      )
    }

    const finalTx: ParsedTransaction[] = Array.isArray(edited)
      ? this.sanitizeEdited(edited)
      : this.extractFromDraft(draft.parsedData)

    // Endast inbetalningar (positiva belopp) ska skapa BankTransactions —
    // samma som CSV/BgMax-flödena. Uttag/avgifter visas i preview men
    // commitas inte (de matchas inte mot fakturor/avier).
    const incoming = finalTx.filter((t) => t.amount > 0)

    let created = 0
    let duplicates = 0
    let autoMatched = 0
    let unmatched = 0

    for (const t of incoming) {
      const amountDecimal = new Decimal(t.amount.toFixed(2))
      const date = new Date(t.date)

      // Dubblett-skydd identiskt med CSV-importen (org, date, description, amount).
      const existing = await this.prisma.bankTransaction.findFirst({
        where: {
          organizationId,
          date,
          description: t.description,
          amount: amountDecimal,
        },
      })
      if (existing) {
        duplicates++
        continue
      }

      const tx = await this.prisma.bankTransaction.create({
        data: {
          organizationId,
          date,
          description: t.description,
          amount: amountDecimal,
          ...(t.ocr ? { rawOcr: t.ocr, reference: t.ocr } : {}),
        },
      })
      created++

      try {
        const matched = await this.reconciliation.matchTransaction(tx, organizationId)
        if (matched) autoMatched++
        else unmatched++
      } catch (err) {
        // Matchning kan kasta vid kantfall (t.ex. korrupt journal-state).
        // Vi backar inte — transaktionen ligger kvar som UNMATCHED och
        // operatören får hantera manuellt.
        this.logger.error(
          `matchTransaction failed för tx=${tx.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
        unmatched++
      }
    }

    await this.prisma.bankStatementImport.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        ...(userId ? { confirmedById: userId } : {}),
        parsedData: { transactions: finalTx } as unknown as Prisma.InputJsonValue,
        transactionCount: finalTx.length,
        matchedCount: autoMatched,
        unmatchedCount: unmatched + duplicates,
      },
    })

    return { importId: id, created, duplicates, autoMatched, unmatched }
  }

  async cancelImport(id: string, organizationId: string): Promise<void> {
    const draft = await this.prisma.bankStatementImport.findFirst({
      where: { id, organizationId },
    })
    if (!draft) throw new NotFoundException('Importen hittades inte')
    if (draft.status === 'CONFIRMED') {
      throw new ForbiddenException('En bekräftad import kan inte avbrytas.')
    }
    await this.prisma.bankStatementImport.update({
      where: { id },
      data: { status: 'CANCELLED' },
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  private extractFromDraft(parsedData: Prisma.JsonValue | null): ParsedTransaction[] {
    if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) return []
    const obj = parsedData as Record<string, unknown>
    if (!Array.isArray(obj.transactions)) return []
    return this.sanitizeEdited(obj.transactions as unknown[])
  }

  private sanitizeEdited(edited: unknown[]): ParsedTransaction[] {
    const out: ParsedTransaction[] = []
    for (const raw of edited) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const date = typeof r.date === 'string' ? r.date.trim() : ''
      const description = typeof r.description === 'string' ? r.description.trim() : ''
      const amountRaw = r.amount
      const amount = typeof amountRaw === 'number' ? amountRaw : parseFloat(String(amountRaw))
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      if (!Number.isFinite(amount)) continue
      const ocrVal = r.ocr
      const ocr = typeof ocrVal === 'string' && ocrVal.trim().length > 0 ? ocrVal.trim() : null
      const isIncoming = typeof r.isIncoming === 'boolean' ? r.isIncoming : amount > 0
      out.push({ date, description, ocr, amount, isIncoming })
    }
    return out
  }
}
