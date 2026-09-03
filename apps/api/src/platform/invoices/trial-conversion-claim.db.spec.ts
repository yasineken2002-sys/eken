/**
 * TRIAL-KONVERTERINGEN UNDER SAMTIDIGHET — anspråket, inte ordningen.
 *
 * `convertExpiredTrialsCron` var klassificerad B ("skyddat av namngiven
 * invariant"), och invarianten löd: *uppdateringen gör kandidatvillkoret
 * falskt, så nästa körning inte längre ser raden.*
 *
 * Det är en SEKVENTIELL egenskap. Den svarar på "vad händer i morgon", inte på
 * "vad händer om två repliker startar samtidigt" — och det var den enda av de
 * tjugo B-invarianterna som inte svarade på samtidighetsfrågan.
 *
 * Mekaniken: `convertExpiredTrials` läser `expired` EN gång med en `findMany`
 * och skriver sedan per org. Två samtidiga körningar har båda listan i handen
 * innan någon hinner skriva, så en ovillkorlig `update({ where: { id } })`
 * kördes två gånger. Utfallet var inte en trasig rad — det var ETT MEJL FÖR
 * MYCKET till kunden, och en omskriven `planStartedAt` / `suspendedAt`.
 *
 * ── VAD SOM FAKTISKT BÄR SKYDDET (efter ändringen) ──────────────────────────
 *
 * Varje gren gör en `organization.updateMany` med kandidatvillkoret i sin
 * where-sats och hoppar över resten av grenen när `count === 0` — samma form
 * som `escalateOverdueRentNotices` i `rent-reminder.service.ts`. Databasen,
 * inte ordningen, avgör vem som vann.
 *
 * ── VARFÖR MEJLKÖN INTE RÄCKTE SOM SVAR ─────────────────────────────────────
 *
 * Mejlen ÄR Bull-dedupade (`platform-trial-converted-<orgId>`,
 * `platform-trial-expired-<orgId>`), så i praktiken var jobbet ofarligt. Men
 * det var inte den mekanismen som stod i kvitteringen, och skillnaden mellan
 * "skyddat" och "kvitterat som skyddat" är hela poängen med klassificeringen.
 * Riggen räknar därför ANROPEN till mejlkön, inte de köade jobben: Bull-dedupen
 * är ett andra lager, och ett prov som mäter det kan inte se om det första
 * lagret finns.
 *
 * ── VAD RIGGEN INTE KAN SE ──────────────────────────────────────────────────
 *
 *  • Att prod faktiskt kör två repliker. `numReplicas` är null (= 1); den här
 *    filen mäter vad som händer den dag det ändras.
 *  • Bull-dedupen. `mail.enqueue` är en stub som räknar anrop — det är med
 *    flit, se ovan.
 *  • De två samtidiga anropen sker i EN process mot EN databas. Det är
 *    databasen som gör anspråket atomärt, så formen är densamma över två
 *    processer, men det är inte mätt här.
 *  • Att de tre grenarna är alla skrivvägar. Att de ÄR tre ägs av
 *    `check-cron-classification.mjs` och av läsning, inte av det här provet.
 *
 * ── VAD FILEN RÖR I DATABASEN ───────────────────────────────────────────────
 *
 * `convertExpiredTrials()` är GLOBALT: den läser alla organisationer med
 * `status: 'TRIAL'` och utgången `trialEndsAt`, inte bara fixturerna. Kör den
 * inte mot en databas med riktiga trial-organisationer du bryr dig om.
 */

// Importkedjan drar in PdfService (Puppeteer) och StorageService (AWS SDK, ESM).
// Samma mockar som kodbasens övriga db-specar; de rör inte det som mäts.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { PlatformInvoicesService } from './platform-invoices.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Samtidighetsgraden. Två räcker: en tredje mäter samma sak en gång till. */
const N = 2

/** Poolen sätts explicit, aldrig ärvd från nproc (#695). Se marginalen nedan. */
const POOL = N + 8

/** Måste vara samma datum som `GRANDFATHER_CUTOFF` i tjänsten. */
const GRANDFATHER_CUTOFF = new Date('2026-05-15T00:00:00.000Z')

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

