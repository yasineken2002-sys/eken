import { Injectable, Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { RedisService } from './redis.service'
import { PrismaService } from '../prisma/prisma.service'
import type { CronUtfall } from '../cron/cron-heartbeat'

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

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * HJÄRTSLAGET (#710). Skrivs när innehavaren är KLAR — lyckad eller kastad.
   *
   * ── VARFÖR BÅDA UTFALLEN ────────────────────────────────────────────────
   *
   * Ett jobb som kastar varje natt är INTE tyst; det körs. Skrevs hjärtslaget
   * bara vid framgång hade ett trasigt jobb sett ut som ett hängt lås, och de
   * två kräver olika åtgärd. Utfallet står i raden så de går att skilja åt.
   *
   * ── VARFÖR INTE NÄR LÅSET NEKADES ───────────────────────────────────────
   *
   * `ran: false` betyder att kroppen ALDRIG kördes. Ett hjärtslag där hade
   * gjort en instans som aldrig får låset till en frisk instans, och två
   * repliker där den ena hänger hade sett friska ut båda två.
   *
   * ── KASTAR ALDRIG ───────────────────────────────────────────────────────
   *
   * Observerbarhet får inte fälla det den observerar. Ett fel mot databasen
   * här loggas och sväljs — annars kan ett trasigt hjärtslag ta ned ett jobb
   * som fungerar.
   */
  private async skrivHjärtslag(key: string, utfall: CronUtfall, ms: number): Promise<void> {
    const nu = new Date()
    try {
      await this.prisma.cronHeartbeat.upsert({
        where: { key },
        create: { key, lastRunAt: nu, lastOutcome: utfall, lastDurationMs: ms },
        update: { lastRunAt: nu, lastOutcome: utfall, lastDurationMs: ms },
      })
    } catch (err) {
      this.logger.warn(
        `[cron-heartbeat] kunde inte skriva hjärtslag för ${key}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

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

  /**
   * Kör `fn` BARA om låset är ledigt. Är det taget hoppar vi över — vi väntar
   * inte.
   *
   * ── VARFÖR EN EGEN METOD OCH INTE `runWithLock` MED KORT VÄNTETID ─────────
   *
   * `runWithLock` väntar och kör SEDAN. För en schemalagd cron är det precis
   * fel: håller replik A jobbet, väntar replik B ut A och kör sedan jobbet en
   * andra gång. Väntandet gör dubbelkörningen långsammare, inte omöjlig.
   *
   * Det en cron behöver är motsatsen: "körs det redan någon annanstans — gör
   * ingenting." Semantiken skiljer sig så mycket att den förtjänar ett eget
   * namn i stället för en flagga som är lätt att sätta fel.
   *
   * ── TTL ÄR INTE EN DETALJ ────────────────────────────────────────────────
   *
   * Låset släpps av `finally`, men om processen DÖR mitt i jobbet ligger det
   * kvar tills TTL löper ut. `ttlSec` måste därför vara längre än jobbets
   * värsta körtid — annars kan en andra replik ta låset medan den första
   * fortfarande arbetar, och då skyddar låset ingenting.
   *
   * Ett för långt TTL kostar bara att nästa schemalagda körning hoppas över
   * efter en krasch. För ett dagligt jobb är det oproblematiskt; för ett jobb
   * som ska köra varje minut vore det inte det.
   */
  async runIfUnlocked<T>(
    key: string,
    fn: () => Promise<T>,
    options: { ttlSec: number },
  ): Promise<TryRunResult<T>> {
    const token = crypto.randomBytes(16).toString('hex')
    const lockKey = `lock:${key}`

    const acquired = await this.redis.client.set(lockKey, token, 'EX', options.ttlSec, 'NX')
    if (acquired !== 'OK') {
      // Hur gammalt är låset vi krockade med? PTTL ger återstående livstid i ms;
      // resten av TTL:n är hur länge hållaren haft det. Utan det talet är ett
      // överhopp oskiljbart från ett hängt lås.
      let heldForSec: number | null = null
      try {
        const remainingMs = await this.redis.client.pttl(lockKey)
        if (remainingMs > 0) {
          heldForSec = Math.max(0, Math.round(options.ttlSec - remainingMs / 1000))
        }
      } catch {
        // PTTL är diagnostik, inte kontrollflöde — ett fel här får inte göra
        // överhoppet till ett undantag.
      }
      return { ran: false, heldForSec }
    }

    const start = Date.now()
    try {
      const value = await fn()
      await this.skrivHjärtslag(key, 'success', Date.now() - start)
      return { ran: true, value }
    } catch (err) {
      // Hjärtslaget skrivs FÖRE omkastet: ett jobb som kastar har ändå kört.
      await this.skrivHjärtslag(key, 'failed', Date.now() - start)
      throw err
    } finally {
      try {
        await this.redis.client.eval(RELEASE_LUA, 1, lockKey, token)
      } catch (err) {
        this.logger.warn(`Failed to release lock ${lockKey}: ${String(err)}`)
      }
    }
  }
}

export type TryRunResult<T> =
  | { ran: true; value: T }
  | {
      ran: false
      /**
       * Hur länge den andra hållaren haft låset, i sekunder.
       *
       * `null` betyder att Redis inte kunde svara på frågan — låset släpptes
       * mellan vårt misslyckade SET och vår PTTL, eller saknar utgång.
       *
       * Fältet finns för att ett överhopp ska gå att skilja från ett HÄNGT lås.
       * Ett överhopp där hållaren startade för tio sekunder sedan är normalt;
       * ett där låset legat nästan hela sin TTL betyder att jobbet tar för lång
       * tid eller att en release tappats.
       */
      heldForSec: number | null
    }

export class LockAcquisitionTimeoutError extends Error {
  constructor(key: string, waitMs: number) {
    super(`Kunde inte ta lås ${key} inom ${waitMs} ms`)
    this.name = 'LockAcquisitionTimeoutError'
  }
}
