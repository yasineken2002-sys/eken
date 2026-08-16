/**
 * H6: cron-jobb som körs en gång per replik ska köras en gång TOTALT.
 *
 * ── EXPONERINGEN ÄR INTE LIKA FÖR ALLA FYRA JOBBEN ──────────────────────────
 *
 * Mätt, inte antaget:
 *
 *   morning-insights / weekly-summary / monthly-report
 *     Mejlen bär `idempotencyKey` per org+användare+dag/vecka/månad, och den
 *     går vidare till Resend som `Idempotency-Key`. En dubbelkörning ger alltså
 *     ETT mejl — men AI-anropet ligger FÖRE utskicket och är oskyddat.
 *     Exponering: dubbel AI-kostnad.
 *
 *   tenant-activation-reminders
 *     `issueActivationToken` roterar token vid varje körning, och
 *     idempotensnyckeln innehåller tokenprefixet. Två repliker ger därför två
 *     OLIKA nycklar → TVÅ levererade mejl, och den andra rotationen gör länken
 *     i det första mejlet ogiltig.
 *     Exponering: dubbla mejl OCH en död aktiveringslänk.
 *
 * Den skillnaden är skälet till att låset behövs även där en idempotensnyckel
 * redan finns: nyckeln skyddar utskicket, inte det som sker före det.
 */

import { LockService } from './lock.service'

/**
 * Minimal Redis-fejk med RIKTIG SET NX-semantik OCH riktig TTL-utgång.
 *
 * TTL:n är inte pynt i den här fejken: hela poängen med testet längst ned är
 * att ett lås som ingen släpper ska försvinna av sig självt. En fejk utan
 * utgång hade gjort det testet omöjligt att skriva — och just det testet är det
 * som bevisar att fail-closed inte betyder fail-forever.
 */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>()
  let now = 0
  const alive = (key: string): boolean => {
    const e = store.get(key)
    if (!e) return false
    if (e.expiresAt <= now) {
      store.delete(key)
      return false
    }
    return true
  }
  return {
    store,
    /** Flyttar den simulerade klockan framåt. */
    advanceSec: (sec: number) => {
      now += sec * 1000
    },
    has: (key: string) => alive(key),
    client: {
      set: jest.fn(async (key: string, value: string, _ex: string, ttl: number, nx: string) => {
        if (nx === 'NX' && alive(key)) return null
        store.set(key, { value, expiresAt: now + ttl * 1000 })
        return 'OK'
      }),
      pttl: jest.fn(async (key: string) => {
        if (!alive(key)) return -2
        return store.get(key)!.expiresAt - now
      }),
      eval: jest.fn(async (_lua: string, _n: number, key: string, token: string) => {
        if (alive(key) && store.get(key)!.value === token) store.delete(key)
        return 1
      }),
    },
  }
}

describe('runIfUnlocked — hoppar över, väntar inte', () => {
  it('andra repliken kör INTE jobbet medan den första håller låset', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)
    const körningar: string[] = []

    let släpp!: () => void
    const spärr = new Promise<void>((r) => {
      släpp = r
    })

    const a = locks.runIfUnlocked(
      'cron:test',
      async () => {
        körningar.push('A')
        await spärr
      },
      { ttlSec: 60 },
    )
    // B startar medan A fortfarande kör.
    const b = await locks.runIfUnlocked(
      'cron:test',
      async () => {
        körningar.push('B')
      },
      { ttlSec: 60 },
    )

    // heldForSec tillkom när överhoppet började rapportera låsets ålder. Talen
    // är oförändrade: låset togs i samma ögonblick, alltså 0 sekunder hållet.
    expect(b).toEqual({ ran: false, heldForSec: 0 })
    expect(körningar).toEqual(['A'])

    släpp()
    await a
    // Det här är skillnaden mot runWithLock: B väntade INTE ut A för att sedan
    // köra jobbet en andra gång.
    expect(körningar).toEqual(['A'])
  })

  it('KANARIEFÅGEL: när låset är ledigt körs jobbet faktiskt', async () => {
    // Utan det här testet vore ett lås som ALLTID hoppar över helt grönt.
    const locks = new LockService(fakeRedis() as never)
    const result = await locks.runIfUnlocked('cron:test', async () => 'kördes', { ttlSec: 60 })

    expect(result).toEqual({ ran: true, value: 'kördes' })
  })

  it('låset släpps efteråt, så nästa schemalagda körning inte blockeras', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)

    await locks.runIfUnlocked('cron:test', async () => 1, { ttlSec: 60 })
    expect(redis.has('lock:cron:test')).toBe(false)

    const andra = await locks.runIfUnlocked('cron:test', async () => 2, { ttlSec: 60 })
    expect(andra).toEqual({ ran: true, value: 2 })
  })

  it('låset släpps även när jobbet kastar', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)

    await expect(
      locks.runIfUnlocked(
        'cron:test',
        async () => {
          throw new Error('jobbet failade')
        },
        { ttlSec: 60 },
      ),
    ).rejects.toThrow('jobbet failade')

    // Ett kvarliggande lås efter ett fel hade tystat jobbet till TTL löpt ut.
    expect(redis.has('lock:cron:test')).toBe(false)
  })

  it('olika jobb har olika nycklar och blockerar inte varandra', async () => {
    const locks = new LockService(fakeRedis() as never)
    const kört: string[] = []

    let släpp!: () => void
    const spärr = new Promise<void>((r) => {
      släpp = r
    })
    const a = locks.runIfUnlocked(
      'cron:morning-insights',
      async () => {
        kört.push('morgon')
        await spärr
      },
      { ttlSec: 60 },
    )
    const b = await locks.runIfUnlocked(
      'cron:weekly-summary',
      async () => {
        kört.push('vecka')
      },
      { ttlSec: 60 },
    )

    expect(b).toEqual({ ran: true, value: undefined })
    expect(kört).toEqual(['morgon', 'vecka'])
    släpp()
    await a
  })

  it('TTL skickas vidare till Redis — ett lås utan utgång vore permanent', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)

    await locks.runIfUnlocked('cron:test', async () => 1, { ttlSec: 1800 })

    expect(redis.client.set).toHaveBeenCalledWith(
      'lock:cron:test',
      expect.any(String),
      'EX',
      1800,
      'NX',
    )
  })
})

