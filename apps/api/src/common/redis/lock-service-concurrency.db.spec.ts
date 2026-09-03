/**
 * CRON-LÅSET UNDER SAMTIDIGHET — mekanismen MÄTT, inte bara påkopplad.
 *
 * `docs/revision-status.md` bar posten om H6:s replikantal som en UTTRYCKLIG
 * ICKE-MÄTNING: prod kör `numReplicas: null` (= 1), så ingen dubbelkörning KAN
 * inträffa i dag — oavsett om låsen fungerar. Skyddet var alltså en
 * DEPLOYINSTÄLLNING, och frågan den inställningen dolde var aldrig ställd:
 * håller låset den dag tjänsten skalas upp? Den här filen är den mätningen.
 *
 * ── LÅSET BOR I REDIS, INTE I POSTGRES ──────────────────────────────────────
 *
 * `LockService.runIfUnlocked` (`lock.service.ts:102-137`) gör
 * `SET lock:<key> <token> EX <ttl> NX` (`:110`) och släpper via ett Lua-script
 * som bara DEL:ar när värdet matchar den EGNA token (`:5-11`, anropat `:132`).
 * Ingen advisory lock, ingen tabellrad, ingen städare. Att `SET NX` ger exakt en
 * vinnare är en egenskap hos REDIS — den kan inte mätas mot en attrapp, bara
 * mot en riktig server. Därför `.db.spec.ts` och därför `REDIS_URL`.
 *
 * Alla tio klass-A-jobben delar metoden. Uppmätt vid skrivandet: tio
 * `runIfUnlocked`-anrop i produktionskod, fördelade på tre TTL:er —
 * `CRON_LOCK_TTL_SEC` 1800 s (6 jobb), `ACTIVATION_REMINDER_LOCK_TTL_SEC`
 * 900 s (1), `LAS_TTL_SEC` 60 s (3).
 *
 * ── REPRESENTANTJOBBET: ai-usage dailyCheck, och urvalet är HALVA MÄTNINGEN ──
 *
 * Valt av ett skäl, inte av bekvämlighet: det är det enda av de tio A-jobben
 * vars kod uttryckligen säger att LÅSET ÄR ENDA SKYDDET —
 * `ai-usage-notifier.service.ts`: "`notifications.create` är en oskyddad insert:
 * två körningar ger TVÅ notisrader till samma admin om samma tröskel."
 *
 * `leases.processLifecycle` valdes BORT med flit. Det jobbet har både lås OCH
 * ett anspråk (villkorad `updateMany`), och koden säger själv att de skyddar
 * olika saker. En kanariefågel utan lås hade därför gett EN effekt ändå —
 * vilket ser ut som ett fungerande lås men mäter anspråket. Ett instrument som
 * inte kan ge det andra svaret mäter ingenting.
 *
 * ── POOLEN SÄTTS EXPLICIT (samma skäl som #695) ─────────────────────────────
 *
 * Prismas pool är `nproc × 2 + 1` när `connection_limit` inte är satt — 5 på en
 * tvåkärnig maskin, ~97 i prod-containern. Ett tal som beror på runnerns
 * kärnantal är inte en mätning, så filen skapar sin egen klient med poolen satt
 * i URL:en och ASSERTAR den, med ett felmeddelande som säger POOL och inte lås.
 *
 * Marginalen är med flit större än vad filen behöver: Postgres-samtidigheten
 * här är TVÅ (de två `dailyCheck`-anropen), medan N = 10 är REDIS-samtidigheten
 * i a-fallen. Assertionen `POOL > N` är alltså strängare än nödvändigt — den
 * står så för att konstanten inte tyst ska bli den bindande gränsen den dag
 * någon höjer samtidigheten i b/c.
 *
 * ── VAD FILEN INTE KAN SE ───────────────────────────────────────────────────
 *
 *  • ATT PROD FAKTISKT SKALAS. Replikantalet är en Railway-inställning; filen
 *    simulerar två repliker med två anrop i EN process. Att `numReplicas` är
 *    null måste läsas ur Railway, inte härledas härifrån.
 *  • DE NIO ANDRA A-JOBBEN. Ett representantjobb belägger MEKANISMEN
 *    (`LockService`, delad av alla tio), inte varje jobbs egen kropp. Ett jobb
 *    som slutar ta låset är osynligt här — det ägs av
 *    `check-cron-classification.mjs`, som mäter påkopplingen.
 *  • DE TJUGO B-JOBBEN. De vilar på namngivna invarianter, inte på låset.
 *  • ETT HÄNGT LÅS ÖVER EN RIKTIG TTL-GRÄNS. TTL:n är 1 800 s för sex av
 *    jobben; provet nedan mäter utgången med en TTL på 2 s. Formen är densamma,
 *    väntetiden är det inte.
 *  • ATT ETT HÄNGT LÅS LARMAR. Det gör det inte: `heldForSec` finns men saknar
 *    läsare för nio av tio jobb. Det är ett eget ärende, inte en brist här.
 *
 * ── VAD FILEN RÖR I DATABASEN ───────────────────────────────────────────────
 *
 * `dailyCheck()` är ett GLOBALT jobb: det läser ALLA organisationer som matchar
 * cronens egna filter, inte bara fixturen. Räkningen nedan är scopad till
 * fixturens org, och städningen raderar exakt de notisrader anropen skapade
 * (id:n fångas i stubben) — även rader som hörde till en annan org.
 *
 * Det filen INTE kan städa är `checkTrialStatus`, som kan flippa en org till
 * SUSPENDED. Den vägen kräver `trialEndsAt != null` OCH `planStartedAt` äldre
 * än 31 dagar. Fixturen har `trialEndsAt: null` och är alltså utanför; en tom
 * eller färsk databas har inga andra kandidater. KÖR INTE FILEN MOT EN DATABAS
 * MED GAMLA TRIAL-ORGANISATIONER du bryr dig om.
 */

