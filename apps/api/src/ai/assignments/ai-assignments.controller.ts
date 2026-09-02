import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common'

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { RolesGuard } from '../../common/guards/roles.guard'
import { OrgId } from '../../common/decorators/org-id.decorator'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { AiAssignmentsService } from './ai-assignments.service'
import { DecideAssignmentDto } from './dto/decide-assignment.dto'
import { QueryAssignmentsDto } from './dto/query-assignments.dto'

import type { JwtPayload } from '@eken/shared'

/**
 * LÄSYTANS API — och det finns inget `POST`.
 *
 * Uppdrag SKAPAS inte över HTTP. Producenten är agenten (etapp 8–9) och anropar
 * tjänsten direkt. En publik skapande-endpoint hade varit en väg för en
 * inloggad människa att lägga arbete i sin egen kö, vilket ingen bett om — och
 * varje endpoint som finns är en yta som måste försvaras.
 *
 * VIEWER är utelämnad: att godkänna ett uppdrag är att fatta ett bindande
 * beslut, och observatörsrollen fattar inga sådana. ACCOUNTANT likaså — rollen
 * läser räkenskaper, den driver inte förvaltningen.
 */
@Controller('ai/assignments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN', 'MANAGER')
export class AiAssignmentsController {
  constructor(private readonly service: AiAssignmentsService) {}

  @Get()
  async list(@OrgId() organizationId: string, @Query() query: QueryAssignmentsDto) {
    return this.service.lista(organizationId, query.status)
  }

  @Patch(':id/decision')
  async decide(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: DecideAssignmentDto,
  ) {
    return this.service.besluta(organizationId, id, user.sub, body.decision, body.reason)
  }
}
