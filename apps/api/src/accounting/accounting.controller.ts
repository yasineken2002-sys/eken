import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { AccountingService } from './accounting.service'

// Validerar ISO-datum (YYYY-MM-DD) från query. Kastar 400 vid saknat/felaktigt
// format så rapporterna aldrig kör mot ogiltiga Date-objekt (NaN-period).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function requireDate(value: string | undefined, field: string): string {
  if (!value || !DATE_RE.test(value)) {
    throw new BadRequestException(`${field} måste anges på formatet ÅÅÅÅ-MM-DD`)
  }
  // Formatregex släpper igenom kalenderorimliga datum (2026-02-30). JS koercerar
  // dem tyst (→ 2026-03-02) vilket skulle ge rapport för FEL period utan fel.
  // toISOString-rundtur fångar overflow: koercerat datum ≠ inmatad sträng.
  const parsed = new Date(value)
  if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} är inte ett giltigt kalenderdatum`)
  }
  return value
}

// Property-filter (valfritt) måste vara ett UUID om det anges — vi ekar inte
// godtyckliga strängar i svaret. Org-scopning sker i servicen.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function optionalUuid(value: string | undefined, field: string): string | undefined {
  if (value == null) return undefined
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${field} måste vara ett giltigt UUID`)
  }
  return value
}

// C1: hela bokföringen kräver minst ACCOUNTANT — konsekvent med accounts/seed
// och collections (ekonomidomänen = ACCOUNTANT och uppåt). Utan detta kunde
// VIEWER läsa hela verifikationsjournalen. Klass-nivå täcker alla GET-routes;
// hierarkisk RolesGuard släpper in ACCOUNTANT/MANAGER/ADMIN/OWNER, ej VIEWER.
@Controller('accounting')
@UseGuards(JwtAuthGuard)
@Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
export class AccountingController {
  constructor(private readonly accountingService: AccountingService) {}

  @Get('accounts')
  async getAccounts(@OrgId() organizationId: string) {
    return this.accountingService.getAccounts(organizationId)
  }

  @Post('accounts/seed')
  @Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
  async seedAccounts(@OrgId() organizationId: string) {
    await this.accountingService.seedDefaultAccounts(organizationId)
    return { message: 'Standardkonton skapade' }
  }

  @Get('journal')
  async getJournal(
    @OrgId() organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('source') source?: string,
  ) {
    return this.accountingService.getJournalEntries(organizationId, {
      ...(from != null ? { from } : {}),
      ...(to != null ? { to } : {}),
      ...(source != null ? { source } : {}),
    })
  }

  @Get('journal/:id')
  async getJournalEntry(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.accountingService.getJournalEntry(id, organizationId)
  }

  // ── Finansiella rapporter ───────────────────────────────────────────────
  // Exponerar samma beräkning som AI-verktygen (en sanningskälla i
  // AccountingService). Klass-nivå @Roles gäller → minst ACCOUNTANT.

  @Get('reports/profit-loss')
  async getProfitLoss(
    @OrgId() organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('propertyId') propertyId?: string,
  ) {
    return this.accountingService.getProfitLossReport(
      organizationId,
      requireDate(from, 'from'),
      requireDate(to, 'to'),
      optionalUuid(propertyId, 'propertyId'),
    )
  }

  @Get('reports/balance-sheet')
  async getBalanceSheet(@OrgId() organizationId: string, @Query('asOf') asOf?: string) {
    return this.accountingService.getBalanceSheet(organizationId, requireDate(asOf, 'asOf'))
  }

  @Get('reports/vat')
  async getVatReport(
    @OrgId() organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.accountingService.getVatReport(
      organizationId,
      requireDate(from, 'from'),
      requireDate(to, 'to'),
    )
  }

  // @Res() utan passthrough är avsiktligt: vi styr svaret manuellt (octet-stream
  // + Content-Disposition). TransformInterceptor körs ej, men GlobalExceptionFilter
  // fångar fel innan reply.send() anropas (datum-/Prisma-fel → 400/500 som vanligt).
  @Get('reports/sie4')
  async exportSie4(
    @OrgId() organizationId: string,
    @Res() reply: FastifyReply,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const fromDate = requireDate(from, 'from')
    const toDate = requireDate(to, 'to')
    const buffer = await this.accountingService.exportSie4(organizationId, fromDate, toDate)
    const filename = `bokforing-${fromDate}-${toDate}.se`
    void reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Content-Length', buffer.length)
      .send(buffer)
  }
}
