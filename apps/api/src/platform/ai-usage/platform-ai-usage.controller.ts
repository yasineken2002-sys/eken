import { ChangePlanDto } from './dto/change-plan.dto'
import { AddCreditsDto } from './dto/add-credits.dto'
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { PlatformAiUsageService } from './platform-ai-usage.service'

@ApiTags('Platform / AI-usage')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/ai-usage')
export class PlatformAiUsageController {
  constructor(private readonly svc: PlatformAiUsageService) {}

  @Get()
  @ApiOperation({ summary: 'Lista AI-användning per organisation' })
  list(
    @Query('overEightyPct') overEightyPct?: string,
    @Query('overOneHundredPct') overOneHundredPct?: string,
    @Query('trialEndingSoon') trialEndingSoon?: string,
    @Query('highCostUsd') highCostUsd?: string,
  ) {
    return this.svc.list({
      overEightyPct: overEightyPct === 'true',
      overOneHundredPct: overOneHundredPct === 'true',
      trialEndingSoon: trialEndingSoon === 'true',
      ...(highCostUsd ? { highCostUsd: Number(highCostUsd) } : {}),
    })
  }

  @Get('kpis')
  @ApiOperation({ summary: 'Översikts-KPI:er för plattforms-AI-användning' })
  kpis() {
    return this.svc.kpis()
  }

  @Post(':id/credits')
  @ApiOperation({ summary: 'Lägg till AI-credits manuellt' })
  addCredits(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCreditsDto) {
    return this.svc.addCredits(id, dto.amount, dto.note)
  }

  @Post(':id/plan')
  @ApiOperation({ summary: 'Byt plan manuellt' })
  changePlan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangePlanDto) {
    return this.svc.changePlan(id, dto.plan)
  }
}