// Importkedjan AiUsageNotifier → Notifications → monthly-report → storage drar
// in AWS SDK (ESM, transformeras inte av jest) och Puppeteer. Samma två mockar
// som kodbasens övriga db-specar. De rör inte det som mäts.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient, UserRole } from '@prisma/client'
import Redis from 'ioredis'

import { AiUsageNotifierService } from '../../ai-usage/ai-usage-notifier.service'
import { LockService } from './lock.service'
import type { RedisService } from './redis.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const HAR_REDIS = Boolean(process.env.REDIS_URL)
const medDb = HAR_DB && HAR_REDIS ? describe : describe.skip

/** Representantjobbets låsnyckel — `runIfUnlocked` prefixar själv med `lock:`. */
const CRON_NYCKEL = 'cron:ai-usage-warnings'
const CRON_LÅSKEY = `lock:${CRON_NYCKEL}`

/** Riggens egna nycklar. Städas som mängd, inte en och en. */
const TESTPREFIX = 'h6lock'

/** Samtidighetsgraden mot Redis. Skrivs ut i provnamnet — ett tal i prosan glider. */
const N = 10

/** Poolen: satt explicit, aldrig ärvd från nproc. Se huvudet. */
const POOL = N + 5

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot RIKTIG Postgres OCH riktig Redis', () => {
    expect(HAR_DB).toBe(true)
    expect(HAR_REDIS).toBe(true)
  })
})

