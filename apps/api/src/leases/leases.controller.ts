import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  UseGuards,
} from '@nestjs/common'
import type { LeaseStatus } from '@prisma/client'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { LeasesService } from './leases.service'
import { AviseringService } from '../avisering/avisering.service'
import { CreateLeaseDto } from './dto/create-lease.dto'
import { UpdateLeaseDto } from './dto/update-lease.dto'
import { TransitionLeaseStatusDto } from './dto/transition-status.dto'
import { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'
import { TerminateLeaseDto } from './dto/terminate-lease.dto'
import { RenewLeaseDto } from './dto/renew-lease.dto'

@Controller('leases')
@UseGuards(JwtAuthGuard)
export class LeasesController {
  constructor(
    private readonly leasesService: LeasesService,
    private readonly avisering: AviseringService,
  ) {}

  @Get()
  async findAll(@OrgId() organizationId: string) {
    return this.leasesService.findAll(organizationId)
  }

  // T5 C2b (#58) — skapa aktiveringens avier manuellt när köandet fallerade.
  // MÅSTE ligga före @Get(':id')/@Patch(':id') så rutten inte fångas av dem.
  //
  // Rollkravet upprepas i tjänsten (fail-closed chokepunkt, #194-mönstret) —
  // dekoratorn här är bekvämlighet, inte skyddet. Samma roller som
  // transitionStatus, eftersom aktiveringen skapar exakt samma avier: att grinda
  // hårdare vore teater när samma effekt nås genom att aktivera kontraktet.
  @Post(':id/initial-notices')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @HttpCode(200)
  async createInitialNotices(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.avisering.retriggerInitialNotices(id, organizationId, { actorRole: user.role })
  }

  // Must be before @Post() to avoid route conflict
  @Post('with-tenant')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async createWithTenant(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateLeaseWithTenantDto,
  ) {
    return this.leasesService.createWithTenant(dto, organizationId, user.sub)
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async create(@OrgId() organizationId: string, @Body() dto: CreateLeaseDto) {
    return this.leasesService.create(dto, organizationId)
  }

  // MUST be before /:id to avoid route conflict
  @Patch(':id/status')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async transitionStatus(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: TransitionLeaseStatusDto,
  ) {
    return this.leasesService.transitionStatus(
      id,
      dto.status as LeaseStatus,
      organizationId,
      user.sub,
    )
  }

  @Patch(':id/terminate')
  @Roles('ADMIN', 'OWNER')
  async terminate(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: TerminateLeaseDto,
  ) {
    return this.leasesService.terminate(id, dto, organizationId)
  }

  @Patch(':id/renew')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async renew(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: RenewLeaseDto,
  ) {
    return this.leasesService.renew(id, dto, organizationId)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.leasesService.findOne(id, organizationId)
  }

  @Patch(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateLeaseDto,
  ) {
    return this.leasesService.update(id, dto, organizationId)
  }

  @Delete(':id')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(204)
  async remove(@Param('id') id: string, @OrgId() organizationId: string): Promise<void> {
    await this.leasesService.remove(id, organizationId)
  }
}
