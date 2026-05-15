import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { PlatformInvoicesService } from './platform-invoices.service'
import {
  BackfillDto,
  CreatePlatformInvoiceDto,
  MarkPaidDto,
  UpdatePlatformInvoiceDto,
} from './dto/platform-invoice.dto'

const VALID_STATUSES = ['DRAFT', 'SENT', 'PENDING', 'PAID', 'OVERDUE', 'VOID'] as const
const VALID_TYPES = ['PLAN_FEE', 'AI_CREDITS', 'OTHER'] as const

type InvoiceStatus = (typeof VALID_STATUSES)[number]
type InvoiceType = (typeof VALID_TYPES)[number]

@ApiTags('Platform / Invoices')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/invoices')
export class PlatformInvoicesController {
  constructor(private readonly svc: PlatformInvoicesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista plattformsfakturor' })
  list(
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('organizationId') organizationId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list({
      ...(status && (VALID_STATUSES as readonly string[]).includes(status)
        ? { status: status as InvoiceStatus }
        : {}),
      ...(type && (VALID_TYPES as readonly string[]).includes(type)
        ? { type: type as InvoiceType }
        : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(page ? { page: parseInt(page, 10) } : {}),
      ...(pageSize ? { pageSize: parseInt(pageSize, 10) } : {}),
    })
  }

  @Get('stats')
  @ApiOperation({ summary: 'Aggregerad statistik för Fakturor-sidan' })
  stats() {
    return this.svc.stats()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Hämta en enskild plattformsfaktura' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Skapa ny plattformsfaktura (manuellt eller AI-credits)' })
  create(@Body() dto: CreatePlatformInvoiceDto) {
    return this.svc.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Uppdatera en DRAFT-faktura' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlatformInvoiceDto) {
    return this.svc.update(id, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Radera en DRAFT-faktura' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id)
  }

  @Post(':id/send')
  @ApiOperation({ summary: 'Mejla fakturan till kunden + sätt status SENT' })
  send(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.send(id)
  }

  @Post(':id/mark-paid')
  @ApiOperation({ summary: 'Markera fakturan som betald' })
  markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPaidDto) {
    return this.svc.markPaid(id, dto)
  }

  @Post(':id/void')
  @ApiOperation({ summary: 'Makulera fakturan' })
  voidInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.voidInvoice(id)
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Visa fakturans PDF i webbläsaren' })
  @Header('Content-Type', 'application/pdf')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    const pdf = await this.svc.generatePdf(id)
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${id}.pdf"`)
      .send(pdf)
  }

  @Post('cron/monthly')
  @ApiOperation({ summary: 'Trigga månadscron manuellt (för admin/test)' })
  triggerMonthlyCron() {
    return this.svc.createMonthlyInvoices()
  }

  @Get('cron/monthly/preview')
  @ApiOperation({ summary: 'Förhandsvisa vilka organisationer som faktureras' })
  previewMonthly(@Query('year') year?: string, @Query('month') month?: string) {
    return this.svc.previewForPeriod(
      year ? parseInt(year, 10) : undefined,
      month ? parseInt(month, 10) : undefined,
    )
  }

  @Post('cron/monthly/backfill')
  @ApiOperation({ summary: 'Skapa fakturor för en missad månad (backfill)' })
  backfill(@Body() dto: BackfillDto) {
    return this.svc.backfillForPeriod(dto.year, dto.month)
  }

  @Post('cron/trials/convert')
  @ApiOperation({ summary: 'Trigga trial-konvertering manuellt (för admin/test)' })
  triggerTrialConversion() {
    return this.svc.convertExpiredTrials()
  }

  @Post('cron/trials/reminders')
  @ApiOperation({ summary: 'Trigga trial-påminnelser manuellt (för admin/test)' })
  triggerTrialReminders() {
    return this.svc.sendTrialEndingReminders()
  }
}