describe('FAIL-CLOSED FÅR INTE BLI FAIL-FOREVER', () => {
  it('ett lås som ALDRIG släpps löses upp av TTL:t — jobbet kommer tillbaka', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)
    const kört: string[] = []

    // Simulera en replik som dog mitt i jobbet: låset togs, releasen kom aldrig.
    await redis.client.set('lock:cron:morning-insights', 'död-replik', 'EX', 1800, 'NX')

    // Nästa schemalagda körning hoppas över — det är meningen.
    const under = await locks.runIfUnlocked(
      'cron:morning-insights',
      async () => {
        kört.push('kördes')
      },
      { ttlSec: 1800 },
    )
    expect(under.ran).toBe(false)
    expect(kört).toEqual([])

    // … men bara tills TTL:n löpt ut. Det är hela skillnaden mellan "hoppar
    // över den här gången" och "jobbet är permanent avstängt", och det är den
    // egenskapen som gör TTL < cron-intervall till en invariant och inte en
    // trivia. Se cron-lock-interval.spec.ts.
    redis.advanceSec(1801)

    const efter = await locks.runIfUnlocked(
      'cron:morning-insights',
      async () => {
        kört.push('kördes')
      },
      { ttlSec: 1800 },
    )
    expect(efter).toEqual({ ran: true, value: undefined })
    expect(kört).toEqual(['kördes'])
  })

  it('överhoppet rapporterar hur länge låset hållits', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)

    await redis.client.set('lock:cron:test', 'annan', 'EX', 1800, 'NX')
    redis.advanceSec(600)

    const result = await locks.runIfUnlocked('cron:test', async () => 1, { ttlSec: 1800 })

    // Utan det här talet är ett normalt överhopp (hållaren startade nyss)
    // oskiljbart från ett hängt lås som är på väg att stänga av jobbet.
    expect(result).toEqual({ ran: false, heldForSec: 600 })
  })

  it('åldern är null när Redis inte kan svara — inte 0, som hade sett normalt ut', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)
    // SET misslyckas men nyckeln är borta när vi frågar PTTL (race).
    redis.client.set = jest.fn(
      async (_k: string, _v: string, _ex: string, _t: number, _nx: string) => null,
    )
    redis.client.pttl = jest.fn(async (_k: string) => -2)

    const result = await locks.runIfUnlocked('cron:test', async () => 1, { ttlSec: 1800 })

    expect(result).toEqual({ ran: false, heldForSec: null })
  })

  it('ett PTTL som kastar gör inte överhoppet till ett undantag', async () => {
    const redis = fakeRedis()
    const locks = new LockService(redis as never)
    await redis.client.set('lock:cron:test', 'annan', 'EX', 1800, 'NX')
    redis.client.pttl = jest.fn(async (_k: string) => {
      throw new Error('redis nere')
    })

    // Diagnostiken får aldrig bli kontrollflöde.
    await expect(
      locks.runIfUnlocked('cron:test', async () => 1, { ttlSec: 1800 }),
    ).resolves.toEqual({ ran: false, heldForSec: null })
  })
})
