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
import type { LeasesService } from './leases.service'
import type { CreateLeaseDto } from './dto/create-lease.dto'
import type { UpdateLeaseDto } from './dto/update-lease.dto'
import type { TransitionLeaseStatusDto } from './dto/transition-status.dto'
import type { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'

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
    @Body() dto: TransitionLeaseStatusDto,
  ) {
    return this.leasesService.transitionStatus(id, dto.status as LeaseStatus, organizationId)
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
