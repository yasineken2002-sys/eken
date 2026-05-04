import {
  Controller,
  Delete,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { Throttle } from '@nestjs/throttler'
import { IsEmail, IsString, IsOptional, IsEnum, IsUUID, MinLength } from 'class-validator'
import { MaintenanceCategory } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import { Public } from '../common/decorators/public.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { PrismaService } from '../common/prisma/prisma.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantPortalService } from './tenant-portal.service'
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

  @Post('activate')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async activate(@Body() dto: ActivateDto, @Req() req: FastifyRequest) {
    const ip = req.ip ?? null
    const userAgent = req.headers['user-agent'] ?? null
    const result = await this.tenantAuthService.activate(dto.token, dto.password, {
      ip,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
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
  ) {}

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
}
