import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Throttle } from '@nestjs/throttler'
import {
  IsEmail,
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsBoolean,
  IsArray,
  ArrayMaxSize,
  MinLength,
} from 'class-validator'
import { MaintenanceCategory } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import { Public } from '../common/decorators/public.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { MaintenanceService } from '../maintenance/maintenance.service'
import { PdfService } from '../invoices/pdf.service'
import { AviseringService } from '../avisering/avisering.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantPortalService } from './tenant-portal.service'
import { TenantInvitationsService, type TenantInviteStatus } from './tenant-invitations.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { CurrentTenant } from './current-tenant.decorator'
import type { Tenant } from '@prisma/client'

// ── DTOs ──────────────────────────────────────────────────────────────────────

class LoginDto {
  @IsEmail()
  email!: string

  @IsString()
  @MinLength(1)
  password!: string

  @IsOptional()
  @IsUUID()
  organizationId?: string
}

class ActivateDto {
  @IsString()
  @MinLength(1)
  token!: string

  // Lösenordsstyrkan kontrolleras i TenantAuthService.assertStrongPassword.
  @IsString()
  @MinLength(1)
  password!: string

  // Hyresgästens skrivna namnunderskrift vid digital signering. Sparas
  // på Document-raden så signaturen blir spårbar separat från FK-länken
  // till Tenant. VALFRI: rena portal-inbjudningar (massutskick för
  // importerade hyresgäster utan kontrakts-PDF) signerar inget kontrakt och
  // behöver ingen underskrift. Anges den ändå kräver vi minst 2 tecken.
  @IsOptional()
  @IsString()
  @MinLength(2)
  signatureName?: string
}

class DeleteAccountDto {
  @IsString()
  @MinLength(1)
  password!: string
}

class ForgotPasswordDto {
  @IsEmail()
  email!: string
}

class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token!: string

  // Lösenordsstyrkan kontrolleras i TenantAuthService.assertStrongPassword.
  @IsString()
  @MinLength(1)
  password!: string
}

class InviteTenantsDto {
  // Bjud in alla aktiva hyresgäster (≥1 ACTIVE-kontrakt).
  @IsOptional()
  @IsBoolean()
  all?: boolean

  // Eller ett explicit urval.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('4', { each: true })
  tenantIds?: string[]

  // Kringgå 24 h-dubbelklicks-skyddet (medveten omsändning).
  @IsOptional()
  @IsBoolean()
  force?: boolean
}

class ResendInvitesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('4', { each: true })
  tenantIds?: string[]

  // Skicka om till alla inbjudna men ej aktiverade.
  @IsOptional()
  @IsBoolean()
  onlyNotActivated?: boolean
}

class SubmitMaintenanceDto {
  @IsString()
  @MinLength(3)
  title!: string

  @IsString()
  @MinLength(10)
  description!: string

  @IsEnum(MaintenanceCategory)
  @IsOptional()
  category?: MaintenanceCategory
}

class AddCommentDto {
  @IsString()
  @MinLength(1)
  content!: string
}

// ── Hjälpare ──────────────────────────────────────────────────────────────────

function tenantSummary(tenant: Tenant): {
  id: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
  email: string
} {
  return {
    id: tenant.id,
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    companyName: tenant.companyName,
    email: tenant.email,
  }
}

// ── Auth-controller (publik) ──────────────────────────────────────────────────

@Controller('tenant-portal')
@Public()
export class TenantAuthController {
  constructor(
    private readonly tenantAuthService: TenantAuthService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly contracts: ContractTemplateService,
  ) {}

