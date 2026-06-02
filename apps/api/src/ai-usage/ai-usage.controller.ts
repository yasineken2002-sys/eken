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

  /** Aktuell tak-status för progress-bar + KPI-kort i Plan-sidan. */
  @Get('current')
  current(@OrgId() organizationId: string) {
    return this.service.current(organizationId)
  }

  /** Daglig användning som grafdata. days=30 default. */
  @Get('history')
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
