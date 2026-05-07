import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

/**
 * Tunn singleton-wrapper kring ioredis.
 *
 * Bull har sin egen Redis-pool men exponerar den inte direkt — vi behöver
 * en separat client för distribuerade locks (SET NX) och kan inte återanvända
 * Bull-anslutningarna utan att riskera deras blockerande kommandon. Samma
 * REDIS_URL används så vi pekar mot samma instans.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  readonly client: Redis

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL', 'redis://localhost:6379')
    this.client = new Redis(url, {
      // Vi kör connect-on-first-command för att undvika onödig socket vid
      // tester och dev-restart. Bull och cron-jobben använder ändå Redis.
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    })
    this.client.on('error', (err) => {
      this.logger.error(`Redis-fel: ${String(err.message)}`)
    })
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit()
    } catch {
      // ignore — connection may already be closed
    }
  }
}
