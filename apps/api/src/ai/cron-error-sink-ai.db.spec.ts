/**
 * #605 SISTA TVÅ — ai/:s cron-fel ska finnas kvar i morgon, på riktigt.
 *
 * ── VILKA, OCH VARFÖR DE VAR KVAR ───────────────────────────────────────────
 *
 * `ai-attachments-cleanup` (`0 4 * * *`) och `ai-retention` (`0 5 * * *`) var de
 * två sista jobben i #605 med ENBART lokal logg. Ingen av dem hade ett app-nivå
 * try/catch: ett fel på den första frågan svaldes av @nestjs/schedule i en tyst
 * `logger.error`, och den loggen lever bara så länge containern gör det.
 *
 * ── VARFÖR EN DB-RIGG OCH INTE EN ATTRAPP ───────────────────────────────────
 *
 * Samma skäl som `notifications/cron-error-sink-e2e.db.spec.ts`: en attrapp kan
 * mäta att sänkan ANROPAS, men inte den enda fråga som betyder något — finns
 * raden kvar när processen är borta? Riggen kör jobbens EGNA kodvägar mot riktig
 * Postgres, låter dem kasta på riktigt, och läser tillbaka med en NY klient efter
 * att den första kopplat ner. Det är närmaste analogin till ett containerbyte.
 *
 * ── VAD SOM SKILJER DE HÄR TVÅ FRÅN RAPPORTJOBBEN ───────────────────────────
 *
 * Rapportjobben fångar per org och SER LYCKADE UT även när allt föll. De här två
 * kastar hela vägen upp: utan sänkan var utfallet en tyst logg och en körning som
 * bara uteblev. Riggen kräver därför inte bara att jobbet inte kastar vidare —
 * den kräver att felet gick att HITTA efteråt, med jobbets namn i meddelandet.
 *
 * ── GALLRINGEN ÄR DEN SOM KOSTAR MEST ATT UPPTÄCKA SENT ─────────────────────
 *
 * Faller `ai-retention` upprepade gånger växer AiToolExecution, AiConversation,
 * AiMemory och AiUsageLog förbi sina frister utan att någon vet. Det är en
 * dataskyddsfråga, inte bara en driftfråga — och exakt den sortens tystnad som
 * en logg utan varaktighet inte kan larma om.
 */

// StorageService drar in @aws-sdk (ESM) som ts-jest inte transformerar. Nås
// aldrig här — båda jobben kastar på sin första fråga.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { AiAttachmentsService } from './attachments/ai-attachments.service'
import { AiRetentionService } from './retention/ai-retention.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { PlatformErrorsService } from '../platform/errors/platform-errors.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('#605 sista två: ai/:s cron-fel överlever processen', () => {
  const prisma = new PrismaClient()
  const märke = `QQAI-${randomUUID()}`
  let orgId = ''

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: `${märke}-org`,
        email: `${märke}@example.invalid`,
        street: 'Testgatan 1',
        city: 'Stockholm',
        postalCode: '11122',
      },
    })
    orgId = org.id
  })

  afterAll(async () => {
    await prisma.errorLog.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /** Läser tillbaka med en NY anslutning — efter att den som skrev är borta. */
  const raderEfterNedkoppling = async (): Promise<
    Array<{ message: string; severity: string; stack: string | null }>
  > => {
    await prisma.$disconnect()
    const efter = new PrismaClient()
    try {
      const rader = await efter.errorLog.findMany({
        where: { message: { contains: märke } },
        select: { message: true, severity: true, stack: true },
      })
      return rader
    } finally {
      await efter.$disconnect()
      await prisma.$connect()
    }
  }

  it('ai-attachments-cleanup kastar på riktigt → raden finns, och överlever klientens död', async () => {
    const sink = new CronErrorSink(new PlatformErrorsService(prisma as never))
    const service = new AiAttachmentsService(prisma as never, {} as never, sink)
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined)
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined)

    // FELET LÄGGS I ARBETET, inte i sänkan: den första frågan i städningen är
    // exakt den som en transient DB-blipp träffar i produktion.
    jest
      .spyOn(service as never, 'cleanupUnusedAttachments')
      .mockRejectedValue(new Error(`${märke}: bilagestädningen sprack`) as never)

    // Jobbets egen kodväg. runCronSafely sväljer efter rapportering, så en grön
    // körning här säger ingenting i sig — därför läsningen nedan.
    await expect(service.cleanupExpiredAttachments()).resolves.toBeUndefined()

    const rader = await raderEfterNedkoppling()
    expect(rader).toHaveLength(1)
    expect(rader[0]!.message).toContain('[cron:ai-attachments-cleanup]')
    expect(rader[0]!.message).toContain(märke)
    // Stacken följde med, så felet går att utreda och inte bara räkna.
    expect(rader[0]!.stack ?? '').toContain('Error')
  }, 30_000)

  it('ai-retention kastar på riktigt → raden finns, och överlever klientens död', async () => {
    await prisma.errorLog.deleteMany({ where: { message: { contains: märke } } })
    const sink = new CronErrorSink(new PlatformErrorsService(prisma as never))
    const service = new AiRetentionService(prisma as never, {} as never, sink)
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined)
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined)

    jest
      .spyOn(service, 'runRetention')
      .mockRejectedValue(new Error(`${märke}: gallringen sprack`) as never)

    await expect(service.scheduledRetention()).resolves.toBeUndefined()

    const rader = await raderEfterNedkoppling()
    expect(rader).toHaveLength(1)
    expect(rader[0]!.message).toContain('[cron:ai-retention]')
    expect(rader[0]!.message).toContain(märke)
    expect(rader[0]!.stack ?? '').toContain('Error')
  }, 30_000)

  it('KANARIEFÅGEL: riggen mäter något — utan det kastade felet skrivs ingen rad', async () => {
    // Utan den här kan proven ovan inte skilja "sänkan skrev" från "något annat
    // i sviten råkade lämna en rad med vårt märke".
    await prisma.errorLog.deleteMany({ where: { message: { contains: märke } } })
    const sink = new CronErrorSink(new PlatformErrorsService(prisma as never))
    const service = new AiRetentionService(prisma as never, {} as never, sink)
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined)
    jest
      .spyOn(service, 'runRetention')
      .mockResolvedValue({ mode: 'dry-run', tables: [], total: 0 } as never)
    jest
      .spyOn(service as unknown as { report: () => void }, 'report')
      .mockImplementation(() => undefined)

    await expect(service.scheduledRetention()).resolves.toBeUndefined()
    expect(await raderEfterNedkoppling()).toHaveLength(0)
  }, 30_000)
})