medDb('cron-låset under samtidighet', () => {
  let prisma: PrismaClient
  let redis: Redis
  let locks: LockService
  let orgId: string
  let userId: string

  /** Notis-id:n som riggens stub skapat — städas exakt, inte med tidsfönster. */
  let skapadeNotiser: string[] = []
  /** Fel som cron-sänkan svalt. Ett tyst fel ger noll notiser, inte ett kast. */
  let svaldaFel: string[] = []

  function nyckel(): string {
    return `${TESTPREFIX}:${randomUUID()}`
  }

  beforeAll(async () => {
    // POOLEN FÖRST, som en assertion vars felmeddelande pekar på POOL och inte
    // på lås — annars läses ett anslutningsfel som ett låsfel.
    const url = urlMedPool(process.env.DATABASE_URL as string, POOL)
    const satt = Number(new URL(url).searchParams.get('connection_limit'))
    if (!(satt > N)) {
      throw new Error(
        `POOL, INTE LÅS: connection_limit=${satt} är inte större än N=${N}. ` +
          'Prismas default är nproc×2+1 (2 kärnor → 5). Med en pool mindre än ' +
          'samtidigheten blir maxWait den bindande gränsen, och anrop som inte ' +
          'kan låsa varandra dör ändå — ett utfall som ser ut som ett låsfel. ' +
          'Riggen sätter poolen själv: får du det här felet är POOL-konstanten fel.',
      )
    }

    prisma = new PrismaClient({ datasources: { db: { url } } })
    redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 3 })
    expect(await redis.ping()).toBe('PONG')

    // Riktig LockService över en riktig Redis-klient. RedisService exponerar
    // bara `client`; att gå via konstruktorn i stället för Object.create gör att
    // en ändrad konstruktor fäller filen i stället för att kringgås av den.
    locks = new LockService({ client: redis } as unknown as RedisService)

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `h6-${sfx}`,
        email: `h6-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        status: 'ACTIVE',
        subscriptionPlan: 'TRIAL', // PLAN_LIMITS.TRIAL.monthlyAiCalls = 100
        trialEndsAt: null, // håller checkTrialStatus utanför — se huvudet
      },
      select: { id: true },
    })
    orgId = org.id

    const u = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `h6-u-${sfx}@example.se`,
        firstName: 'Mät',
        lastName: 'Ning',
        role: UserRole.OWNER,
        isActive: true,
      },
      select: { id: true },
    })
    userId = u.id

    // 80 manuella anrop mot ett tak på 100 → 80 %. Exakt EN passerad tröskel
    // (80; 95 och 100 passeras inte) och exakt EN admin → en notis per körning.
    // Talet får inte vara ≥ 95: då blir effekten två notiser och b/c mäter inte
    // längre skillnaden mellan en och två körningar.
    await prisma.aiUsageLog.createMany({
      data: Array.from({ length: 80 }, () => ({
        organizationId: orgId,
        userId,
        endpoint: '/v1/ai/chat',
        model: 'claude-opus-5',
        costUsd: 0,
        costSek: 0,
        isAutomated: false,
      })),
    })
  })

  afterEach(async () => {
    // STÄDNINGEN GÅR I FK-RIKTNING: barnen först. Notification pekar på både
    // Organization och User, så den måste bort före dem — fixturen tas ned i
    // afterAll, men raderna varje prov skapar tas ned här, annars bygger nästa
    // prov på föregående provs skräp.
    if (skapadeNotiser.length > 0) {
      await prisma.notification.deleteMany({ where: { id: { in: skapadeNotiser } } })
      skapadeNotiser = []
    }
    svaldaFel = []

    // Redis städas som MÄNGD: riggens egna nycklar plus representantjobbets.
    // Ett lås som ligger kvar gör nästa prov grönt av fel skäl (det hoppar
    // över) i stället för rött.
    const kvar = await redis.keys(`lock:${TESTPREFIX}:*`)
    if (kvar.length > 0) await redis.del(...kvar)
    await redis.del(CRON_LÅSKEY)
  })

  // ── a) SJÄLVA LÅSMEKANISMEN ───────────────────────────────────────────────

  describe('a) låsmekanismen', () => {
    it(`N=${N} samtidiga försök på SAMMA nyckel → exakt EN kör`, async () => {
      const key = nyckel()
      let inne = 0
      let maxSamtidigt = 0

      const utfall = await Promise.all(
        Array.from({ length: N }, () =>
          locks.runIfUnlocked(
            key,
            async () => {
              inne += 1
              maxSamtidigt = Math.max(maxSamtidigt, inne)
              await new Promise((r) => setTimeout(r, 120))
              inne -= 1
              return 'kört'
            },
            { ttlSec: 30 },
          ),
        ),
      )

      expect(utfall.filter((u) => u.ran)).toHaveLength(1)
      expect(utfall.filter((u) => !u.ran)).toHaveLength(N - 1)
      // Ingen väntan: de nio ger upp direkt. `runIfUnlocked` är just detta —
      // `runWithLock` hade väntat ut den första och sedan kört jobbet en andra
      // gång, vilket gör dubbelkörningen långsammare men inte omöjlig.
      expect(maxSamtidigt).toBe(1)
    })

    it('de som INTE fick låset får heldForSec, inte ett undantag', async () => {
      const key = nyckel()
      const utfall = await Promise.all(
        Array.from({ length: N }, () =>
          locks.runIfUnlocked(key, () => new Promise((r) => setTimeout(() => r(1), 100)), {
            ttlSec: 30,
          }),
        ),
      )

      const nekade = utfall.filter((u): u is { ran: false; heldForSec: number | null } => !u.ran)
      expect(nekade).toHaveLength(N - 1)
      // Talet finns för att ett normalt överhopp ska gå att skilja från ett
      // HÄNGT lås. Att det ÄR satt är poängen, inte dess exakta värde — det
      // beror på hur snabbt maskinen hann.
      for (const n of nekade) expect(n.heldForSec).not.toBeUndefined()
    })

    it('låset SLÄPPS när innehavaren är klar', async () => {
      const key = nyckel()
      await locks.runIfUnlocked(key, async () => 'klar', { ttlSec: 30 })
      expect(await redis.get(`lock:${key}`)).toBeNull()

      const igen = await locks.runIfUnlocked(key, async () => 'igen', { ttlSec: 30 })
      expect(igen.ran).toBe(true)
    })

    it('låset SLÄPPS även när innehavaren KASTAR', async () => {
      const key = nyckel()
      await expect(
        locks.runIfUnlocked(
          key,
          async () => {
            throw new Error('jobbet kastade')
          },
          { ttlSec: 30 },
        ),
      ).rejects.toThrow('jobbet kastade')

      // `finally` släpper även på undantagsvägen. Gjorde den inte det vore ett
      // kraschat jobb detsamma som ett avstängt jobb fram till TTL.
      expect(await redis.get(`lock:${key}`)).toBeNull()
      const igen = await locks.runIfUnlocked(key, async () => 'igen', { ttlSec: 30 })
      expect(igen.ran).toBe(true)
    })

    it('DEN OMVÄNDA RIKTNINGEN: dör innehavaren utan release ligger låset kvar till TTL', async () => {
      const key = nyckel()
      // En process som DOG: SET utan att någonsin köra release. Det finns ingen
      // städare — TTL:n är hela taket.
      await redis.set(`lock:${key}`, 'token-fran-dod-process', 'EX', 2, 'NX')

      const under = await locks.runIfUnlocked(key, async () => 'skulle inte köra', {
        ttlSec: 30,
      })
      expect(under.ran).toBe(false)

      await new Promise((r) => setTimeout(r, 2300))

      const efter = await locks.runIfUnlocked(key, async () => 'kör nu', { ttlSec: 30 })
      expect(efter.ran).toBe(true)
    })

    it('release DEL:ar bara den EGNA token — inte en efterföljares lås', async () => {
      const key = nyckel()
      const låskey = `lock:${key}`

      // A tar låset med kort TTL, det löper ut, B tar det. A:s finally får inte
      // radera B:s lås — utan tokenjämförelsen vore två repliker i tur och
      // ordning nog för att låsa upp varandra.
      await redis.set(låskey, 'token-A', 'EX', 1, 'NX')
      await new Promise((r) => setTimeout(r, 1200))
      await redis.set(låskey, 'token-B', 'EX', 30, 'NX')

      // Samma Lua som lock.service.ts:5-11. Kopian är med flit ordagrann: den
      // mäter att REDIS gör rätt sak, medan provet ovanför mäter att tjänsten
      // anropar den.
      const RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`
      const raderade = await redis.eval(RELEASE, 1, låskey, 'token-A')

      expect(raderade).toBe(0)
      expect(await redis.get(låskey)).toBe('token-B')
    })
  })

  // ── b) och c) REPRESENTANTJOBBET ──────────────────────────────────────────

  describe('b/c) ai-usage dailyCheck som representant', () => {
    function tjänst(medLås: boolean): AiUsageNotifierService {
      // `notifications.create` görs som en RIKTIG insert mot samma tabell som
      // produktionen skriver i — det är den oskyddade skrivningen provet
      // räknar. Hela NotificationsService importeras inte: den drar in
      // AI-assistenten och mejlkedjan, som inte är det som mäts.
      const notifications = {
        create: async (
          organizationId: string,
          user: string,
          type: string,
          title: string,
          message: string,
        ) => {
          const rad = await prisma.notification.create({
            data: { organizationId, userId: user, type: type as never, title, message },
            select: { id: true },
          })
          skapadeNotiser.push(rad.id)
          return rad
        },
      }

      const mail = { enqueue: async () => ({ jobId: 'stub' }) }

      // Sänkan SPARAR i stället för att svälja. `forEachOrgSafely` fångar allt
      // per org, så ett fel inne i jobbet hade annars gett noll notiser — och
      // "spärren fungerade" och "jobbet kraschade" ser då likadana ut.
      const cronErrors = {
        report: async (namn: string, err: unknown) => {
          svaldaFel.push(`${namn}: ${err instanceof Error ? err.message : String(err)}`)
        },
      }

      // KANARIEFÅGELN NEUTRALISERAR LÅSET I RIGGEN, INTE I TJÄNSTEFILEN. En
      // attrapp som alltid kör `fn` ÄR "utan lås", och den ska ge TVÅ effekter.
      // Gör den inte det mäter provet ovanför inte det raden handlar om.
      const låsAttrapp = medLås
        ? locks
        : ({
            runIfUnlocked: async <T>(_k: string, fn: () => Promise<T>) => ({
              ran: true as const,
              value: await fn(),
            }),
          } as unknown as LockService)

      const s = Object.create(AiUsageNotifierService.prototype) as AiUsageNotifierService
      Object.assign(s, {
        prisma,
        mail,
        notifications,
        locks: låsAttrapp,
        cronErrors,
        logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      })
      return s
    }

    it('b) TVÅ SAMTIDIGA anrop av dailyCheck() → EXAKT EN effekt', async () => {
      const s = tjänst(true)
      await Promise.all([s.dailyCheck(), s.dailyCheck()])

      expect(svaldaFel).toEqual([])
      expect(await prisma.notification.count({ where: { organizationId: orgId } })).toBe(1)
    })

    it('c) KANARIEFÅGEL: samma två anrop UTAN lås → TVÅ effekter', async () => {
      const s = tjänst(false)
      await Promise.all([s.dailyCheck(), s.dailyCheck()])

      expect(svaldaFel).toEqual([])
      // Utan det här utfallet vore provet ovanför inget bevis: en spärr som
      // inte kan fälla och en insert som inte kan dubbleras ser likadana ut.
      expect(await prisma.notification.count({ where: { organizationId: orgId } })).toBe(2)
    })
  })

  // EN afterAll, sist. Jest kör afterAll i deklarationsordning inom samma
  // block — en tidigare hook som stänger klienterna hade fällt städningen här.
  afterAll(async () => {
    if (orgId) {
      await prisma.notification.deleteMany({ where: { organizationId: orgId } })
      await prisma.aiUsageLog.deleteMany({ where: { organizationId: orgId } })
      await prisma.user.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.delete({ where: { id: orgId } })
    }
    const kvar = await redis.keys(`lock:${TESTPREFIX}:*`)
    if (kvar.length > 0) await redis.del(...kvar)
    await redis.del(CRON_LÅSKEY)
    await redis.quit()
    await prisma.$disconnect()
  })
})
