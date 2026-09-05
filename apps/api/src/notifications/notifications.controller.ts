import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  ConflictException,
} from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { NotificationsService } from './notifications.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { QueryNotificationsDto } from './dto/query-notifications.dto'
import type { JwtPayload } from '@eken/shared'

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly service: NotificationsService,
    /**
     * Färskhetsgrinden ligger i CONTROLLERN, inte i NotificationsService.
     * Skälet är mätt: en ny konstruktor-parameter på tjänsten fällde åtta
     * specrigg:ar som bygger den med attrapper. Controllern konstrueras inte av
     * någon spec, och frågan hör ändå hemma hos den tjänst som äger begreppet —
     * `evaluateForOrg` läser org-raden själv.
     */
    private readonly freshness: PaymentFreshnessService,
  ) {}

  @Get('count')
  async getCount(@OrgId() organizationId: string, @CurrentUser() user: JwtPayload) {
    const unread = await this.service.getUnreadCount(organizationId, user.sub)
    return { unread }
  }

  @Get()
  async findAll(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryNotificationsDto,
  ) {
    return this.service.findAll(organizationId, user.sub, query.unread)
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  async markAll(@OrgId() organizationId: string, @CurrentUser() user: JwtPayload) {
    return this.service.markAllAsRead(organizationId, user.sub)
  }

  @Patch(':id/read')
  async markOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.markAsRead(id, user.sub)
  }

  @Delete('old')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOld() {
    await this.service.deleteOld()
  }

  /**
   * FÖRHANDSBESKED inför ett manuellt påminnelseutskick.
   *
   * Människans väg till AI-verktyget `send_overdue_reminders`, som stod i
   * `tool-human-path.baseline.json` med skälet att endpointen nedan fanns men
   * att INGEN rad i apps/web anropade den — gränssnittet kunde pausa och
   * återuppta påminnelser, inte utlösa ett utskick.
   *
   * Svaret bär både mängden och färskhetsläget, så att knappen kan spärras med
   * SKÄLET i klartext i stället för att tyst göra ingenting.
   */
  @Get('overdue-reminders/preview')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OWNER')
  async previewReminders(@OrgId() organizationId: string) {
    const [preview, freshness] = await Promise.all([
      this.service.previewOverdueReminders(organizationId),
      this.freshness.evaluateForOrg(organizationId),
    ])
    return { ...preview, freshness }
  }

  /**
   * Skicka förfallopåminnelser nu.
   *
   * ── FÄRSKHETSGRINDEN GÄLLER ÄVEN HÄR ────────────────────────────────────
   *
   * Kravtrappans cron pausar när betalningsdatan är inaktuell: ett krav som
   * rullar mot en hyresgäst som kan ha betalat utan att avstämningen vet det tar
   * betalt och flyttar fram kravet. Att den grinden bara gällde det AUTOMATISKA
   * spåret vore en lucka i det manuella — och knappen är den snabbaste vägen
   * till precis det felet.
   *
   * SPÄRREN ÄR I SERVERN, inte bara i gränssnittet. Att bara gråa knappen hade
   * lämnat endpointen öppen för den som anropar den direkt, och grinden ska
   * ligga där effekten uppstår.
   *
   * 409, inte 422: tillståndet är tillfälligt och åtgärdbart (importera en
   * färskare bankfil), inte en felformad begäran.
   */
  @Post('send-overdue-reminders')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OWNER')
  async triggerReminders(@OrgId() organizationId: string) {
    const freshness = await this.freshness.evaluateForOrg(organizationId)
    if (freshness.stale) {
      throw new ConflictException(
        `Betalningsdatan är inaktuell — senast kända kompletta datum är ${
          freshness.through ? freshness.through.toISOString().slice(0, 10) : 'okänt'
        } (${freshness.ageDays === Infinity ? 'ingen data importerad' : `${freshness.ageDays} dygn sedan`}, gränsen är ${freshness.thresholdDays}). ` +
          'Importera en färskare bankfil innan du skickar krav — annars kan påminnelser gå till hyresgäster som redan betalat.',
      )
    }
    const resultat = await this.service.sendOverdueRemindersForOrg(organizationId)
    return {
      ...resultat,
      message: `${resultat.sent} påminnelser skickade, ${resultat.skipped} hoppades över (redan påmind i dag), ${resultat.failed} misslyckades.`,
    }
  }
}
