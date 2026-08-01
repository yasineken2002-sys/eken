import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common'
import { IsArray, IsOptional, IsString, IsUUID, MinLength } from 'class-validator'
import { Roles } from '../common/decorators/roles.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { PaymentReminderService } from '../notifications/payment-reminder.service'
import { CollectionExportService } from './collection-export.service'

class BulkExportDto {
  @IsArray()
  @IsUUID('4', { each: true })
  invoiceIds!: string[]
}

class PauseRemindersDto {
  @IsOptional()
  @IsString()
  reason?: string
}

class MarkSentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  note?: string
}

/**
 * Inkasso — fakturaflödet.
 *
 * ROLLGRINDEN ÄR TVÅDELAD, och dekoratorn är den grova halvan. Klassnivån gäller
 * BÅDE läsning (som MANAGER ska ha) och de bindande handlingarna (som MANAGER
 * inte ska ha) — en enda lista kan inte skilja dem åt, oavsett semantik. Den
 * stänger därför bara ute VIEWER.
 *
 * (När R1 skrevs kunde listan dessutom inte utesluta MANAGER ens om man ville:
 * guarden var hierarkisk och släppte in allt över den lägsta listade rollen.
 * R2 steg 2 tog bort det. Uppdelningen nedan står kvar för att den är rätt, inte
 * för att den är påtvingad.)
 *
 * Gränsen som faktiskt gäller ligger i tjänsten:
 *   • LÄSA (förfallostatus) och PAUSA/ÅTERUPPTA kravtrappan → även MANAGER.
 *     Förvaltaren har hyresgästkontakten, och båda är reversibla.
 *   • EXPORTERA och MARKERA SKICKAD till inkasso → endast ekonomi
 *     (ACCOUNTANT/ADMIN/OWNER), exakt matchning i
 *     common/authz/collections-authz.ts. Att lämna över en skuld är bindande
 *     mot en enskild person och går inte att ta tillbaka.
 *
 * Samma gräns drar AI-lagret redan (ACCOUNTING_ONLY_ACTIONS respektive
 * MANAGER_ALLOWED_ACTIONS) — R1 rättade HTTP-vägen till att säga samma sak.
 */
@Controller('collections')
@Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
export class CollectionsController {
  constructor(
    private readonly exportService: CollectionExportService,
    private readonly reminders: PaymentReminderService,
  ) {}

  @Get('overdue-status')
  async getOverdueStatus(@OrgId() organizationId: string, @Query('bucket') bucket?: string) {
    const all = await this.reminders.getOverdueStatus(organizationId)
    if (bucket === 'in-progress') {
      return all.filter(
        (i) => i.status === 'OVERDUE' && i.lastReminderType !== 'READY_FOR_COLLECTION',
      )
    }
    if (bucket === 'ready') {
      return all.filter(
        (i) => i.status === 'OVERDUE' && i.lastReminderType === 'READY_FOR_COLLECTION',
      )
    }
    if (bucket === 'sent') {
      return all.filter((i) => i.status === 'SENT_TO_COLLECTION')
    }
    return all
  }

  @Post('export/:invoiceId')
  @HttpCode(HttpStatus.ACCEPTED)
  async exportSingle(
    @Param('invoiceId') invoiceId: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.exportService.enqueueExportForInvoice(invoiceId, organizationId, user.role)
  }

  @Post('bulk-export')
  @HttpCode(HttpStatus.ACCEPTED)
  async exportBulk(
    @Body() dto: BulkExportDto,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!dto.invoiceIds?.length) {
      throw new BadRequestException('invoiceIds får inte vara tom')
    }
    return this.exportService.enqueueBulkExport(dto.invoiceIds, organizationId, user.role)
  }

  @Post('mark-sent/:invoiceId')
  @HttpCode(HttpStatus.OK)
  async markSent(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: MarkSentDto,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.exportService.markSentToCollection(
      invoiceId,
      organizationId,
      dto.note,
      user.role,
      user.sub,
    )
  }

  @Patch('reminders/:invoiceId/pause')
  @HttpCode(HttpStatus.OK)
  async pauseReminders(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: PauseRemindersDto,
    @OrgId() organizationId: string,
  ) {
    return this.reminders.pauseReminders(invoiceId, organizationId, dto.reason)
  }

  @Patch('reminders/:invoiceId/resume')
  @HttpCode(HttpStatus.OK)
  async resumeReminders(@Param('invoiceId') invoiceId: string, @OrgId() organizationId: string) {
    return this.reminders.resumeReminders(invoiceId, organizationId)
  }
}
