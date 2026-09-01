/**
 * #605 BATCH 2 — C-FORMEN, PRÖVAD MOT RIKTIG POSTGRES.
 *
 * ── VARFÖR EN EGEN RIGG, NÄR BATCH 1 REDAN HAR EN ───────────────────────────
 *
 * Batch 1:s rigg prövar A-formen: ett jobb som redan FÅNGAR per organisation och
 * som fick sänkan bredvid sin logg. Batch 2 innehåller en annan form, och den är
 * inte en variant utan en annan sak:
 *
 *     A  jobbet fångar redan  →  sänkan läggs BREDVID logger.error
 *     C  jobbet fångar INTE   →  felhanteringen LÄGGS TILL via runCronSafely
 *
 * I C-formen lämnade felet tidigare @Cron-metoden till @nestjs/schedule, som
 * loggar i containern och inget mer. Att kedjan runCronSafely → sink → ErrorLog
 * faktiskt sluter sig går inte att avgöra från en attrapp: `logInternalError`
 * fångar sitt eget fel, så en trasig skrivning ser likadan ut som en lyckad.
 *
 * `purgeExpired` är vald för att den har minsta möjliga beroendeyta — prisma och
 * sänkan. Det som prövas är formen, inte jobbet.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PlatformTokenCleanupService } from './platform-token-cleanup.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { PlatformErrorsService } from '../errors/platform-errors.service'

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('#605 batch 2: C-formens fel överlever processen', () => {
  const prisma = new PrismaClient()
  const märke = `QQC-${randomUUID()}`

  afterAll(async () => {
    await prisma.errorLog.deleteMany({ where: { message: { contains: märke } } })
    await prisma.$disconnect()
  })

  const görService = (kastare: () => never) => {
    const errors = new PlatformErrorsService(prisma as never)
    const sink = new CronErrorSink(errors)
    const service = new PlatformTokenCleanupService(prisma as never, sink)
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined)
    // Låt jobbets FÖRSTA query kasta — det är den transienta DB-blipp formen
    // finns för. Kroppen ligger i *Unsafe-delegaten, så vi byter ut den.
    jest.spyOn(service as never, 'purgeExpiredUnsafe').mockImplementation(kastare)
    return service
  }

  it('jobbet kastar på riktigt → raden finns, och överlever att klienten dör', async () => {
    const service = görService((() => {
      throw new Error(`${märke}: första query sprack`)
    }) as never)

    // C-formen SVÄLJER — jobbet får inte kasta vidare, för då dör cron-loopen.
    await expect(service.purgeExpired()).resolves.toBeUndefined()

    await prisma.$disconnect()
    const efter = new PrismaClient()
    try {
      const rader = await efter.errorLog.findMany({ where: { message: { contains: märke } } })
      expect(rader).toHaveLength(1)
      expect(rader[0]!.severity).toBe('CRITICAL')
      expect(rader[0]!.message).toContain('[cron:platform-token-cleanup]')
      expect(rader[0]!.context).toMatchObject({ cron: 'platform-token-cleanup' })
      expect(rader[0]!.stack ?? '').toContain('Error')
    } finally {
      await efter.$disconnect()
    }
    await prisma.$connect()
  }, 30_000)

  it('KANARIEFÅGEL: utan ett kast skrivs ingen rad', async () => {
    await prisma.errorLog.deleteMany({ where: { message: { contains: märke } } })
    const errors = new PlatformErrorsService(prisma as never)
    const sink = new CronErrorSink(errors)
    const service = new PlatformTokenCleanupService(prisma as never, sink)
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined)

    await service.purgeExpired() // riktig körning mot riktig databas — inget kast
    const rader = await prisma.errorLog.findMany({ where: { message: { contains: märke } } })
    expect(rader).toHaveLength(0)
  }, 30_000)
})
