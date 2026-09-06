import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'

import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard'
import { OrgId } from '../../common/decorators/org-id.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { CreateFromAssignmentDto } from './dto/create-from-assignment.dto'
import { RevokeDelegationDto } from './dto/revoke-delegation.dto'
import { DelegationService } from './delegation.service'
import { UTFÖRARE_FINNS } from './delegation-birth'

import type { JwtPayload } from '@eken/shared'

/**
 * DELEGATIONERNAS API (G2, etapp 7).
 *
 * ── ALLT ÄR OWNER, OCH GRINDEN LIGGER PÅ BÅDA STÄLLENA ──────────────────────
 *
 * `@Roles('OWNER')` på rutten OCH `FAR_DELEGERA` i tjänsten. Det är inte en
 * dubblering av misstag: rutten skyddar HTTP-vägen, tjänsten skyddar varje
 * anropare — och den dag en agentväg eller ett cronjobb vill skapa en delegation
 * går den förbi controllern men inte förbi tjänsten.
 *
 * Till skillnad från `PATCH /organizations/me`, där rutten måste förbli ADMIN
 * för de andra fälten, finns här inget att bevara: HELA ytan är ägarens.
 */
@Controller('agent/delegations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER')
export class DelegationController {
  constructor(private readonly service: DelegationService) {}

  /**
   * Kan förslaget bli en delegation, och vad blir i så fall villkoret?
   *
   * Läsytans fråga. Knappen är grå tills svaret är ja — men det är en artighet:
   * `POST` nedan prövar samma villkor på nytt.
   */
  @Get('can-create/:assignmentId')
  async canCreate(@OrgId() organizationId: string, @Param('assignmentId') assignmentId: string) {
    const r = await this.service.kanBliDelegation(organizationId, assignmentId)
    // Meningen om utföraren läses ur en KONSTANT och inte ur prosa i webben.
    // Den dag utföraren byggs sätts flaggan i samma PR, och texten försvinner av
    // sig själv i stället för att bli en osanning i det enda gränssnitt
    // hyresvärden har för att förstå vad hen ger bort.
    return { ...r, utförareFinns: UTFÖRARE_FINNS }
  }

  /** "Gör alltid så här." Den enda vägen till en delegation med ursprung. */
  @Post('from-assignment/:assignmentId')
  async createFromAssignment(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('assignmentId') assignmentId: string,
    @Body() body: CreateFromAssignmentDto,
  ) {
    return this.service.skapaUrFörslag(
      organizationId,
      assignmentId,
      { userId: user.sub, roll: user.role },
      {
        ...(body.villkor ? { villkor: body.villkor } : {}),
        ...(body.frekvensvillkor ? { frekvensvillkor: body.frekvensvillkor } : {}),
      },
    )
  }

  /**
   * Organisationens delegationer.
   *
   * Statusen är BERÄKNAD ur händelserna, aldrig läst ur en kolumn — samma regel
   * som skulden i inkassotrappan. En pausad delegation är pausad därför att den
   * senaste händelsen säger det, inte därför att någon kom ihåg att sätta en
   * flagga.
   */
  @Get()
  async lista(@OrgId() organizationId: string) {
    return this.service.lista(organizationId)
  }

  /** Återkalla. Slutgiltigt — en återkallad delegation går inte att väcka. */
  @Post(':id/revoke')
  async revoke(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: RevokeDelegationDto,
  ) {
    await this.service.återkalla(
      organizationId,
      id,
      { userId: user.sub, roll: user.role },
      body.skäl,
    )
    return { ok: true }
  }

  /** Pausa. Reversibelt, till skillnad från återkallandet. */
  @Post(':id/pause')
  async pause(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.service.pausa(organizationId, id, { userId: user.sub, roll: user.role })
    return { ok: true }
  }

  /** Återuppta en pausad delegation. */
  @Post(':id/resume')
  async resume(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.service.återuppta(organizationId, id, { userId: user.sub, roll: user.role })
    return { ok: true }
  }

  /** Förläng 90 dagar. Högst en gång per 30 dagar — se tjänsten. */
  @Post(':id/extend')
  async extend(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const expiresAt = await this.service.förläng(organizationId, id, {
      userId: user.sub,
      roll: user.role,
    })
    return { expiresAt }
  }
}
