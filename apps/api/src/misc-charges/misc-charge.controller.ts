import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common'
import type { MiscChargeStatus } from '@prisma/client'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { MiscChargeService } from './misc-charge.service'
import { CreateMiscChargeDto } from './dto/create-misc-charge.dto'

// Teknisk förvaltning · Spår A — hyresvärds-sidan. Muterande endpoints
// (skapa/bokför/annullera, PR 3) + läs-endpoints (PR 4). ALLA rollskyddade
// MANAGER+ — confirm/cancel får aldrig vara öppna (security-auditor). Hyresgäst-
// vy/portal är PR 5 (egen, IDOR-tätad väg).
@Controller('misc-charges')
@UseGuards(JwtAuthGuard)
export class MiscChargeController {
  constructor(private readonly miscCharges: MiscChargeService) {}

  // Lista — filter: status, leaseId, sourceRefId (ärendets id). PR 4: knappen på
  // ett ärende hämtar postens status via ?sourceRefId={ticketId}.
  @Get()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async list(
    @OrgId() organizationId: string,
    @Query('status') status?: MiscChargeStatus,
    @Query('leaseId') leaseId?: string,
    @Query('sourceRefId') sourceRefId?: string,
  ) {
    return this.miscCharges.findMiscCharges(organizationId, {
      ...(status ? { status } : {}),
      ...(leaseId ? { leaseId } : {}),
      ...(sourceRefId ? { sourceRefId } : {}),
    })
  }

  @Get(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async detail(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.miscCharges.findMiscCharge(id, organizationId)
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async create(@OrgId() organizationId: string, @Body() dto: CreateMiscChargeDto) {
    return this.miscCharges.createMiscCharge(dto, organizationId)
  }

  @Post(':id/confirm')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async confirm(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.miscCharges.confirmMiscCharge(id, organizationId, user.sub)
  }

  @Post(':id/cancel')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async cancel(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.miscCharges.cancelMiscCharge(id, organizationId, user.sub)
  }
}
