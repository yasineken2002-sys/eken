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
  Req,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { TenantsService } from './tenants.service'
import { CreateTenantDto } from './dto/create-tenant.dto'
import { UpdateTenantDto } from './dto/update-tenant.dto'
import { AnonymizeTenantDto } from './dto/anonymize-tenant.dto'
import type { JwtPayload } from '@eken/shared'

@Controller('tenants')
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  async findAll(@OrgId() organizationId: string, @Query('search') search?: string) {
    return this.tenantsService.findAll(organizationId, search)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.tenantsService.findOne(id, organizationId)
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async create(@OrgId() organizationId: string, @Body() dto: CreateTenantDto) {
    return this.tenantsService.create(dto, organizationId)
  }

  @Patch(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenantsService.update(id, dto, organizationId)
  }

  @Delete(':id')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(204)
  async remove(@Param('id') id: string, @OrgId() organizationId: string): Promise<void> {
    await this.tenantsService.remove(id, organizationId)
  }

  /**
   * Verkställ en raderingsbegäran (GDPR Art. 17) å hyresgästens vägnar.
   *
   * ── VARFÖR OWNER OCH INTE ADMIN ───────────────────────────────────────────
   *
   * Rollen är mätt mot jämförbara operationer, inte vald på känsla. Den enda
   * strukturellt likartade operationen i kodbasen är `users.deactivate`: verbet
   * ser destruktivt ut men operationen är MJUK, den är oåterkallelig i praktiken,
   * och den återkallar sessioner i samma transaktion. Den kräver **OWNER**, och
   * är den strängaste grinden som finns här.
   *
   * Övriga raderingar (`tenants.remove`, avtal, fakturor, fastigheter) ligger på
   * ADMIN+OWNER, men de tar bort en post. Den här tar bort en PERSONS uppgifter
   * ur ett underlag som måste bevaras, och den går inte att ångra — det finns
   * inget att återställa ifrån.
   *
   * POST och inte DELETE: resursen försvinner inte, den ändrar tillstånd.
   */
  @Post(':id/anonymize')
  @Roles('OWNER')
  async anonymize(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() current: JwtPayload,
    @Body() dto: AnonymizeTenantDto,
    @Req() req: FastifyRequest,
  ) {
    const ipAddress = req.ip
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? undefined
    return this.tenantsService.anonymize(id, organizationId, {
      performedById: current.sub,
      ...(ipAddress ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(dto.reason ? { reason: dto.reason } : {}),
    })
  }
}
