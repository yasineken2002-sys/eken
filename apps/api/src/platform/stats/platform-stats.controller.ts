import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { PlatformStatsService } from './platform-stats.service'

@ApiTags('Platform / Stats')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/stats')
export class PlatformStatsController {
  constructor(private readonly svc: PlatformStatsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'KPI-översikt' })
  overview() {
    return this.svc.overview()
  }

  @Get('growth')
  @ApiOperation({ summary: 'Tillväxt över tid' })
  growth(@Query('period') period?: string) {
    const days = period?.endsWith('d') ? parseInt(period.replace('d', ''), 10) : 30
    return this.svc.growth(isNaN(days) ? 30 : days)
  }

  @Get('activity')
  @ApiOperation({ summary: 'Senaste plattformsaktivitet' })
  activity(@Query('limit') limit?: string) {
    return this.svc.activity(limit ? parseInt(limit, 10) : 20)
  }

  @Get('top-organizations')
  @ApiOperation({ summary: 'Topp-10 kunder per fastigheter' })
  top(@Query('limit') limit?: string) {
    return this.svc.topOrganizations(limit ? parseInt(limit, 10) : 10)
  }

  @Get('plan-breakdown')
  @ApiOperation({ summary: 'Fördelning per plan' })
  plans() {
    return this.svc.planBreakdown()
  }
}
