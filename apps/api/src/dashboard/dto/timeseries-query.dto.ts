import { IsOptional, IsIn } from 'class-validator'

const VALID_PERIODS = ['6months', '12months', '24months'] as const
export type DashboardPeriod = (typeof VALID_PERIODS)[number]

export class TimeseriesQueryDto {
  @IsOptional()
  @IsIn(VALID_PERIODS)
  period?: DashboardPeriod
}

export function periodToMonths(period: DashboardPeriod | undefined): number {
  switch (period) {
    case '6months':
      return 6
    case '24months':
      return 24
    default:
      return 12
  }
}
