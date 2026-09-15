/**
 * DEN ENDA SKRIVANDE STARTVÄGEN — grindad, och nu mätt.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * `DepositsService.onApplicationBootstrap` är appens enda automatiska startjobb
 * som SKRIVER i databasen utan att gå via cron eller en kö: den skapar
 * `Deposit`-rader och bokför 1510 D / 2890 K. Den inträffar dessutom TIDIGAST av
 * alla automatiska effekter — före första requesten, före första jobbet.
 *
 * Grinden är trivial att läsa (en tidig `return`), och det var precis därför den
 * saknade prov: en rad som ser uppenbar ut mäts inte. En oberoende granskare
 * påpekade att ingen spec i repot rörde den, och att `check-automation-pause.mjs`
 * per konstruktion inte kan se livscykel-hookar — vakten härleder @Processor,
 * ScheduleModule och registerQueue, inget annat.
 *
 * ── NODE_ENV-GRINDEN STÅR KVAR, OCH ÄR EN ANNAN FRÅGA ───────────────────────
 *
 * `NODE_ENV=test` fanns före den här ändringen och rör en annan sak ("kör vi i
 * testmiljö?"). Att slå ihop de två hade gjort det omöjligt att pausa en
 * PRODUKTIONSprocess utan att också ljuga om NODE_ENV — en genväg
 * avskärmningsordningen uttryckligen förbjuder. Proven nedan kör därför med
 * NODE_ENV satt till något annat än 'test', annars hade den första grinden
 * svarat och den andra aldrig mätts.
 */

// Samma mock som de befintliga deposits-specarna (`deposits-lifecycle-41.spec.ts`,
// `deposits.compliance.spec.ts`): utan den drar modulgrafen in
// `@aws-sdk/client-s3`, vars beroende levereras som ESM och fäller ts-jest.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Logger } from '@nestjs/common'
import { DepositsService } from './deposits.service'
import { AUTOMATION_PAUSE_VAR } from '../common/ops/automation-pause'

interface Provinstans {
  onApplicationBootstrap(): Promise<void>
  backfillOrphanDepositNotices: jest.Mock
  logger: Logger
}

function skapa(): { svc: Provinstans; backfill: jest.Mock; warn: jest.SpyInstance } {
  const backfill = jest.fn().mockResolvedValue(undefined)
  // Instansen byggs utan konstruktor: hooken beror bara på `logger` och
  // `backfillOrphanDepositNotices`, och en riktig konstruktor hade dragit in
  // Prisma, bokföringen, notiserna och fakturahändelserna — fyra beroenden som
  // inte har med grinden att göra. `logger` är `private readonly` på klassen,
  // därav den smala vyn ovan i stället för en korsning med DepositsService
  // (TypeScript reducerar en sådan korsning till `never`).
  const svc = Object.create(DepositsService.prototype) as Provinstans
  svc.backfillOrphanDepositNotices = backfill
  const logger = new Logger('prov')
  Object.defineProperty(svc, 'logger', { value: logger, writable: true })
  // Tystar utskriften utan att dölja ATT den skedde — spionen är själv ett
  // mätobjekt längre ned.
  const warn = jest.spyOn(logger, 'warn').mockReturnValue(undefined)
  return { svc, backfill, warn }
}

describe('DepositsService.onApplicationBootstrap × driftpaus', () => {
  const sparat = { ...process.env }
  afterEach(() => {
    process.env = { ...sparat }
    jest.restoreAllMocks()
  })

  it('KANARIEFÅGELN: utan paus KÖRS backfillen — annars mäter proven nedan ingenting', async () => {
    process.env['NODE_ENV'] = 'production'
    delete process.env[AUTOMATION_PAUSE_VAR]
    const { svc, backfill } = skapa()

    await svc.onApplicationBootstrap()

    expect(backfill).toHaveBeenCalledTimes(1)
  })

  it('i pausat läge körs den INTE — inga Deposit-rader, inga bokföringsposter', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env[AUTOMATION_PAUSE_VAR] = 'true'
    const { svc, backfill } = skapa()

    await svc.onApplicationBootstrap()

    expect(backfill).not.toHaveBeenCalled()
  })

  it('den pausade vägen LOGGAR — en utebliven skrivning ska synas, inte vara tyst', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env[AUTOMATION_PAUSE_VAR] = 'true'
    const { svc, warn } = skapa()

    await svc.onApplicationBootstrap()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(AUTOMATION_PAUSE_VAR)
  })

  it("OPS_AUTOMATION_PAUSED='false' kör som förut — normal drift är oförändrad", async () => {
    process.env['NODE_ENV'] = 'production'
    process.env[AUTOMATION_PAUSE_VAR] = 'false'
    const { svc, backfill } = skapa()

    await svc.onApplicationBootstrap()

    expect(backfill).toHaveBeenCalledTimes(1)
  })

  it('ett OGILTIGT värde KASTAR i stället för att tyst köra backfillen', async () => {
    // Fail-closed även här: den här vägen SKRIVER, så en felstavning får absolut
    // inte tolkas som "inte pausad".
    process.env['NODE_ENV'] = 'production'
    process.env[AUTOMATION_PAUSE_VAR] = 'ture'
    const { svc, backfill } = skapa()

    await expect(svc.onApplicationBootstrap()).rejects.toThrow(AUTOMATION_PAUSE_VAR)
    expect(backfill).not.toHaveBeenCalled()
  })

  it("NODE_ENV='test' står kvar och svarar FÖRST — den grinden är en annan fråga", async () => {
    process.env['NODE_ENV'] = 'test'
    delete process.env[AUTOMATION_PAUSE_VAR]
    const { svc, backfill } = skapa()

    await svc.onApplicationBootstrap()

    expect(backfill).not.toHaveBeenCalled()
  })
})
