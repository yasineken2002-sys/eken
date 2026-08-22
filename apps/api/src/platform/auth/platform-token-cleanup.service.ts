import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaService } from '../../common/prisma/prisma.service'

@Injectable()
export class PlatformTokenCleanupService {
  private readonly logger = new Logger(PlatformTokenCleanupService.name)

  constructor(private readonly prisma: PrismaService) {}

  // Kör nattetid 03:00. Raderar tokens som a) löpt ut, eller b) revokerats
  // för mer än 7 dagar sedan — tillräckligt långt fönster för forensik
  // utan att tabellen växer obegränsat.
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // PlatformRefreshToken deleteMany på expiresAt < now — raderade rader kan
  // inte raderas igen, så en andra körning påverkar noll rader.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpired(): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const result = await this.prisma.platformRefreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: sevenDaysAgo } }],
      },
    })
    if (result.count > 0) {
      this.logger.log(`Rensade ${result.count} utgångna platform-refresh-tokens`)
    }
  }
}
