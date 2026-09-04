import { Logger } from '@nestjs/common'
import { LockService } from './lock.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { RedisService } from './redis.service'

/**
 * HJÄRTSLAGETS SKRIVREGLER (#710).
 *
 * Tre riktningar, och den tredje är den som gör mängden skarp:
 *
 *   lyckad körning   → hjärtslag med outcome 'success'
 *   kastad körning   → hjärtslag med outcome 'failed', och felet kastas vidare
 *   låset NEKAT      → INGET hjärtslag — kroppen kördes aldrig
 *
 * Utan den tredje hade "skriv alltid" passerat lika bra som den avsedda
 * regeln, och två repliker där den ena hänger hade sett friska ut båda två.
 */

type Upsert = { where: { key: string }; create: Record<string, unknown> }

function rigg(låsSvar: 'OK' | null) {
  const upserts: Upsert[] = []
  const prisma = {
    cronHeartbeat: {
      upsert: (a: Upsert) => {
        upserts.push(a)
        return Promise.resolve({})
      },
    },
  } as unknown as PrismaService
  const redis = {
    client: {
      set: () => Promise.resolve(låsSvar),
      pttl: () => Promise.resolve(-1),
      eval: () => Promise.resolve(1),
    },
  } as unknown as RedisService
  return { tjänst: new LockService(redis, prisma), upserts }
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

describe('runIfUnlocked — hjärtslag', () => {
  it('skriver hjärtslag vid LYCKAD körning', async () => {
    const { tjänst, upserts } = rigg('OK')
    const r = await tjänst.runIfUnlocked('cron:sond', () => Promise.resolve('klart'), {
      ttlSec: 60,
    })
    expect(r).toEqual({ ran: true, value: 'klart' })
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.where.key).toBe('cron:sond')
    expect(upserts[0]?.create['lastOutcome']).toBe('success')
  })

  it('skriver hjärtslag vid KASTAD körning — och kastar vidare', async () => {
    // Ett jobb som kastar varje natt är INTE tyst; det körs. Skrevs
    // hjärtslaget bara vid framgång hade ett trasigt jobb sett ut som ett hängt
    // lås, och de två kräver olika åtgärd.
    const { tjänst, upserts } = rigg('OK')
    await expect(
      tjänst.runIfUnlocked('cron:sond', () => Promise.reject(new Error('smäll')), { ttlSec: 60 }),
    ).rejects.toThrow('smäll')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.create['lastOutcome']).toBe('failed')
  })

  it('DEN OMVÄNDA RIKTNINGEN: inget hjärtslag när låset nekades', async () => {
    // `ran: false` betyder att kroppen ALDRIG kördes. Ett hjärtslag där hade
    // gjort en instans som aldrig får låset till en frisk instans.
    const { tjänst, upserts } = rigg(null)
    let kroppenKördes = false
    const r = await tjänst.runIfUnlocked(
      'cron:sond',
      () => {
        kroppenKördes = true
        return Promise.resolve('x')
      },
      { ttlSec: 60 },
    )
    expect(r.ran).toBe(false)
    expect(kroppenKördes).toBe(false)
    expect(upserts).toHaveLength(0)
  })

  it('mäter körningens längd, inte noll', async () => {
    const { tjänst, upserts } = rigg('OK')
    await tjänst.runIfUnlocked(
      'cron:sond',
      () => new Promise((r) => setTimeout(() => r('x'), 25)),
      { ttlSec: 60 },
    )
    expect(upserts[0]?.create['lastDurationMs']).toBeGreaterThanOrEqual(20)
  })

  it('ett trasigt hjärtslag fäller INTE jobbet', async () => {
    // Observerbarhet får inte fälla det den observerar.
    const prisma = {
      cronHeartbeat: { upsert: () => Promise.reject(new Error('db nere')) },
    } as unknown as PrismaService
    const redis = {
      client: {
        set: () => Promise.resolve('OK'),
        pttl: () => Promise.resolve(-1),
        eval: () => Promise.resolve(1),
      },
    } as unknown as RedisService
    const r = await new LockService(redis, prisma).runIfUnlocked(
      'cron:sond',
      () => Promise.resolve('klart'),
      { ttlSec: 60 },
    )
    expect(r).toEqual({ ran: true, value: 'klart' })
  })
})
