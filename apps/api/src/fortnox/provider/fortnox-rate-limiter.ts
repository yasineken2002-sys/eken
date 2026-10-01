import type { FortnoxClock, FortnoxRateLimiter } from './fortnox-transport.types'

export const systemFortnoxClock: FortnoxClock = {
  now: () => Date.now(),
  schedule: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds)
    return () => clearTimeout(timer)
  },
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Aborted'))
        return
      }
      const finish = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(new Error('Aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
    }),
}

/** Process-local only. Register one shared instance; distributed workers need another implementation. */
export class InMemoryFortnoxRateLimiter implements FortnoxRateLimiter {
  private readonly buckets = new Map<string, { starts: number[]; deferredUntil: number }>()

  constructor(private readonly clock: FortnoxClock = systemFortnoxClock) {}

  async acquire(key: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new Error('Aborted')
      const now = this.clock.now()
      let bucket = this.buckets.get(key)
      if (!bucket) {
        // Discard inactive tenants without retaining tokens or background timers.
        for (const [oldKey, old] of this.buckets) {
          if (old.deferredUntil <= now && (old.starts.at(-1) ?? -Infinity) <= now - 5000) {
            this.buckets.delete(oldKey)
          }
        }
        bucket = { starts: [], deferredUntil: 0 }
        this.buckets.set(key, bucket)
      }
      bucket.starts = bucket.starts.filter((started) => started > now - 5000)
      const oldest = bucket.starts[0]
      const slotAt = bucket.starts.length >= 25 && oldest !== undefined ? oldest + 5000 : now
      const delay = Math.max(slotAt, bucket.deferredUntil) - now
      if (delay <= 0) {
        // No await between checking and reserving: concurrent callers cannot steal this slot.
        bucket.starts.push(now)
        return
      }
      await this.clock.sleep(delay, signal)
    }
  }

  defer(key: string, untilMs: number): void {
    const bucket = this.buckets.get(key) ?? { starts: [], deferredUntil: 0 }
    bucket.deferredUntil = Math.max(bucket.deferredUntil, untilMs)
    this.buckets.set(key, bucket)
  }
}