  /**
   * Hämta minimal kontrakts-/hyresgästinfo för aktiveringssidan så den kan
   * visa hyresgästens namn + kontraktsdetaljer innan signering.
   */
  @Get('activation/:token')
  async getActivationInfo(@Param('token') token: string) {
    const tenant = await this.tenantAuthService.findTenantByActivationToken(token)
    const lease = tenant.leases[0] ?? null

    return {
      tenant: {
        id: tenant.id,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        companyName: tenant.companyName,
        email: tenant.email,
        type: tenant.type,
      },
      organization: tenant.organization,
      lease: lease
        ? {
            id: lease.id,
            status: lease.status,
            startDate: lease.startDate.toISOString(),
            endDate: lease.endDate ? lease.endDate.toISOString() : null,
            monthlyRent: Number(lease.monthlyRent),
            depositAmount: Number(lease.depositAmount),
            noticePeriodMonths: lease.noticePeriodMonths,
            leaseType: lease.leaseType,
            unit: {
              id: lease.unit.id,
              name: lease.unit.name,
              unitNumber: lease.unit.unitNumber,
              property: lease.unit.property,
            },
          }
        : null,
    }
  }

  /**
   * Returnerar en presigned R2-URL till senaste kontrakts-PDF för aktiverings-
   * tokenets hyresgäst. Token i sig är auth — ingen extra session krävs.
   * Hyresgästen ska kunna granska den faktiska PDF:en (inte bara HTML-fält)
   * innan de signerar.
   */
  @Get('activation/:token/contract')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async getActivationContract(@Param('token') token: string) {
    // findTenantByActivationToken kastar 401 vid ogiltig/utgången token, vilket
    // ger samma generiska felsvar som övriga aktiveringsendpoints.
    const tenant = await this.tenantAuthService.findTenantByActivationToken(token)
    const lease = tenant.leases[0]
    if (!lease) {
      throw new NotFoundException('Inget kontrakt hittades')
    }

    const doc = await this.contracts.findLatestContract(lease.id, tenant.organizationId)
    if (!doc) {
      throw new NotFoundException('Kontraktets PDF har inte genererats än')
    }

    const url = await this.storage.getPresignedUrl(doc.storageKey, 300)
    return { url, filename: `${doc.name}.pdf`, mimeType: doc.mimeType }
  }

  @Post('activate')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async activate(@Body() dto: ActivateDto, @Req() req: FastifyRequest) {
    const ip = req.ip ?? null
    const userAgent = req.headers['user-agent'] ?? null
    const result = await this.tenantAuthService.activate(dto.token, dto.password, {
      ip,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      signatureName: dto.signatureName ?? null,
    })
    return {
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt.toISOString(),
      tenant: tenantSummary(result.tenant),
    }
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    const result = await this.tenantAuthService.login(dto.email, dto.password, dto.organizationId)
    return {
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt.toISOString(),
      tenant: tenantSummary(result.tenant),
    }
  }

  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.tenantAuthService.sendForgotPassword(dto.email)
    // Generiskt svar oavsett om e-posten matchade — undvik enumeration.
    return { message: 'Om kontot finns har ett mejl skickats med återställningsinstruktioner' }
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const result = await this.tenantAuthService.resetPassword(dto.token, dto.password)
    return {
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt.toISOString(),
      tenant: tenantSummary(result.tenant),
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body: { sessionToken?: string }): Promise<null> {
    if (body.sessionToken) {
      await this.tenantAuthService.logout(body.sessionToken)
    }
    return null
  }

  /**
   * Dev-only — bygg en aktiveringslänk för en hyresgäst utan att skicka mejl.
   * Används av portalens dev-knapp för att snabbt testa flödet.
   */
  @Get('dev-activate')
  async getDevActivation(@Body() _body: unknown) {
    if (process.env['NODE_ENV'] === 'production') throw new NotFoundException()
    return { message: 'Dev only' }
  }
}

// ── Admin-controller (skyddad) ────────────────────────────────────────────────
// Endpoints som hyresvärden använder för att se/återskicka aktiveringslänkar.
// Skyddas av samma JwtAuthGuard som övriga admin-routes.

@Controller('tenant-portal/admin')
@UseGuards(JwtAuthGuard)
@Roles('OWNER', 'ADMIN', 'MANAGER')
export class TenantPortalAdminController {
  constructor(
    private readonly tenantAuthService: TenantAuthService,
    private readonly prisma: PrismaService,
    private readonly invitations: TenantInvitationsService,
  ) {}

