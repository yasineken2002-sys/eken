import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Req,
  BadRequestException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { ReconciliationService, type BankFormat } from './reconciliation.service'
import { BankStatementImportService } from './bank-statement-import.service'
import { ManualMatchDto } from './dto/manual-match.dto'
import { ConfirmImportDto } from './dto/confirm-import.dto'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import type { JwtPayload } from '@eken/shared'
import { Body } from '@nestjs/common'
import { MAX_PDF_BYTES } from '../common/utils/file-validation'

const VALID_BANKS: ReadonlyArray<BankFormat> = ['GENERIC', 'HANDELSBANKEN', 'SEB', 'SWEDBANK']

@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly statementImports: BankStatementImportService,
  ) {}

  /**
   * POST /reconciliation/import
   * Multipart form upload, field: "statement"
   * Accepts: .csv, .xlsx, .xls (max 10MB)
   */
  @Post('import')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async importStatement(
    @OrgId() organizationId: string,
    @Req() req: FastifyRequest,
    @Query('bank') bank?: string,
  ) {
    const file = await (
      req as unknown as {
        file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | null>
      }
    ).file()
    if (!file) throw new BadRequestException('Ingen fil bifogad')

    const filename = file.filename ?? 'upload.csv'
    const ext = filename.toLowerCase().split('.').pop() ?? ''
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      throw new BadRequestException('Endast CSV och Excel-filer (.csv, .xlsx, .xls) stöds')
    }

    let bankOverride: BankFormat | undefined
    if (bank) {
      const upper = bank.toUpperCase()
      if (!VALID_BANKS.includes(upper as BankFormat)) {
        throw new BadRequestException(`Ogiltig bank. Tillåtna värden: ${VALID_BANKS.join(', ')}`)
      }
      bankOverride = upper as BankFormat
    }

    const buffer = await file.toBuffer()
    return this.reconciliationService.importBankStatement(
      buffer,
      filename,
      organizationId,
      bankOverride,
    )
  }

  /**
   * POST /reconciliation/import-bgmax
   * Multipart form upload, field: "statement"
   * Accepts: .txt (BgMax-format från Bankgirot)
   *
   * Skiljs från /import eftersom BgMax har en helt annan layout (80-tecken-
   * fastformat) än CSV/XLSX. Att försöka detektera per innehåll är skört —
   * en explicit endpoint per format är tydligare för både UI och AI-tools.
   */
  @Post('import-bgmax')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async importBgMax(@OrgId() organizationId: string, @Req() req: FastifyRequest) {
    const file = await (
      req as unknown as {
        file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | null>
      }
    ).file()
    if (!file) throw new BadRequestException('Ingen fil bifogad')

    const filename = file.filename ?? 'bgmax.txt'
    const ext = filename.toLowerCase().split('.').pop() ?? ''
    if (!['txt', 'bgmax'].includes(ext)) {
      throw new BadRequestException(
        'BgMax-import kräver en .txt-fil från Bankgirot. För Excel/CSV använd /reconciliation/import.',
      )
    }

    const buffer = await file.toBuffer()
    return this.reconciliationService.importBgMaxFile(buffer, filename, organizationId)
  }

  /**
   * POST /reconciliation/import-pdf
   * Multipart form upload, field: "statement"
   * Accepterar: .pdf (max 10 MB).
   *
   * AI-driven tolkning: PDF:en skickas direkt till Claude som document-block
   * (ingen separat pdf-parse). Resultatet sparas som BankStatementImport-rad
   * i status PARSED och returneras till klienten för granskning. INGA
   * BankTransaction-rader skapas i detta steg — användaren måste bekräfta
   * via /imports/:id/confirm.
   */
  @Post('import-pdf')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async importPdf(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
  ) {
    const file = await (
      req as unknown as {
        file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | null>
      }
    ).file()
    if (!file) throw new BadRequestException('Ingen fil bifogad')

    const filename = file.filename ?? 'statement.pdf'
    const ext = filename.toLowerCase().split('.').pop() ?? ''
    if (ext !== 'pdf') {
      throw new BadRequestException(
        'AI-tolkning kräver en .pdf-fil. För CSV/Excel använd /reconciliation/import, för BgMax /reconciliation/import-bgmax.',
      )
    }

    const buffer = await file.toBuffer()
    if (buffer.length > MAX_PDF_BYTES) {
      throw new BadRequestException(
        `PDF:en är för stor (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max 20 MB.`,
      )
    }

    return this.statementImports.uploadAndParsePdf(buffer, filename, organizationId, user.sub)
  }

  /**
   * GET /reconciliation/imports/:id
   * Hämtar en DRAFT (PARSED) för granskning.
   */
  @Get('imports/:id')
  async getImport(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.statementImports.getImport(id, organizationId)
  }

  /**
   * POST /reconciliation/imports/:id/confirm
   * Body: { transactions?: ParsedTransaction[] }
   * Användaren bekräftar (med ev. redigeringar) → BankTransaction-rader
   * skapas och auto-matchas mot fakturor/hyresavier.
   */
  @Post('imports/:id/confirm')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async confirmImport(
    @Param('id') id: string,
    @Body() dto: ConfirmImportDto,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.statementImports.confirmImport(id, organizationId, user.sub, dto.transactions)
  }

  /**
   * DELETE /reconciliation/imports/:id
   * Avbryter en ej bekräftad import (sätter status=CANCELLED).
   */
  @Delete('imports/:id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async cancelImport(@Param('id') id: string, @OrgId() organizationId: string) {
    await this.statementImports.cancelImport(id, organizationId)
  }

  /**
   * POST /reconciliation/auto-match
   * Försöker auto-matcha alla UNMATCHED transaktioner mot fakturor.
   */
  @Post('auto-match')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async autoMatch(@OrgId() organizationId: string) {
    return this.reconciliationService.autoMatchAll(organizationId)
  }

  /**
   * GET /reconciliation/transactions
   * Query params: status, from, to
   */
  @Get('transactions')
  async getTransactions(
    @OrgId() organizationId: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const filters: { status?: string; from?: string; to?: string } = {}
    if (status !== undefined) filters.status = status
    if (from !== undefined) filters.from = from
    if (to !== undefined) filters.to = to
    return this.reconciliationService.getTransactions(organizationId, filters)
  }

  /**
   * GET /reconciliation/stats
   */
  @Get('stats')
  async getStats(@OrgId() organizationId: string) {
    return this.reconciliationService.getStats(organizationId)
  }

  /**
   * PATCH /reconciliation/transactions/:id/match
   * Body: { invoiceId: string }
   */
  @Patch('transactions/:id/match')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async manualMatch(
    @Param('id') id: string,
    @Body() dto: ManualMatchDto,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.reconciliationService.manualMatch(
      id,
      {
        ...(dto.invoiceId ? { invoiceId: dto.invoiceId } : {}),
        ...(dto.rentNoticeId ? { rentNoticeId: dto.rentNoticeId } : {}),
      },
      organizationId,
      user.sub,
    )
  }

  /**
   * PATCH /reconciliation/transactions/:id/ignore
   */
  @Patch('transactions/:id/ignore')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async ignoreTransaction(@Param('id') id: string, @OrgId() organizationId: string) {
    await this.reconciliationService.ignoreTransaction(id, organizationId)
  }

  /**
   * PATCH /reconciliation/transactions/:id/unmatch
   */
  @Patch('transactions/:id/unmatch')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async unmatchTransaction(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.reconciliationService.unmatchTransaction(id, organizationId, user.sub)
  }
}
