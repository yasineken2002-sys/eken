import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { AiUsagePageService } from './ai-usage.service'
import { BuyCreditsDto } from './dto/buy-credits.dto'

@ApiTags('ai-usage')
@ApiBearerAuth()
@Controller('ai-usage')
@UseGuards(JwtAuthGuard)
export class AiUsageController {
  constructor(private readonly service: AiUsagePageService) {}

  // ── Prenumerationsdata: ACCOUNTANT, ADMIN, OWNER (#441) ────────────────────
  //
  // Svaret bär organisationens prenumerationsförhållande: `subscriptionPlan`,
  // `planMonthlyFee`, `aiCreditsBalance`, `trialEndsAt`, `status`. Utan raden
  // ärvde endpointen bara det globala JwtAuthGuard och låg öppen för VIEWER.
  //
  // Det här är INTE #81:s form — defekten var inte att spåret av en handling låg
  // öppet, utan att ett kommersiellt förhållande gjorde det. Kostnaden för vad
  // bolaget betalar har bokföraren yrkesmässig del i (den ska konteras);
  // förvaltaren och den läsande rollen har det inte. Därför snävare än #440:s
  // enhetliga ACCOUNTANT+: MANAGER ingår inte.
  //
  // Fyra ytor bar samma fältblock och ingen av dem ägde det — den här,
  // `history` nedan, `GET /ai/usage(/breakdown)` och `GET /organizations/me`.
  // Att grinda en av dem hade varit verkningslöst; alla fyra åtgärdas i samma PR.
  // Org-raden kan inte grindas (namn och logotyp behövs överallt), så där sitter
  // gränsen på fälten i stället — se organizations/organization-select.ts.
  //
  // Konsekvens: Plan-fliken i Inställningar 403:ar för MANAGER och VIEWER. Rätt
  // utfall — planhantering är ADMIN/OWNER — men med `retry: 1` blir det en tyst
  // trasig panel snarare än ett nekande. Ytan är anmäld till #442.
  //
  // Prövat och avfärdat: skulle `trialEndsAt`/`status` räknas som DRIFTdata som
  // varje roll behöver? Nej. Mätt 2026-08-14: ingen yta i web läser dem utanför
  // PlanPanel — ingen global banner, ingen route-grind — och en SUSPENDED org
  // stoppas server-side i ai-quota.service.ts, inte genom att UI:t läser status.
  // Blocket följer alltså rollistan i sin helhet.
  /** Aktuell tak-status för progress-bar + KPI-kort i Plan-sidan. */
  @Get('current')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  current(@OrgId() organizationId: string) {
    return this.service.current(organizationId)
  }

  // Samma rollista som `current` ovan, och av samma skäl — men notera att svaret
  // här bär `costUsd` per dag, alltså faktisk AI-kostnad över tid. Rollistan: se
  // noten på `current`.
  /** Daglig användning som grafdata. days=30 default. */
  @Get('history')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  history(@OrgId() organizationId: string, @Query('days') days?: string) {
    const parsed = Number(days ?? 30)
    return this.service.history(organizationId, Number.isFinite(parsed) ? parsed : 30)
  }

  /**
   * Skapar en pending plattformsfaktura för köp av extra AI-credits.
   * Yasin markerar betald manuellt och lägger då till credits på org.
   *
   * C2: köp som skapar en faktura/kostnad begränsas till ADMIN och uppåt —
   * samma nivå som organisationsinställningar. Tidigare oskyddad → VIEWER kunde
   * trigga köp. GET current/history lämnas öppna (ren lässtatistik).
   */
  @Post('buy-credits')
  @Roles('ADMIN', 'OWNER')
  buyCredits(@OrgId() organizationId: string, @Body() dto: BuyCreditsDto) {
    return this.service.buyCredits(organizationId, dto.amount)
  }
}
