import {
  FORTNOX_ARRIVAL_GUARD_MS,
  FORTNOX_STARTS_PER_WINDOW,
  FORTNOX_WINDOW_MS,
  systemFortnoxClock,
} from './fortnox-rate-limiter'
import type { FortnoxClock, FortnoxRateLimiter } from './fortnox-transport.types'

const WINDOW = FORTNOX_WINDOW_MS + FORTNOX_ARRIVAL_GUARD_MS

/**
 * ENDAST PROV. Processlokal begränsare för enhetsprov av transporten. Produkten använder
 * `RedisFortnoxRateLimiter` (TESTKUND-035 P3-A1); den här klassen får aldrig registreras i
 * modulen och fäller tvåprocessprovet om den gör det.
 */
export class InMemoryFortnoxRateLimiter implements FortnoxRateLimiter {
  private readonly buckets = new Map<string, { starts: number[]; deferredUntil: number }>()

  constructor(private readonly clock: FortnoxClock = systemFortnoxClock) {}

  async acquire(key: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new Error('Aborted')
      const now = this.clock.now()
      const bucket = this.buckets.get(key) ?? { starts: [], deferredUntil: 0 }
      this.buckets.set(key, bucket)
      bucket.starts = bucket.starts.filter((started) => started > now - WINDOW)
      const oldest = bucket.starts[0]
      const slotAt =
        bucket.starts.length >= FORTNOX_STARTS_PER_WINDOW && oldest !== undefined
          ? oldest + WINDOW
          : now
      const delay = Math.max(slotAt, bucket.deferredUntil) - now
      if (delay <= 0) {
        bucket.starts.push(now)
        return
      }
      await this.clock.sleep(delay, signal)
    }
  }

  async defer(key: string, delayMs: number): Promise<void> {
    const bucket = this.buckets.get(key) ?? { starts: [], deferredUntil: 0 }
    bucket.deferredUntil = Math.max(bucket.deferredUntil, this.clock.now() + delayMs)
    this.buckets.set(key, bucket)
  }
}