  /**
   * Massinbjudan till portalen. Body: `{ all:true }` (alla aktiva) eller
   * `{ tenantIds:[…] }`. Aktiverade hoppas över; saknad mejl YTAS i svaret
   * (noEmailTenants) i stället för att tyst hoppas över; nyligen inbjudna
   * (<24 h) hoppas över om inte `force`. Ett HTTP-anrop → N köade mejl.
   */
  @Post('invitations')
  @HttpCode(HttpStatus.OK)
  async createInvitations(@Body() dto: InviteTenantsDto, @OrgId() organizationId: string) {
    if (!dto.all && !(dto.tenantIds && dto.tenantIds.length > 0)) {
      throw new BadRequestException('Ange all=true eller en tenantIds-lista')
    }
    return this.invitations.invite(organizationId, {
      ...(dto.all !== undefined ? { all: dto.all } : {}),
      ...(dto.tenantIds ? { tenantIds: dto.tenantIds } : {}),
      ...(dto.force !== undefined ? { force: dto.force } : {}),
    })
  }

  /**
   * Skicka om inbjudan (force) till valda eller alla ej aktiverade.
   */
  @Post('invitations/resend')
  @HttpCode(HttpStatus.OK)
  async resendInvitations(@Body() dto: ResendInvitesDto, @OrgId() organizationId: string) {
    if (!dto.onlyNotActivated && !(dto.tenantIds && dto.tenantIds.length > 0)) {
      throw new BadRequestException('Ange onlyNotActivated=true eller en tenantIds-lista')
    }
    return this.invitations.resend(organizationId, {
      ...(dto.tenantIds ? { tenantIds: dto.tenantIds } : {}),
      ...(dto.onlyNotActivated !== undefined ? { onlyNotActivated: dto.onlyNotActivated } : {}),
    })
  }

  /**
   * Härledd inbjudningsstatus per hyresgäst (för översikt + uppföljning).
   * Query: status (filter), page, pageSize.
   */
  @Get('invitations')
  async listInvitationStatus(
    @OrgId() organizationId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const validStatuses = ['NOT_INVITED', 'NO_EMAIL', 'INVITED', 'ACTIVATED']
    if (status !== undefined && !validStatuses.includes(status)) {
      throw new BadRequestException(`Ogiltig status. Tillåtna: ${validStatuses.join(', ')}`)
    }
    return this.invitations.listStatus(organizationId, {
      ...(status ? { status: status as TenantInviteStatus } : {}),
      ...(page ? { page: parseInt(page, 10) } : {}),
      ...(pageSize ? { pageSize: parseInt(pageSize, 10) } : {}),
    })
  }

  @Get('activation-status/:tenantId')
  async getActivationStatus(@Param('tenantId') tenantId: string, @OrgId() organizationId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, organizationId },
      select: {
        id: true,
        email: true,
        portalActivated: true,
        portalActivatedAt: true,
        activationTokenExpiresAt: true,
        activationReminderSentAt: true,
      },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')

    const hasPendingToken =
      !!tenant.activationTokenExpiresAt && tenant.activationTokenExpiresAt > new Date()

    return {
      tenantId: tenant.id,
      email: tenant.email,
      portalActivated: tenant.portalActivated,
      portalActivatedAt: tenant.portalActivatedAt?.toISOString() ?? null,
      activationTokenExpiresAt: tenant.activationTokenExpiresAt?.toISOString() ?? null,
      activationReminderSentAt: tenant.activationReminderSentAt?.toISOString() ?? null,
      hasPendingActivationLink: hasPendingToken,
    }
  }

  @Post('resend-activation/:tenantId')
  @HttpCode(HttpStatus.OK)
  async resendActivation(@Param('tenantId') tenantId: string, @OrgId() organizationId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, organizationId },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')

    await this.tenantAuthService.sendWelcomeWithContract(tenant.id)
    return { message: 'Aktiveringslänk skickad' }
  }
}

// ── Portal-controller (kräver tenant-session) ─────────────────────────────────

