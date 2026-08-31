import { Controller, Get, Param, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { TenantHistoryService } from './tenant-history.service'

@Controller('history')
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly history: TenantHistoryService) {}

  /**
   * En hyresgästs samlade historik — allt som rör personen, över alla avtal
   * och objekt. Scopad på `organizationId` ur JWT som allt annat.
   */
  @Get('tenants/:tenantId')
  async tenantHistory(
    @Param('tenantId') tenantId: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    // Rollen går in i sammanställningen, inte bara i en grind före den: två av
    // källorna har en snävare behörighet än den här endpointen. Se registret.
    return this.history.forTenant(organizationId, tenantId, user.role)
  }
}
