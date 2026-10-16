import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { RedisService } from '../common/redis/redis.service'
import { normalizeEmail } from '../common/utils/normalize-email'

// Första avgränsade provbudgeten; produktionsbruk kräver hela loginpaketets lastprov.
export const MAX_LOGIN_CANDIDATES = 5

export interface TenantLoginContext {
  email: string
  ip: string
  signal?: AbortSignal
}

export interface TenantLoginPermit {
  /** Reservera hela jämförelsearbetet exakt en gång, före första bcrypt-anropet. */
  reserve(passwordHashes: readonly string[]): Promise<void>
  /** Kontrollpunkt även före/efter databasarbete och före varje jämförelse. */
  assertActive(): void
}

const WINDOW_MS = 60_000
const REDIS_DEADLINE_MS = 1_000
const ATTEMPT_DEADLINE_MS = 5_000
const REQUEST_LIMITS = [120, 10, 10] as const
const WORK_LIMITS = [60, 15, 15] as const
const KEY_PREFIX = 'tenant-login:v1:{tenant-login-budget}'
const UNAVAILABLE_MESSAGE = 'Inloggning är tillfälligt begränsad. Försök igen senare.'

// Alla tre räknare kontrolleras innan någon debiteras. Fönstret börjar vid
// respektive nyckels första godkända anrop; det är inte ett glidande fönster.
const RESERVE_QUOTA = `
local units = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
for i = 1, #KEYS do
  local raw = redis.call('GET', KEYS[i])
  local count = 0
  if raw then
    count = tonumber(raw)
    if not count or count < 0 or count ~= math.floor(count) then return 0 end
    if redis.call('PTTL', KEYS[i]) < 0 then return 0 end
  end
  if count + units > tonumber(ARGV[i + 2]) then return 0 end
end
for i = 1, #KEYS do
  local count = redis.call('INCRBY', KEYS[i], units)
  if count == units then redis.call('PEXPIRE', KEYS[i], ttl) end
end
return 1
`

function unavailable(): HttpException {
  return new HttpException(UNAVAILABLE_MESSAGE, HttpStatus.TOO_MANY_REQUESTS)
}

function workUnits(passwordHashes: readonly string[]): number {
  // Databeroende avslag ska ha samma svar som ett felaktigt lösenord. Ett
  // separat statusvärde här skulle avslöja kontotillstånd före lösenordsbevis.
  const invalidCredentials = () => new UnauthorizedException('Felaktig e-post eller lösenord')
  if (passwordHashes.length > MAX_LOGIN_CANDIDATES) throw invalidCredentials()
  let units = 0
  for (const hash of passwordHashes) {
    // Samma bcrypt-versioner som bcryptjs. Okänd form får aldrig passera som
    // billigt arbete; själva hashen lämnar inte processen.
    const match = /^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/.exec(hash)
    if (!match) throw invalidCredentials()
    const cost = Number(match[1])
    units += cost <= 12 ? 1 : 2 ** (cost - 12)
    if (units > MAX_LOGIN_CANDIDATES) throw invalidCredentials()
  }
  // Även ett resultat utan kandidater förbrukar en enhet.
  return Math.max(1, units)
}

@Injectable()
export class TenantLoginBudget {
  private readonly keySecret: string
  private busy = false

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.keySecret = config.getOrThrow<string>('JWT_SECRET')
    if (!this.keySecret) throw new Error('JWT_SECRET måste vara konfigurerad')
  }

  async run<T>(
    context: TenantLoginContext,
    work: (permit: TenantLoginPermit) => Promise<T>,
  ): Promise<T> {
    // Singletonens enda plats har ingen kö. Redis-kvoterna delas mellan
    // processer, men är ingen global garanti om antal samtidiga bcrypt-anrop.
    if (this.busy) throw unavailable()
    this.busy = true
    const deadline = performance.now() + ATTEMPT_DEADLINE_MS
    let active = true
    let denied = false
    let reservationStarted = false
    let reserved = false

    const deny = (): never => {
      denied = true
      throw unavailable()
    }
    const assertActive = (): void => {
      if (!active || denied || context.signal?.aborted || performance.now() >= deadline) deny()
    }

    try {
      assertActive()
      const identities = {
        email: this.identityKey('email', normalizeEmail(context.email)),
        ip: this.identityKey('ip', context.ip.trim().toLowerCase()),
      }
      const takeQuota = async (
        kind: 'request' | 'work',
        units: number,
        limits: readonly [number, number, number],
      ): Promise<void> => {
        assertActive()
        try {
          const result = await this.redisCommand(
            [
              `${KEY_PREFIX}:${kind}:global`,
              `${KEY_PREFIX}:${kind}:ip:${identities.ip}`,
              `${KEY_PREFIX}:${kind}:email:${identities.email}`,
            ],
            units,
            limits,
            deadline,
            context.signal,
          )
          assertActive()
          if (result !== 1) deny()
        } catch {
          // Varken Redis-fel, antal konton eller intern avslagsorsak exponeras.
          deny()
        }
      }

      await takeQuota('request', 1, REQUEST_LIMITS)
      const permit: TenantLoginPermit = {
        assertActive,
        reserve: async (passwordHashes) => {
          assertActive()
          if (reservationStarted) deny()
          reservationStarted = true
          const units = workUnits(passwordHashes)
          await takeQuota('work', units, WORK_LIMITS)
          reserved = true
        },
      }

      assertActive()
      // Deadline/avbrott observeras vid kontrollpunkter. Vi tävlar aldrig mot
      // hela callbacken: pågående bcrypt måste avslutas innan platsen frigörs.
      const result = await work(permit)
      assertActive()
      if (!reserved) deny()
      return result
    } finally {
      active = false
      this.busy = false
    }
  }

  private identityKey(kind: 'email' | 'ip', value: string): string {
    return createHmac('sha256', this.keySecret)
      .update(`tenant-login-budget:v1:${kind}\0`)
      .update(value)
      .digest('hex')
  }

  private async redisCommand(
    keys: readonly string[],
    units: number,
    limits: readonly [number, number, number],
    attemptDeadline: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const now = performance.now()
    const remaining = attemptDeadline - now
    if (signal?.aborted || remaining <= 0) throw unavailable()
    const commandDeadline = Math.min(attemptDeadline, now + REDIS_DEADLINE_MS)

    // Endast Redis väntan tidsbegränsas. Ett sent serversvar kan ha debiterat
    // kvoten, men får aldrig återuppta den nekade kedjan eller starta bcrypt.
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (ok: boolean, value?: unknown): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (ok && !signal?.aborted && performance.now() < commandDeadline) resolve(value)
        else reject(unavailable())
      }
      const abort = (): void => finish(false)
      timer = setTimeout(abort, Math.min(REDIS_DEADLINE_MS, remaining))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      try {
        const command = this.redis.client.eval(
          RESERVE_QUOTA,
          keys.length,
          ...keys,
          units,
          WINDOW_MS,
          ...limits,
        )
        // Båda sena utfallen hanteras även efter timeout/avbrott.
        void command.then(
          (result) => finish(true, result),
          () => finish(false),
        )
      } catch {
        finish(false)
      }
    })
  }
}
