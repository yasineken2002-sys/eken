import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  BadRequestException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { ReconciliationService } from './reconciliation.service'
import type { ManualMatchDto } from './dto/manual-match.dto'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { Body } from '@nestjs/common'

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  /**
   * POST /reconciliation/import
   * Multipart form upload, field: "statement"
   * Accepts: .csv, .xlsx, .xls (max 10MB)
   */
  @Post('import')
  async importStatement(@OrgId() organizationId: string, @Req() req: FastifyRequest) {
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

    const buffer = await file.toBuffer()
    return this.reconciliationService.importBankStatement(buffer, filename, organizationId)
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
  async manualMatch(
    @Param('id') id: string,
    @Body() dto: ManualMatchDto,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.reconciliationService.manualMatch(id, dto.invoiceId, organizationId, user.sub)
  }

  /**
   * PATCH /reconciliation/transactions/:id/ignore
   */
  @Patch('transactions/:id/ignore')
  async ignoreTransaction(@Param('id') id: string, @OrgId() organizationId: string) {
    await this.reconciliationService.ignoreTransaction(id, organizationId)
  }

  /**
   * PATCH /reconciliation/transactions/:id/unmatch
   */
  @Patch('transactions/:id/unmatch')
  async unmatchTransaction(@Param('id') id: string, @OrgId() organizationId: string) {
    await this.reconciliationService.unmatchTransaction(id, organizationId)
  }
}
