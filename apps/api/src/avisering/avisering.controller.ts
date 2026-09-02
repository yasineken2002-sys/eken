import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { AviseringService } from './avisering.service'
import { AviseringScheduler } from './avisering.scheduler'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentReminderService } from './rent-reminder.service'
import { RentBadDebtService } from './rent-bad-debt.service'
import { RentNoticeCreditService } from './rent-notice-credit.service'
import { ReverseReminderFeeDto } from './dto/reverse-reminder-fee.dto'
import { impersonatorOf } from '../common/auth/impersonation'
import { RentBackfillService } from './rent-backfill.service'
import { GenerateNoticesDto } from './dto/generate-notices.dto'
import { SendNoticesDto } from './dto/send-notices.dto'
import { MarkPaidDto } from './dto/mark-paid.dto'
import { ConfirmBackfillDto } from './dto/confirm-backfill.dto'
import { CreateRentNoticeCreditDto } from './dto/create-rent-notice-credit.dto'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { UserRole } from '@prisma/client'

/**
 * `?amount=` → tal, eller `undefined` när klienten inte frågat.
 *
 * FÖRKASTAR SKRÄP I STÄLLET FÖR ATT TOLKA DET. `Number('')` är 0 och
 * `Number('abc')` är NaN; båda hade tyst blivit en projektion — en nolla ser ut
 * som ett svar, och NaN hade renderats som "NaN kr" för en operatör som står i
 * begrepp att fatta ett bindande beslut. Ett felaktigt värde ska säga ifrån.
 */
function parseProposedAmount(raw?: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException('amount måste vara ett positivt tal')
  }
  return n
}
import type { RentNoticeStatus } from '@prisma/client'
import type { JwtPayload } from '@eken/shared'

@Controller('avisering')
export class AviseringController {
  constructor(
    private readonly aviseringService: AviseringService,
    private readonly scheduler: AviseringScheduler,
    private readonly rentNoticeEvents: RentNoticeEventsService,
    private readonly badDebt: RentBadDebtService,
    private readonly backfill: RentBackfillService,
    private readonly credits: RentNoticeCreditService,
    // #648 — läsande INV-B-status till avins detaljvy. SIST i listan: nya
    // beroenden läggs till på slutet så befintliga positionsanrop inte tyst
    // byter betydelse.
    private readonly rentReminder: RentReminderService,
  ) {}

  // ── T1.4 / #44 — efterdebitering (bakdaterad debitering) ───────────────────
  // "Att efterdebitera"-kön är SKILD från lease-aktiveringen (jurist CRITICAL):
  // hyresvärden tar pengabeslutet medvetet. Preview/kö skapar ALDRIG en avi;
  // bara `confirm` gör det (den bindande människo-handlingen), och först då kör
  // PR1-motorn med actor-audit.

  // Kön: alla aktiva kontrakt med debiterbara luckor. Utgör även den manuella
  // gap-detektions-retriggern (#58) — den körs på begäran, inte bara vid aktivering.
  @Get('backfill/queue')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async backfillQueue(@OrgId() orgId: string) {
    return this.backfill.detectQueue(orgId)
  }

  // Preview per kontrakt: månad-för-månad-detektion (belopp, period, status).
  // Ren detektion — skapar/skickar inget.
  @Get('backfill/:leaseId/preview')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async backfillPreview(@OrgId() orgId: string, @Param('leaseId') leaseId: string) {
    return this.backfill.detectGaps(leaseId, orgId)
  }

