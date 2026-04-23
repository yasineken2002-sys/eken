import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common'
import { IsEmail, IsString, IsOptional, IsEnum, MinLength } from 'class-validator'
import * as crypto from 'crypto'
import { MaintenanceCategory } from '@prisma/client'
import { Public } from '../common/decorators/public.decorator'
import { PrismaService } from '../common/prisma/prisma.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantPortalService } from './tenant-portal.service'
import { TenantAuthGuard } from './tenant-auth.guard'
import { CurrentTenant } from './current-tenant.decorator'
import type { Tenant } from '@prisma/client'

class MagicLinkDto {
  @IsEmail()
  email!: string
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

@Controller('portal/auth')
@Public()
export class TenantAuthController {
  constructor(
    private readonly tenantAuthService: TenantAuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('magic-link')
  @HttpCode(HttpStatus.OK)
  async sendMagicLink(@Body() dto: MagicLinkDto): Promise<null> {
    await this.tenantAuthService.sendMagicLink(dto.email)
    return null
  }

  @Get('verify')
  async verifyMagicLink(@Query('token') token: string) {
    const { sessionToken, tenant } = await this.tenantAuthService.verifyMagicLink(token)
    return {
      sessionToken,
      tenant: {
        id: tenant.id,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        email: tenant.email,
      },
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

  @Get('dev-link')
  async getDevLink(@Query('email') email: string) {
    if (process.env['NODE_ENV'] === 'production') throw new NotFoundException()

    const tenant = await this.prisma.tenant.findFirst({ where: { email } })
    if (!tenant) return { message: 'Ingen hyresgäst hittades' }

    const token = crypto.randomBytes(32).toString('hex')
    await this.prisma.tenantMagicLink.create({
      data: {
        tenantId: tenant.id,
        token,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })

    const portalUrl = process.env['PORTAL_URL'] ?? 'http://localhost:5174'
    return {
      url: `${portalUrl}/auth/verify?token=${token}`,
      token,
      tenant: { email: tenant.email, name: tenant.firstName },
    }
  }
}

@Controller('portal')
@Public()
@UseGuards(TenantAuthGuard)
export class TenantPortalController {
  constructor(private readonly portalService: TenantPortalService) {}

  @Get('me')
  async getMe(@CurrentTenant() tenant: Tenant & { organization: { id: string; name: string } }) {
    return tenant
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
