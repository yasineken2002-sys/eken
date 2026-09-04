import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { LockService } from './lock.service'
import type { RedisService } from './redis.service'

/**
 * HJÄRTSLAGET MOT RIKTIG POSTGRES (#710).
 *
 * Enhetsprovet i lock-heartbeat.spec.ts mäter att `upsert` ANROPAS med rätt
 * argument. Det kan per konstruktion inte se att upserten faktiskt fungerar mot
 * en riktig tabell — en attrapp returnerar det den blev tillsagd, oavsett
 * `where`. Just för ett hjärtslag är det skillnaden som betyder något: raden
 * ska SKRIVAS ÖVER, inte läggas till, annars växer tabellen med en rad per
 * körning och `findMany` i health blir allt dyrare.
 *
 * Kör mot samma databas som övriga db-specar. Städar sin egen nyckel.
 */

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('CronHeartbeat mot riktig databas', () => {
  const prisma = new PrismaService()
  const nyckel = `cron:zz-sond-${randomUUID().slice(0, 8)}`
  const redis = {
    client: {
      set: () => Promise.resolve('OK'),
      pttl: () => Promise.resolve(-1),
      eval: () => Promise.resolve(1),
    },
  } as unknown as RedisService
  const tjänst = new LockService(redis, prisma)

  afterAll(async () => {
    await prisma.cronHeartbeat.deleteMany({ where: { key: nyckel } })
    await prisma.$disconnect()
  })

  it('första körningen SKAPAR raden', async () => {
    await tjänst.runIfUnlocked(nyckel, () => Promise.resolve('a'), { ttlSec: 60 })
    const rad = await prisma.cronHeartbeat.findUnique({ where: { key: nyckel } })
    expect(rad).not.toBeNull()
    expect(rad?.lastOutcome).toBe('success')
  })

  it('andra körningen SKRIVER ÖVER — en rad per nyckel, aldrig en logg', async () => {
    // Det är det attrappen inte kan se. Vore upserten en create hade tabellen
    // vuxit med en rad per körning, och health.findMany blivit dyrare för varje
    // natt utan att något blivit rött.
    const före = await prisma.cronHeartbeat.findUnique({ where: { key: nyckel } })
    await new Promise((r) => setTimeout(r, 10))
    await expect(
      tjänst.runIfUnlocked(nyckel, () => Promise.reject(new Error('smäll')), { ttlSec: 60 }),
    ).rejects.toThrow('smäll')

    const antal = await prisma.cronHeartbeat.count({ where: { key: nyckel } })
    expect(antal).toBe(1)

    const efter = await prisma.cronHeartbeat.findUnique({ where: { key: nyckel } })
    expect(efter?.lastOutcome).toBe('failed')
    expect(efter!.lastRunAt.getTime()).toBeGreaterThan(före!.lastRunAt.getTime())
  })
})
