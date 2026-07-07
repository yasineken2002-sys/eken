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
import { Roles } from '../common/decorators/roles.decorator'
import type { JwtPayload } from '@eken/shared'
import { InvoicesService, toPaymentMethod } from './invoices.service'
import { PdfService } from './pdf.service'
import { CreateInvoiceDto } from './dto/create-invoice.dto'
import { UpdateInvoiceDto } from './dto/update-invoice.dto'
import { TransitionStatusDto } from './dto/transition-status.dto'
import { RegisterPaymentDto } from './dto/register-payment.dto'
import { BulkInvoiceDto } from './dto/bulk-invoice.dto'
import { BadRequestException } from '@nestjs/common'
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
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async createBulk(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: BulkInvoiceDto,
  ) {
    return this.invoicesService.createBulk(organizationId, user.sub, dto)
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
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
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.invoicesService.update(id, organizationId, user.sub, dto)
  }

  @Patch(':id/status')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async transitionStatus(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: TransitionStatusDto,
  ) {
    // Betalning MÅSTE bokföras — den generiska statusövergången gör det inte.
    // Tvinga klienter till POST /:id/pay (markAsPaidManually) så att en faktura
    // aldrig kan flippas till PAID utan verifikat (BFL 5 kap 6 §).
    if (dto.status === 'PAID') {
      throw new BadRequestException(
        'Använd betalningsregistrering (POST /invoices/:id/pay) för att markera en faktura som betald',
      )
    }
    return this.invoicesService.transitionStatus(
      id,
      organizationId,
      dto.status as InvoiceStatus,
      user.sub,
      'USER',
      dto.payload ?? {},
    )
  }

  // Manuell betalningsregistrering med bokföring (likvidkonto D / 1510 K).
  @Post(':id/pay')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async registerPayment(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterPaymentDto,
  ) {
    return this.invoicesService.markAsPaidManually(
      id,
      organizationId,
      toPaymentMethod(dto.paymentMethod),
      user.sub,
      'USER',
      {
        enteredAmount: dto.amount,
        ...(dto.reference ? { reference: dto.reference } : {}),
        ...(dto.paidAt ? { paidAt: new Date(dto.paidAt) } : {}),
      },
    )
  }

  @Post(':id/send-email')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @HttpCode(202)
  async sendEmail(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const { jobId } = await this.invoicesService.sendInvoiceEmail(id, organizationId, user.sub)
    return { jobId, message: 'Fakturan köad för utskick' }
  }

  @Delete(':id')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.invoicesService.remove(id, organizationId, user.sub)
  }
}
