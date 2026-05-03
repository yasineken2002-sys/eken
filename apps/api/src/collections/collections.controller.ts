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

@Controller('collections')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
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
  @HttpCode(HttpStatus.OK)
  async exportSingle(@Param('invoiceId') invoiceId: string, @OrgId() organizationId: string) {
    return this.exportService.exportForInvoice(invoiceId, organizationId)
  }

  @Post('bulk-export')
  @HttpCode(HttpStatus.OK)
  async exportBulk(@Body() dto: BulkExportDto, @OrgId() organizationId: string) {
    if (!dto.invoiceIds?.length) {
      throw new BadRequestException('invoiceIds får inte vara tom')
    }
    return this.exportService.exportBulk(dto.invoiceIds, organizationId)
  }

  @Post('mark-sent/:invoiceId')
  @HttpCode(HttpStatus.OK)
  async markSent(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: MarkSentDto,
    @OrgId() organizationId: string,
  ) {
    return this.exportService.markSentToCollection(invoiceId, organizationId, dto.note)
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
