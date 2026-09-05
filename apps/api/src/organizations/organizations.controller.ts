import { Controller, Get, Patch, Body, BadRequestException, UseGuards, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrganizationsService } from './organizations.service'
import { UpdateOrganizationDto } from './dto/update-organization.dto'

import type { JwtPayload } from '@eken/shared'

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('me')
  async findMyOrganization(@OrgId() organizationId: string) {
    return this.organizationsService.findMyOrganization(organizationId)
  }

  /**
   * Rutten är ADMIN + OWNER — och ETT fält i den är OWNER-only.
   *
   * `@Roles` kan bara grinda hela rutten. Att smalna den till OWNER hade tagit
   * bankgiro och fakturafärg ifrån varje admin; att lämna den öppen hade låtit
   * en admin slå på en agent. Rollen skickas därför VIDARE till tjänsten, som
   * äger fältnivågrinden — se `FAR_SLA_PA_SKUGGAGENT` där.
   */
  @Patch('me')
  @Roles('ADMIN', 'OWNER')
  async update(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(organizationId, dto, user.role)
  }

  @Patch('me/logo')
  @Roles('ADMIN', 'OWNER')
  async uploadLogo(@OrgId() organizationId: string, @Req() req: FastifyRequest) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = await (req as any).file()
    if (!file) throw new BadRequestException('Ingen fil bifogad')

    // Typ och storlek grindas i servicen, på filens FAKTISKA innehåll.
    //
    // Kontrollerna som stod här var två attrapper: allowlisten läste
    // `file.mimetype` (en header klienten sätter själv) och storlekskollen läste
    // `file.file.bytesRead` INNAN strömmen konsumerats — alltså i praktiken 0.
    // Att flytta dem till servicen, efter buffringen, gör dem verkliga.
    return this.organizationsService.uploadLogo(organizationId, file)
  }
}