@Controller('portal')
@Public()
@UseGuards(TenantAuthGuard)
export class TenantPortalController {
  constructor(
    private readonly portalService: TenantPortalService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly maintenanceService: MaintenanceService,
    private readonly pdfService: PdfService,
    private readonly aviseringService: AviseringService,
  ) {}

  @Get('me')
  async getMe(@CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } }) {
    return tenant
  }

  @Get('me/export')
  async exportMyData(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.exportTenantData(tenant.id)
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMyAccount(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Body() dto: DeleteAccountDto,
  ): Promise<void> {
    const fresh = await this.prisma.tenant.findUnique({ where: { id: tenant.id } })
    if (!fresh?.passwordHash) {
      throw new UnauthorizedException('Kontot saknar lösenord')
    }
    const valid = await bcrypt.compare(dto.password, fresh.passwordHash)
    if (!valid) throw new UnauthorizedException('Felaktigt lösenord')
    await this.portalService.deleteTenantAccount(tenant.id)
  }

  @Get('dashboard')
  async getDashboard(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.getDashboard(tenant.id)
  }

  @Get('notices')
  async getNotices(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.getNotices(tenant.id)
  }

  @Get('invoices')
  async getInvoices(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.getInvoices(tenant.id)
  }

  /**
   * Hyresavier (RentNotice) — separat tabell från Invoice. Tidigare visades
   * fakturor under "Avier"-fliken eftersom portalen bara hade /portal/invoices.
   */
  @Get('rent-notices')
  async getRentNotices(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.getRentNotices(tenant.id)
  }

  /**
   * Hyresgästens egen förbrukning (IMD). Scope kommer ENBART från @CurrentTenant
   * (tenant-sessionen) — aldrig från query-param. Se getConsumption() i servicen
   * för GDPR-/säkerhetsbesluten (aggregerad charge, fält-allowlist, DRAFT dold).
   */
  @Get('consumption')
  async getConsumption(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.getConsumption(tenant.id)
  }

  /**
   * Streamar faktura-PDF för en faktura som tillhör inloggad hyresgäst.
   * Auth: TenantAuthGuard. Scope: invoice.tenantId måste matcha — annars
   * 404 (vi avslöjar inte att faktura-id existerar i annan org).
   *
   * PDF:en genereras on-demand av PdfService (samma som admin-vyn) och
   * lagras inte i R2 — fakturor är immutabla efter SENT så stale-cache är
   * inte ett problem, men generering är billig nog att inte vara värt
   * cache-komplexiteten just nu.
   */
  @Get('invoices/:id/download')
  async downloadInvoicePdf(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Param('id') invoiceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: tenant.id },
      select: { id: true, organizationId: true, invoiceNumber: true, status: true },
    })
    if (!invoice) throw new NotFoundException('Fakturan hittades inte')
    if (invoice.status === 'DRAFT') {
      throw new NotFoundException('Fakturan är inte publicerad ännu')
    }

    const buffer = await this.pdfService.generateInvoicePdf(invoice.id, invoice.organizationId)
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="faktura-${invoice.invoiceNumber}.pdf"`)
      .header('Content-Length', buffer.length)
      .send(buffer)
  }

  /**
   * Streamar hyresavi-PDF för en avi som tillhör inloggad hyresgäst.
   */
  @Get('rent-notices/:id/download')
  async downloadRentNoticePdf(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Param('id') noticeId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, tenantId: tenant.id },
      select: { id: true, organizationId: true, noticeNumber: true, status: true },
    })
    if (!notice) throw new NotFoundException('Avin hittades inte')
    if (notice.status === 'PENDING' || notice.status === 'CANCELLED') {
      throw new NotFoundException('Avin är inte tillgänglig')
    }

    const buffer = await this.aviseringService.getNoticePdfBuffer(notice.id, notice.organizationId)
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="hyresavi-${notice.noticeNumber}.pdf"`)
      .header('Content-Length', buffer.length)
      .send(buffer)
  }

  @Get('lease')
  async getLease(@CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } }) {
    return this.portalService.getLease(tenant.id)
  }

  @Get('documents')
  async getDocuments(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.getDocuments(tenant.id)
  }

  /**
   * Returnerar en presigned R2-URL till ett dokument som tillhör hyresgästen.
   *
   * Auth: Bearer-session (TenantAuthGuard) — sessionstoken får aldrig ligga
   * i query-string, varken i request-URL eller i den returnerade R2-URL:en
   * (Cloudflare-signaturen ligger där, inte vår tenant-token).
   *
   * Scope: dokumentet måste ha tenantId === inloggad tenant ELLER vara
   * signerat av hyresgästen (signedByTenantId). Andra dokument i org:en
   * — t.ex. interna fastighetspapper — får hyresgästen aldrig se.
   *
   * Faktura-PDF:er exponeras inte via denna endpoint; portalen har en
   * separat avi-vy med inbäddad fakturabild.
   */
  @Get('documents/:id/download')
  async downloadDocument(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Param('id') documentId: string,
  ): Promise<{ url: string; filename: string; mimeType: string }> {
    const doc = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        OR: [{ tenantId: tenant.id }, { signedByTenantId: tenant.id }],
        NOT: { category: 'INVOICE' },
      },
      select: {
        id: true,
        name: true,
        storageKey: true,
        mimeType: true,
      },
    })
    if (!doc) {
      throw new NotFoundException('Dokumentet hittades inte')
    }

    const url = await this.storage.getPresignedUrl(doc.storageKey, 300)
    return { url, filename: `${doc.name}.pdf`, mimeType: doc.mimeType }
  }

  @Get('news')
  async getNews(@CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } }) {
    return this.portalService.getNews(tenant.id)
  }

  @Get('maintenance')
  async getMaintenanceTickets(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
  ) {
    return this.portalService.getMaintenanceTickets(tenant.id)
  }

  @Post('maintenance')
  async submitMaintenance(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Body() dto: SubmitMaintenanceDto,
  ) {
    return this.portalService.submitMaintenanceRequest(tenant.id, dto)
  }

  @Post('maintenance/:id/comment')
  async addMaintenanceComment(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Param('id') ticketId: string,
    @Body() dto: AddCommentDto,
  ) {
    return this.portalService.addMaintenanceComment(tenant.id, ticketId, dto.content)
  }

  /**
   * Ladda upp bilder till en felanmälan. Hyresgästen får bara röra
   * tickets som tillhör denne — vi verifierar ägarskap här innan vi
   * delegerar till MaintenanceService.addImages.
   */
  @Post('maintenance/:id/images')
  async uploadMaintenanceImages(
    @CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } },
    @Param('id') ticketId: string,
    @Req() req: FastifyRequest,
  ) {
    const owns = await this.prisma.maintenanceTicket.findFirst({
      where: { id: ticketId, tenantId: tenant.id },
      select: { id: true },
    })
    if (!owns) throw new NotFoundException('Ärende hittades inte')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reqAny = req as any
    if (typeof reqAny.parts !== 'function') {
      throw new BadRequestException('Multipart-data förväntas')
    }

    // OBS: @fastify/multipart håller varje fil-stream öppen ENBART under
    // iterator-steget. Om vi sparar `part.toBuffer` och anropar den senare
    // har streamen redan stängts och vi får TypeError på `Symbol.asyncIterator`.
    // Därför drar vi varje fil till buffer redan här inne i loopen, och
    // skickar färdiga buffers till service-lagret.
    const files: { filename: string; mimetype: string; buffer: Buffer }[] = []
    for await (const part of reqAny.parts() as AsyncIterable<{
      type: 'file' | 'field'
      filename?: string
      mimetype?: string
      toBuffer?: () => Promise<Buffer>
    }>) {
      if (part.type === 'file' && part.toBuffer) {
        const buffer = await part.toBuffer()
        files.push({
          filename: part.filename ?? 'upload.jpg',
          mimetype: part.mimetype ?? 'application/octet-stream',
          buffer,
        })
      }
    }
    if (!files.length) throw new BadRequestException('Inga bilder bifogade')

    return this.maintenanceService.addImages(ticketId, files)
  }
}
