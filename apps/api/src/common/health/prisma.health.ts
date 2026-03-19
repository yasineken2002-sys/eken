import { Injectable } from '@nestjs/common'
import type { HealthIndicatorResult } from '@nestjs/terminus'
import { HealthIndicator, HealthCheckError } from '@nestjs/terminus'
import type { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private prisma: PrismaService) {
    super()
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`
      return this.getStatus(key, true)
    } catch (_err) {
      throw new HealthCheckError('Prisma check failed', this.getStatus(key, false))
    }
  }
}