  // Bekräftelse = den juridiskt BINDANDE punkten. Kör PR1-motorn som skapar
  // avierna + verifikaten atomiskt och skriver actor-audit (vem godkände) per avi.
  // Utan detta anrop skapas ingenting.
  @Post('backfill/:leaseId/confirm')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.OK)
  async backfillConfirm(
    @OrgId() orgId: string,
    @Param('leaseId') leaseId: string,
    @Body() dto: ConfirmBackfillDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.backfill.createBackfillNotices(leaseId, orgId, {
      allowBeyondWarning: dto.allowBeyondWarning === true,
      vatDeclarationAcknowledged: dto.vatDeclarationAcknowledged === true,
      actorUserId: user.sub,
      // >12-mån-override kräver ADMIN/OWNER — grindas i servicen (chokepunkten).
      actorRole: user.role,
    })
  }

  @Post('generate')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async generate(@OrgId() orgId: string, @Body() dto: GenerateNoticesDto) {
    return this.aviseringService.generateMonthlyNotices(orgId, dto.month, dto.year)
  }

  // Admin-trigger för månadscronen. Använd för att simulera "1:a varje månad
  // kl 07:00" i test eller om servern var nere när cron skulle köra.
  @Post('cron/run/:year/:month')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async runCron(
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
  ) {
    return this.scheduler.runForMonth(year, month)
  }

  @Post('send')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.ACCEPTED)
  async send(@OrgId() orgId: string, @Body() dto: SendNoticesDto) {
    return this.aviseringService.sendNotices(orgId, dto.noticeIds)
  }

  @Post('send-all/:month/:year')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.ACCEPTED)
  async sendAll(
    @OrgId() orgId: string,
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    const notices = await this.aviseringService.findAll(orgId, {
      month,
      year,
      status: 'PENDING' as RentNoticeStatus,
    })
    const ids = notices.map((n) => n.id)
    return this.aviseringService.sendNotices(orgId, ids)
  }

  @Get('stats/:month/:year')
  async stats(
    @OrgId() orgId: string,
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.aviseringService.getStats(orgId, month, year)
  }

  @Get()
  async findAll(
    @OrgId() orgId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.aviseringService.findAll(orgId, {
      ...(month ? { month: parseInt(month, 10) } : {}),
      ...(year ? { year: parseInt(year, 10) } : {}),
      ...(status ? { status: status as RentNoticeStatus } : {}),
      ...(search ? { search } : {}),
      ...(tenantId ? { tenantId } : {}),
    })
  }

  @Get(':id/pdf')
  async pdf(@OrgId() orgId: string, @Param('id') id: string, @Res() reply: FastifyReply) {
    const buffer = await this.aviseringService.getNoticePdfBuffer(id, orgId)
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="hyresavi.pdf"`)
      .send(buffer)
  }

  // Krav-/leveranstidslinje för en avi. Org-verifieras i servicen (avin måste
  // tillhöra organisationen innan händelser returneras).
  //
  // Utan raden ärvde endpointen bara det globala JwtAuthGuard, så VIEWER kunde
  // läsa hela tidslinjen rått: `actorLabel` ("Anna Svensson"), `actorId` och
  // `payload` med `feeOre`, `ratePercent`, `journalEntryId` och Resends
  // `messageId`. Läsningen är spåret efter handlingar VIEWER inte får utföra —
  // markPaid (MANAGER+), cancel (ADMIN/OWNER), reminder-fee/reverse och
  // bad-debt/* (ACCOUNTANT+) samt kravtrappans cron. Det är #81:s form:
  // utfallet av en handling låg öppet för en roll utan del i handlingen.
  //
  // ACCOUNTANT ingår för att den rollen utför tre av handlingarna som hamnar i
  // loggen. Ingen vy i web/admin/portal anropar endpointen (greppat), så ingen
  // frontend tappar åtkomst.
  @Get(':id/events')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async events(@OrgId() orgId: string, @Param('id') id: string) {
    return this.rentNoticeEvents.getTimeline(id, orgId)
  }

  /**
   * VARFÖR STÅR DEN HÄR AVIN STILL?
   *
   * Samma rollgrind som `:id/events` — den här svarar på exakt samma fråga med
   * ett annat underlag, och två olika grindar för samma fråga hade betytt att
   * en roll kan se hindret men inte händelserna som förklarar det.
   *
   * Läsande. Beräknar INV-B-grinden nu i stället för att lita på den senaste
   * blockeringsanteckningen i loggen, som kan vara dygn gammal eller aldrig ha
   * skrivits (två av cronets tre vägar vidare lämnar inget spår).
   */
  @Get(':id/collection-status')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async collectionStatus(@OrgId() orgId: string, @Param('id') id: string) {
    return this.rentReminder.collectionStatus(id, orgId)
  }

  /**
   * SKICKA OM PÅMINNELSEN (#656).
   *
   * SAMMA påminnelse, inte ett nytt trappsteg: ingen ny avgift, ingen omräknad
   * ränta, ingen förflyttning i kravtrappan. Grindarna bor i tjänsten, inte
   * här — knappens villkor och skrivvägens villkor får inte vara två
   * uppsättningar.
   *
   * ROLLERNA ÄR SKRIVROLLERNA, inte läsrollerna. Att skicka ett formellt krav
   * till en hyresgäst är en handling; ACCOUNTANT får se underlaget (`:id/events`,
   * `:id/collection-status`) men inte utföra den. Samma gräns som `:id/paid`.
   */
  @Post(':id/reminder/resend')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async resendReminder(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    return this.rentReminder.resendReminder(id, orgId, user.sub)
  }

  @Get(':id')
  async findOne(@OrgId() orgId: string, @Param('id') id: string) {
    return this.aviseringService.findOne(id, orgId)
  }

  @Patch(':id/paid')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async markPaid(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @Body() dto: MarkPaidDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.aviseringService.markAsPaid(
      id,
      orgId,
      dto.paidAmount,
      dto.paymentMethod,
      dto.paidAt,
      user.sub,
    )
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.OK)
  async cancel(@OrgId() orgId: string, @Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.aviseringService.cancelNotice(id, orgId, user.sub)
  }

  // Inkasso PR 5 — kundförlust (skuld-sidans bokföringscykel). Bokföringsåtgärder
  // → ACCOUNTANT-rollen tillåts (utöver MANAGER/ADMIN/OWNER). Endast momsfri
  // bostadshyra; momspliktig lokalhyra vägras (docs/legal/46 fråga 1).

  // BEFARAD kundförlust: omklassar inkasso-redo, momsfri fordran 1510 → 1515.
  // G4a — stryk en felaktigt debiterad påminnelseavgift utan att annullera avin.
  // Bokföringshandling (motverifikat 3593 D / 1510 K) → samma rolluppsättning
  // som kundförlust-vägarna nedan, alltså ACCOUNTANT tillåts.
  //
  // Endast RÄTTELSE. Eftergift av en giltig fordran är en annan affärshändelse
  // med annan kontering och finns inte här (G4b, väntar FAR:s kontobeslut).
  @Post(':id/reminder-fee/reverse')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.OK)
  async reverseReminderFee(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @Body() dto: ReverseReminderFeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.aviseringService.reverseReminderFee(
      id,
      orgId,
      dto.reason,
      user.sub,
      impersonatorOf(user),
    )
  }

  // ── #518 — KREDITERING AV HYRESAVI (nedsättning) ─────────────────────────
  //
  // Underlaget krediteringsvyn förfyller sig från: vad som återstår att
  // kreditera per post, och om kreditering alls är möjlig. Läsning — SAMMA
  // rollnivå som själva krediteringen, så att knappen inte visas för någon som
  // ändå inte får utföra den.
  //
  // `amount` (valfri) är den summa gränssnittet tänker kreditera. Med den
  // returneras en PROJEKTION ur samma `computeRentDebt` som kravtrappan läser:
  // vad som blir kvar, och om avin då stannar för att bara ränta återstår.
  // Regeln får inte räknas om i klienten — se `getPreview`:s docblock.
  @Get(':id/credit/preview')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async creditPreview(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @Query('amount') amount?: string,
  ) {
    return this.credits.getPreview(id, orgId, parseProposedAmount(amount))
  }

  // Nedsättning av en OBETALD avi. Kreditering av en betald avi är spärrad i
  // tjänsten och kräver ett kontobeslut som inte är fattat.
  @Post(':id/credit')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async createCredit(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateRentNoticeCreditDto,
  ) {
    return this.credits.createCredit(id, orgId, user.sub, dto)
  }

  @Post(':id/bad-debt/probable')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.OK)
  async markProbableLoss(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.badDebt.reclassifyToProbableLoss(id, orgId, user.sub)
  }

  // KONSTATERAD kundförlust: skriver av osäker fordran 1515 → 6352, flippar WRITTEN_OFF.
  @Post(':id/bad-debt/confirm')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.OK)
  async confirmLoss(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.badDebt.confirmLoss(id, orgId, user.sub)
  }
}
