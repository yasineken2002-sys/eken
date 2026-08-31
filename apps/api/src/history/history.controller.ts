import { Controller, Get, Param, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { HistoryService } from './history.service'
import { GapsService } from './gaps.service'

@Controller('history')
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(
    private readonly history: HistoryService,
    private readonly gaps: GapsService,
  ) {}

  /**
   * En hyresgästs samlade historik — allt som rör personen, över alla avtal
   * och objekt. Scopad på `organizationId` ur JWT som allt annat.
   *
   * Rollen går in i sammanställningen, inte bara i en grind före den: källor
   * med snävare behörighet än den här endpointen filtreras per roll. Se
   * `restrictedToRoles` i registret.
   */
  @Get('tenants/:tenantId')
  async tenantHistory(
    @Param('tenantId') tenantId: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.history.forTenant(organizationId, tenantId, user.role)
  }

  /**
   * Lägenhetens historik — allt som rört objektet, över alla hyresgäster,
   * även tidigare. Identiteter bärs som id-referenser; inga personfält ur
   * `Tenant` läses av någon källa, och anonymisering slår igenom automatiskt
   * eftersom sammanställningen sker vid läsning. Se registrets docblock.
   */
  @Get('units/:unitId')
  async unitHistory(
    @Param('unitId') unitId: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.history.forUnit(organizationId, unitId, user.role)
  }

  /** Fastighetens historik — det direkt fastighetsknutna. Se ack-filens `units`-post. */
  @Get('properties/:propertyId')
  async propertyHistory(
    @Param('propertyId') propertyId: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.history.forProperty(organizationId, propertyId, user.role)
  }

  /**
   * Luckorna — beräknade, aldrig lagrade. Svaret bär VARJE förväntan,
   * inklusive de odefinierade: en tom lista skulle inte gå att skilja från
   * "vi vet inte vad som borde ha hänt".
   */
  @Get('tenants/:tenantId/gaps')
  async tenantGaps(@Param('tenantId') tenantId: string, @OrgId() organizationId: string) {
    return this.gaps.forTenant(organizationId, tenantId)
  }

  @Get('units/:unitId/gaps')
  async unitGaps(@Param('unitId') unitId: string, @OrgId() organizationId: string) {
    return this.gaps.forUnit(organizationId, unitId)
  }

  @Get('properties/:propertyId/gaps')
  async propertyGaps(@Param('propertyId') propertyId: string, @OrgId() organizationId: string) {
    return this.gaps.forProperty(organizationId, propertyId)
  }
}
