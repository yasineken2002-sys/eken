import { Controller, Get } from '@nestjs/common'
import type { HealthCheckService } from '@nestjs/terminus'
import { HealthCheck } from '@nestjs/terminus'
import { Public } from '../decorators/public.decorator'
import type { PrismaHealthIndicator } from './prisma.health'

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  check() {
    return this.health.check([() => this.prismaHealth.isHealthy('database')])
  }
}
