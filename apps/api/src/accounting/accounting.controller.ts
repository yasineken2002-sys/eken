import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
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
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { AccountingService } from './accounting.service'
import { AccountingPeriodService } from './accounting-period.service'
// Värde-import, inte `import type` — ValidationPipe behöver klassen i runtime.
import { ReopenPeriodDto } from './dto/reopen-period.dto'

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
  constructor(
    private readonly accountingService: AccountingService,
    private readonly periods: AccountingPeriodService,
  ) {}

  @Get('accounts')
  async getAccounts(@OrgId() organizationId: string) {
    return this.accountingService.getAccounts(organizationId)
  }

  // ── Bokföringsperioder (T5 PR1a) ─────────────────────────────────────────
  // Gör den befintliga ClosedAccountingPeriod-mekanismen nåbar utanför AI-
  // assistenten. Ingen ny spärr: allocate() är fortsatt den enda punkt som
  // hindrar en bokföring i en stängd period.

  /** Översikt: vilka perioder är stängda, vilka är öppna, vad stängdes senast. */
  @Get('periods')
  async getPeriods(@OrgId() organizationId: string, @Query('months') months?: string) {
    const parsed = months != null ? Number(months) : undefined
    return this.periods.getOverview(
      organizationId,
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    )
  }

  /** Vad är ofullständigt i perioden? Visas innan operatören låser. */
  @Get('periods/:year/:month/precheck')
  async precheckPeriod(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
  ) {
    return this.periods.precheck(organizationId, Number(year), Number(month))
  }

  /**
   * Stänger perioden. Rollkravet upprepas i tjänsten (fail-closed chokepunkt,
   * #194-mönstret) — dekoratorn här är bekvämlighet, inte skyddet. MANAGER
   * utesluts medvetet: stängning är en redovisningshandling, inte förvaltning.
   */
  @Post('periods/:year/:month/close')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(200)
  async closePeriod(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.periods.closePeriod(organizationId, Number(year), Number(month), {
      actorRole: user.role,
      actorUserId: user.sub,
    })
  }

  /**
   * Periodens historik + underlaget återöppningsdialogen behöver (momsperioder,
   * räkenskapsårsfönstret). Egen endpoint, inte påhängd på översikten — den ska
   * inte bära N händelser per period för en sida som listar tolv månader.
   *
   * ROLLGRINDEN ÄR MEDVETET KLASSNIVÅNS (minst ACCOUNTANT), inte OWNER-only som
   * själva återöppningen. Att LÄSA vad som hänt med en period är inte samma sak
   * som att få ändra det, och den som ska kunna stänga behöver kunna se varför
   * perioden öppnades. `reason` är fritext och kan nämna en enskild avi ("hyres-
   * avin för lgh 12") — men samma läsare når redan hela verifikationsjournalen
   * (`GET journal`) under samma grind, så historiken exponerar inget nytt.
   * VIEWER stängs ute av klassnivån.
   */
  @Get('periods/:year/:month/history')
  async getPeriodHistory(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
  ) {
    return this.periods.getDetail(organizationId, Number(year), Number(month))
  }

  /**
   * Öppnar en stängd period igen. OWNER-only — men dekoratorn är inte skyddet:
   * rollen, orsakskategorin, räkenskapsårsspärren och tillståndskontrollen
   * upprepas alla i tjänsten (fail-closed chokepunkt, #194-mönstret), så en
   * framtida intern anropare träffar samma grindar.
   *
   * ACCOUNTANT får stänga men INTE öppna: den som upptäcker behovet ska behöva
   * förklara det för den som bär bokföringsansvaret.
   */
  @Post('periods/:year/:month/reopen')
  @Roles('OWNER')
  @HttpCode(200)
  async reopenPeriod(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
    @Body() dto: ReopenPeriodDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.periods.reopenPeriod(organizationId, Number(year), Number(month), {
      actorRole: user.role,
      actorUserId: user.sub,
      reason: dto.reason,
      reasonCategory: dto.reasonCategory,
    })
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
