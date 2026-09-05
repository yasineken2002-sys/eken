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
    return this.service.lista(organizationId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.shadow === undefined ? {} : { shadow: query.shadow === 'true' }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    })
  }

  /**
   * KPI-korten. Egen endpoint och inte ett fält på listan, därför att listan är
   * SIDINDELAD: en sammanfattning som räknade sidans rader hade visat "3
   * väntande" om en inkorg med trettio.
   */
  @Get('summary')
  async summary(@OrgId() organizationId: string, @Query() query: QueryAssignmentsDto) {
    return this.service.sammanfattning(
      organizationId,
      query.shadow === undefined ? undefined : query.shadow === 'true',
    )
  }

  /**
   * DETALJEN — planens fem: vad · varför · vilken information · hur säker · vad
   * som hade krävt godkännande.
   *
   * `:id` deklareras EFTER `summary`, annars fångar den strängen "summary" som
   * ett id och svarar 404 på KPI-anropet. Fastify matchar i deklarationsordning.
   */
  @Get(':id')
  async detail(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.service.hamta(organizationId, id)
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