function dagarSedan(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('trial-konverteringen under samtidighet', () => {
  let prisma: PrismaClient
  let orgIds: string[] = []

  /** Varje anrop till mejlkön, i den ordning de gjordes. */
  let mejl: string[] = []
  /** Fel som per-org-isoleringen svalt. Ett tyst fel ser annars ut som ett skydd. */
  let svaldaFel: string[] = []

  function tjänst(): PlatformInvoicesService {
    const mail = {
      enqueue: async (jobb: { idempotencyKey?: string }) => {
        mejl.push(jobb.idempotencyKey ?? '(utan nyckel)')
        return { jobId: 'stub' }
      },
    }
    const config = { get: <T>(_k: string, def?: T) => def }
    const cronErrors = {
      report: async (namn: string, err: unknown) => {
        svaldaFel.push(`${namn}: ${err instanceof Error ? err.message : String(err)}`)
      },
    }
    // PDF-vägarna rörs inte av trial-konverteringen. Att de KASTAR om de ändå
    // anropas är halva assertionen — annars kan riggen tiga om en ny sidoeffekt.
    const orört = (namn: string) =>
      new Proxy(
        {},
        {
          get: () => () => {
            throw new Error(`${namn} orört`)
          },
        },
      )

    const s = Object.create(PlatformInvoicesService.prototype) as PlatformInvoicesService
    Object.assign(s, {
      prisma,
      mail,
      config,
      cronErrors,
      pdf: orört('pdf'),
      pdfQueue: orört('pdfQueue'),
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    return s
  }

  beforeAll(async () => {
    const url = urlMedPool(process.env.DATABASE_URL as string, POOL)
    const satt = Number(new URL(url).searchParams.get('connection_limit'))
    if (!(satt > N)) {
      throw new Error(
        `POOL, INTE ANSPRÅK: connection_limit=${satt} är inte större än N=${N}. ` +
          'Prismas default är nproc×2+1. Med en pool mindre än samtidigheten ' +
          'blir maxWait den bindande gränsen, och det ena anropet dör innan det ' +
          'hinner göra sitt anspråk — ett utfall som ser ut som ett fungerande ' +
          'anspråk. Riggen sätter poolen själv: får du det här felet är ' +
          'POOL-konstanten fel.',
      )
    }
    prisma = new PrismaClient({ datasources: { db: { url } } })
  })

  afterEach(async () => {
    // FK-RIKTNING: barnen först. Organization har `Restrict` mot bl.a. ErrorLog,
    // men riggen skapar inga barn — användare utelämnas med flit (mejlmottagaren
    // faller tillbaka på org.email), så bara organisationerna behöver bort.
    if (orgIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
      orgIds = []
    }
    mejl = []
    svaldaFel = []
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  /** En utgången trial. `sfx` håller e-post och namn unika per prov. */
  async function utgångenTrial(opts: {
    plan: 'TRIAL' | 'PRO'
    trialEndsAt: Date
    createdAt?: Date
  }): Promise<string> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `trial-${sfx}`,
        email: `trial-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        status: 'TRIAL',
        subscriptionPlan: opts.plan,
        trialEndsAt: opts.trialEndsAt,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
      select: { id: true },
    })
    orgIds.push(org.id)
    return org.id
  }

  it('CASE B (ingen plan vald): två samtidiga körningar → EN suspension, ETT mejl', async () => {
    // trialEndsAt efter grandfather-cutoffen, annars tar den grenen först.
    const id = await utgångenTrial({ plan: 'TRIAL', trialEndsAt: dagarSedan(20) })
    const s = tjänst()

    const utfall = await Promise.all(Array.from({ length: N }, () => s.convertExpiredTrials()))

    expect(svaldaFel).toEqual([])
    // ETT anrop till mejlkön — inte två som Bull sedan slår ihop.
    expect(mejl.filter((k) => k === `platform-trial-expired-${id}`)).toHaveLength(1)
    // Och EN statusändring: summorna räknas per gren som faktiskt skrev.
    expect(utfall.reduce((a, u) => a + u.suspended, 0)).toBe(1)
    expect(utfall.reduce((a, u) => a + u.converted + u.grandfathered, 0)).toBe(0)

    const efter = await prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    })
    expect(efter.status).toBe('SUSPENDED')
  })

  it('CASE A (plan vald): två samtidiga körningar → EN konvertering, ETT mejl', async () => {
    const id = await utgångenTrial({ plan: 'PRO', trialEndsAt: dagarSedan(20) })
    const s = tjänst()

    const utfall = await Promise.all(Array.from({ length: N }, () => s.convertExpiredTrials()))

    expect(svaldaFel).toEqual([])
    expect(mejl.filter((k) => k === `platform-trial-converted-${id}`)).toHaveLength(1)
    expect(utfall.reduce((a, u) => a + u.converted, 0)).toBe(1)
    expect(utfall.reduce((a, u) => a + u.suspended + u.grandfathered, 0)).toBe(0)

    const efter = await prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { status: true, planMonthlyFee: true },
    })
    expect(efter.status).toBe('ACTIVE')
    expect(Number(efter.planMonthlyFee)).toBe(9990)
  })

  it('GRANDFATHER: två samtidiga körningar → EN förlängning, INGET mejl', async () => {
    // Konto skapat före lanseringen, med en trial som slutade före cutoffen.
    const id = await utgångenTrial({
      plan: 'TRIAL',
      trialEndsAt: new Date('2026-02-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    const s = tjänst()

    const utfall = await Promise.all(Array.from({ length: N }, () => s.convertExpiredTrials()))

    expect(svaldaFel).toEqual([])
    expect(utfall.reduce((a, u) => a + u.grandfathered, 0)).toBe(1)
    // Grandfather-grenen mejlar inte. Att den ANDRA körningen inte heller föll
    // igenom till CASE B är hela poängen: `return` efter ett förlorat anspråk
    // hoppar över resten av grenen, inte bara skrivningen.
    expect(utfall.reduce((a, u) => a + u.converted + u.suspended, 0)).toBe(0)
    expect(mejl).toEqual([])

    const efter = await prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { status: true, trialEndsAt: true },
    })
    expect(efter.status).toBe('TRIAL')
    expect(efter.trialEndsAt!.getTime()).toBeGreaterThan(GRANDFATHER_CUTOFF.getTime())
  })
})
