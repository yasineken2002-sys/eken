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

/** Minimal Redis-fejk med RIKTIG SET NX-semantik. */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    client: {
      set: jest.fn(async (key: string, value: string, _ex: string, _ttl: number, nx: string) => {
        if (nx === 'NX' && store.has(key)) return null
        store.set(key, value)
        return 'OK'
      }),
      eval: jest.fn(async (_lua: string, _n: number, key: string, token: string) => {
        if (store.get(key) === token) store.delete(key)
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

    expect(b).toEqual({ ran: false })
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
    expect(redis.store.has('lock:cron:test')).toBe(false)

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
    expect(redis.store.has('lock:cron:test')).toBe(false)
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
