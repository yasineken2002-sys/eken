import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { MiscChargeService } from './misc-charge.service'
import { CreateMiscChargeDto } from './dto/create-misc-charge.dto'

// Teknisk förvaltning · Spår A PR 3 — hyresvärds-sidan. Endast muterande
// endpoints (skapa/bokför/annullera), alla rollskyddade. Inga GET:ar (hyresgäst-
// vy är PR 5). confirm/cancel får ALDRIG vara öppna (security-auditor).
@Controller('misc-charges')
@UseGuards(JwtAuthGuard)
export class MiscChargeController {
  constructor(private readonly miscCharges: MiscChargeService) {}

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
