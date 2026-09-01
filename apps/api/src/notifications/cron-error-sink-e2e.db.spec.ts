/**
 * #605 BATCH 1 — ETT CRON-FEL SKA FINNAS KVAR I MORGON, PÅ RIKTIGT.
 *
 * ── VARFÖR EN DB-RIGG OCH INTE EN ATTRAPP ───────────────────────────────────
 *
 * `cron-error-sink.spec.ts` mäter att sänkan ANROPAS och att den inväntas. Det
 * är en attrappmätning, och den kan inte svara på den enda fråga som betyder
 * något här: finns raden kvar när processen är borta?
 *
 * Den frågan går inte att ställa till en mock. Riggen kör därför jobbets EGEN
 * kodväg mot en riktig Postgres, låter den kasta på riktigt, och läser sedan
 * tillbaka raden med en NY klient efter att den första kopplat ner — vilket är
 * den närmaste analogin till att containern byts ut.
 *
 * ── VAD SOM ÄR VÄRT ATT VETA OM FORMEN ──────────────────────────────────────
 *
 * De tre rapportjobben fångar per organisation, räknar upp `failed`, och
 * fortsätter. Körningen loggar sedan "n skickade, m misslyckade" på log-nivå och
 * SER LYCKAD UT. Det är därför den här riggen inte nöjer sig med att jobbet inte
 * kastar: den kräver att felet gick att HITTA efteråt, kopplat till rätt org.
 */

// NotificationsService → MonthlyReportService → storage.service (AWS SDK, ESM)
// som jest inte kan parsa. Samma stubbning som övriga specar som transitivt rör
// storage — den nås aldrig här, genereringen kastar först.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { NotificationsService } from './notifications.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { PlatformErrorsService } from '../platform/errors/platform-errors.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('#605 batch 1: per-org-felet överlever processen', () => {
  const prisma = new PrismaClient()
  const märke = `QQE2E-${randomUUID()}`
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
    // Användaren behövs för sentinel-notisen jobbet skapar innan genereringen.
    await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `${märke}-user@example.invalid`,
        firstName: 'Test',
        lastName: 'Testsson',
        role: 'OWNER',
        isActive: true,
      },
    })
  })

  afterAll(async () => {
    await prisma.errorLog.deleteMany({ where: { organizationId: orgId } })
    await prisma.notification.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('jobbet kastar på riktigt → raden finns, och överlever att klienten dör', async () => {
    const errors = new PlatformErrorsService(prisma as never)
    const sink = new CronErrorSink(errors)
    const service = new NotificationsService(
      prisma as never,
      {} as never, // mail — nås aldrig, genereringen kastar först
      {} as never, // moduleRef
      {} as never, // monthlyReport
      {} as never, // locks — Unsafe-varianten anropas direkt
      sink,
    )
    // Tysta den lokala loggern: riggen mäter den VARAKTIGA raden, inte utskriften.
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined)
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined)

    // JOBBET KASTAR PÅ RIKTIGT — inte sänkan, utan arbetet inuti loopen.
    service['aiService'] = {
      generateDailyInsights: async () => {
        throw new Error(`${märke}: genereringen sprack`)
      },
    } as never

    // Jobbets egen kodväg. Den fångar per org och fortsätter — alltså kastar den
    // INTE vidare, och en grön körning här säger ingenting i sig.
    await expect(service['sendMorningInsightsUnsafe']()).resolves.toBeUndefined()

    // Klienten kopplar ner — närmaste analogin till att containern byts ut.
    await prisma.$disconnect()

    // NY klient, ny anslutning: fanns raden kvar utan den som skrev den?
    const efter = new PrismaClient()
    try {
      const rader = await efter.errorLog.findMany({ where: { organizationId: orgId } })
      expect(rader).toHaveLength(1)
      expect(rader[0]!.severity).toBe('CRITICAL')
      expect(rader[0]!.source).toBe('API')
      expect(rader[0]!.message).toContain('[cron:morning-insights]')
      expect(rader[0]!.message).toContain(märke)
      // Kopplad till RÄTT kund — annars går en utebliven rapport inte att spåra.
      expect(rader[0]!.organizationId).toBe(orgId)
      expect(rader[0]!.context).toMatchObject({ cron: 'morning-insights', steg: 'generering' })
      // …och stacken följde med, så felet går att utreda och inte bara räkna.
      expect(rader[0]!.stack ?? '').toContain('Error')
    } finally {
      await efter.$disconnect()
    }

    // Återanslut för afterAll-städningen.
    await prisma.$connect()
  }, 30_000)

  it('KANARIEFÅGEL: riggen mäter något — utan det kastade felet skrivs ingen rad', async () => {
    // Utan den här kan provet ovan inte skilja "sänkan skrev" från "något annat
    // i sviten råkade lämna en rad för den här orgen".
    await prisma.errorLog.deleteMany({ where: { organizationId: orgId } })
    const errors = new PlatformErrorsService(prisma as never)
    const sink = new CronErrorSink(errors)
    const service = new NotificationsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sink,
    )
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined)
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined)
    // Ingen genereringsinsikt → `if (!insights) continue`, alltså inget kast.
    service['aiService'] = { generateDailyInsights: async () => null } as never

    await service['sendMorningInsightsUnsafe']()
    const rader = await prisma.errorLog.findMany({ where: { organizationId: orgId } })
    expect(rader).toHaveLength(0)
  }, 30_000)
})
