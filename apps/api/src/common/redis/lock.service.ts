import { Injectable, Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { RedisService } from './redis.service'

const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`

export interface RunWithLockOptions {
  /** Time-to-live för låset i sekunder. Om processen kraschar släpps
   *  låset automatiskt när TTL löpt ut. Default 30s. */
  ttlSec?: number
  /** Hur länge vi väntar på att få låset (ms). Default 10 000. */
  waitMs?: number
  /** Pollintervall medan vi väntar (ms). Default 200. */
  pollIntervalMs?: number
}

/**
 * Lättviktig distribuerad lock över Redis (SET NX EX-pattern).
 *
 * Behovet: en hyresvärd som klickar "generera kontrakt" två gånger snabbt
 * (eller controller-anropet racar med Bull-jobbet) kan annars skapa två
 * Document-rader och lägga upp två PDF:er i R2 — versionskedjan blir korrupt
 * och tenant ser dubbelt i sin portal.
 *
 * Implementationen följer Redlock-light: SET key value NX EX ttl, släpp via
 * Lua-script som bara DEL:ar om värdet matchar (förhindrar att vi släpper
 * någon annans lock som tagits över efter att vår TTL löpt ut).
 */
@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name)

  constructor(private readonly redis: RedisService) {}

  async runWithLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: RunWithLockOptions = {},
  ): Promise<T> {
    const ttlSec = options.ttlSec ?? 30
    const waitMs = options.waitMs ?? 10_000
    const pollMs = options.pollIntervalMs ?? 200
    const token = crypto.randomBytes(16).toString('hex')
    const lockKey = `lock:${key}`

    const deadline = Date.now() + waitMs
    let acquired = false
    while (!acquired) {
      const result = await this.redis.client.set(lockKey, token, 'EX', ttlSec, 'NX')
      if (result === 'OK') {
        acquired = true
        break
      }
      if (Date.now() >= deadline) {
        throw new LockAcquisitionTimeoutError(lockKey, waitMs)
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }

    try {
      return await fn()
    } finally {
      try {
        await this.redis.client.eval(RELEASE_LUA, 1, lockKey, token)
      } catch (err) {
        this.logger.warn(`Failed to release lock ${lockKey}: ${String(err)}`)
      }
    }
  }
}

export class LockAcquisitionTimeoutError extends Error {
  constructor(key: string, waitMs: number) {
    super(`Kunde inte ta lås ${key} inom ${waitMs} ms`)
    this.name = 'LockAcquisitionTimeoutError'
  }
}
