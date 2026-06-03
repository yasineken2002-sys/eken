import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common'
import type { TerminationRequestStatus } from '@prisma/client'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import type { JwtPayload } from '@eken/shared'
import { TerminationsService } from './terminations.service'
import { ApproveTerminationDto } from './dto/approve-termination.dto'
import { RejectTerminationDto } from './dto/reject-termination.dto'

@Controller('terminations')
@UseGuards(JwtAuthGuard)
export class TerminationsController {
  constructor(private readonly service: TerminationsService) {}

  @Get()
  async findAll(@OrgId() organizationId: string, @Query('status') status?: string) {
    const filters: { status?: TerminationRequestStatus } = {}
    if (status) filters.status = status as TerminationRequestStatus
    return this.service.findAll(organizationId, filters)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.service.findOne(id, organizationId)
  }

  // Godkännande = en kontraktsterminering → samma rollkrav som
  // leases/:id/terminate (ADMIN/OWNER).
  @Patch(':id/approve')
  @Roles('ADMIN', 'OWNER')
  async approve(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ApproveTerminationDto,
  ) {
    return this.service.approve(id, organizationId, user.sub, dto)
  }

  @Patch(':id/reject')
  @Roles('ADMIN', 'OWNER')
  async reject(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RejectTerminationDto,
  ) {
    return this.service.reject(id, organizationId, user.sub, dto)
  }
}
