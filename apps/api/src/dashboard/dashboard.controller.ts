import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { DashboardService } from './dashboard.service'
import { TimeseriesQueryDto, periodToMonths } from './dto/timeseries-query.dto'

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  async getStats(@OrgId() organizationId: string) {
    return this.dashboardService.getStats(organizationId)
  }

  @Get('timeseries')
  async getTimeseries(@OrgId() organizationId: string, @Query() query: TimeseriesQueryDto) {
    const months = periodToMonths(query.period)
    return this.dashboardService.getTimeseries(organizationId, months)
  }
}
