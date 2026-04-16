import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  UseGuards,
  Res,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import type { JwtPayload } from '@eken/shared'
import type { InvoicesService } from './invoices.service'
import type { PdfService } from './pdf.service'
import type { CreateInvoiceDto } from './dto/create-invoice.dto'
import type { UpdateInvoiceDto } from './dto/update-invoice.dto'
import type { TransitionStatusDto } from './dto/transition-status.dto'
import type { BulkInvoiceDto } from './dto/bulk-invoice.dto'
import type { InvoiceStatus } from '@prisma/client'

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly pdfService: PdfService,
  ) {}

  @Get()
  async findAll(
    @OrgId() organizationId: string,
    @Query('status') status?: InvoiceStatus,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.invoicesService.findAll(organizationId, {
      ...(status != null ? { status } : {}),
      ...(tenantId != null ? { tenantId } : {}),
    })
  }

  @Post('bulk')
  async createBulk(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: BulkInvoiceDto,
  ) {
    return this.invoicesService.createBulk(organizationId, user.sub, dto)
  }

  @Post()
  async create(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.invoicesService.create(organizationId, user.sub, dto)
  }

  @Get(':id/pdf')
  async getPdf(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const buffer = await this.pdfService.generateInvoicePdf(id, organizationId)
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="faktura-${id}.pdf"`)
      .header('Content-Length', buffer.length)
      .send(buffer)
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const invoice = await this.invoicesService.findOne(id, organizationId)
    // Spåra att användaren öppnade fakturan
    this.invoicesService.recordView(id, user.sub)
    return invoice
  }

  /**
   * GET /invoices/:id/events
   * Hämtar komplett fakturahistorik (tidslinje) för en faktura.
   */
  @Get(':id/events')
  async getTimeline(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.invoicesService.getTimeline(id, organizationId)
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.invoicesService.update(id, organizationId, user.sub, dto)
  }

  @Patch(':id/status')
  async transitionStatus(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: TransitionStatusDto,
  ) {
    return this.invoicesService.transitionStatus(
      id,
      organizationId,
      dto.status as InvoiceStatus,
      user.sub,
      'USER',
      dto.payload ?? {},
    )
  }

  @Post(':id/send-email')
  async sendEmail(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.invoicesService.sendInvoiceEmail(id, organizationId, user.sub)
    return { message: 'E-post skickad' }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @OrgId() organizationId: string): Promise<void> {
    await this.invoicesService.remove(id, organizationId)
  }
}
