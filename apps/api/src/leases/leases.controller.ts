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
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { LeasesService } from './leases.service'
import { CreateLeaseDto } from './dto/create-lease.dto'
import { UpdateLeaseDto } from './dto/update-lease.dto'
import { TransitionLeaseStatusDto } from './dto/transition-status.dto'
import { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'
import { TerminateLeaseDto } from './dto/terminate-lease.dto'
import { RenewLeaseDto } from './dto/renew-lease.dto'

@Controller('leases')
@UseGuards(JwtAuthGuard)
export class LeasesController {
  constructor(private readonly leasesService: LeasesService) {}

  @Get()
  async findAll(@OrgId() organizationId: string) {
    return this.leasesService.findAll(organizationId)
  }

  // Must be before @Post() to avoid route conflict
  @Post('with-tenant')
  async createWithTenant(@OrgId() organizationId: string, @Body() dto: CreateLeaseWithTenantDto) {
    return this.leasesService.createWithTenant(dto, organizationId)
  }

  @Post()
  async create(@OrgId() organizationId: string, @Body() dto: CreateLeaseDto) {
    return this.leasesService.create(dto, organizationId)
  }

  // MUST be before /:id to avoid route conflict
  @Patch(':id/status')
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
  async terminate(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: TerminateLeaseDto,
  ) {
    return this.leasesService.terminate(id, dto, organizationId)
  }

  @Patch(':id/renew')
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
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateLeaseDto,
  ) {
    return this.leasesService.update(id, dto, organizationId)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @OrgId() organizationId: string): Promise<void> {
    await this.leasesService.remove(id, organizationId)
  }
}
