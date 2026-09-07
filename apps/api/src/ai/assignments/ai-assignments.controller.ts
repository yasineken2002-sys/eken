import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { RolesGuard } from '../../common/guards/roles.guard'
import { OrgId } from '../../common/decorators/org-id.decorator'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { AiAssignmentsService } from './ai-assignments.service'
import { DecideAssignmentDto } from './dto/decide-assignment.dto'
import { QueryAssignmentsDto } from './dto/query-assignments.dto'
import { AnswerQuestionDto } from './dto/answer-question.dto'
import { RequestUndoDto } from './dto/request-undo.dto'
import { QuestionService } from '../questions/question.service'

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
  constructor(
    private readonly service: AiAssignmentsService,
    private readonly questions: QuestionService,
  ) {}

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
  /**
   * "GJORT" — de utförda åtgärderna, med ångravägen per rad.
   *
   * EGEN RUTT och inte ett filter på `GET /` av samma skäl som metoden är egen:
   * svaret bär andra fält (spår, delegation, ångraväg), och att smyga in dem i
   * listsvaret hade tvingat varje väntande rad att beräkna en ångraväg den inte
   * har.
   *
   * FÖRE `:id` i filen, annars fångar den dynamiska rutten "gjorda" som ett id.
   */
  @Get('gjorda')
  async gjorda(@OrgId() organizationId: string, @Query() query: QueryAssignmentsDto) {
    return this.service.gjorda(organizationId, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    })
  }

  @Get(':id')
  async detail(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.service.hamta(organizationId, id)
  }

  /**
   * SVARA PÅ EN FRÅGA (etapp 8 PR 5b).
   *
   * Egen endpoint och inte `:id/decision`: ett beslut är ja eller nej, ett svar
   * är ETT VÄRDE ur en mängd. Att trycka in det i beslutsvägen hade krävt att
   * `statusReason` bar två olika saker beroende på radens `kind` — och då kan
   * ingen fråga svaras utan att först veta vilken sorts rad det är.
   */
  @Post(':id/answer')
  async answer(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: AnswerQuestionDto,
  ) {
    await this.questions.svara(organizationId, id, user.sub, body.svar)
    return { ok: true }
  }

  /**
   * ÅNGRA — en HÄNDELSE, inte en backning.
   *
   * `@Roles` är samma som resten av inkorgen: den som får besluta om ett uppdrag
   * får också säga att det blev fel. Att kräva OWNER här hade gjort det svårare
   * att säga ifrån än att låta bli, vilket är fel håll.
   */
  @Post(':id/undo')
  async undo(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RequestUndoDto,
  ) {
    return this.service.begärÅngra(organizationId, id, { userId: user.sub }, dto.note)
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
