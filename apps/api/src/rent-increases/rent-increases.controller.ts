import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type { RentIncreaseStatus } from '@prisma/client'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RentIncreasesService } from './rent-increases.service'
import { CreateRentIncreaseDto } from './dto/create-rent-increase.dto'
import { RejectRentIncreaseDto } from './dto/reject-rent-increase.dto'

@Controller('rent-increases')
@UseGuards(JwtAuthGuard)
export class RentIncreasesController {
  constructor(private readonly service: RentIncreasesService) {}

  @Get()
  async findAll(
    @OrgId() organizationId: string,
    @Query('status') status?: string,
    @Query('leaseId') leaseId?: string,
  ) {
    const filters: { status?: RentIncreaseStatus; leaseId?: string } = {}
    if (status) filters.status = status as RentIncreaseStatus
    if (leaseId) filters.leaseId = leaseId
    return this.service.findAll(organizationId, filters)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.service.findOne(id, organizationId)
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async create(@OrgId() organizationId: string, @Body() dto: CreateRentIncreaseDto) {
    return this.service.create(dto, organizationId)
  }

  @Post(':id/send-notice')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async sendNotice(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.service.sendNotice(id, organizationId)
  }

  @Patch(':id/accept')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async accept(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.service.accept(id, organizationId)
  }

  @Patch(':id/reject')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async reject(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: RejectRentIncreaseDto,
  ) {
    return this.service.reject(id, dto, organizationId)
  }

  @Patch(':id/withdraw')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async withdraw(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.service.withdraw(id, organizationId)
  }
}
