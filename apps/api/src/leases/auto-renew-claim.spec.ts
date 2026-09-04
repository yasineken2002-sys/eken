/**
 * AUTO-FÖRNYELSEN: LÅSET OCH ANSPRÅKET SKYDDAR OLIKA SAKER.
 *
 * ── VARFÖR BÅDA BEHÖVS ───────────────────────────────────────────────────────
 *
 *   LÅSET (`runIfUnlocked`) skyddar mot SAMTIDIGHET — två repliker som kör
 *   jobbet samtidigt. Prod kör i dag en instans (`numReplicas: null`), så det är
 *   förebyggande: skyddet är en DEPLOYINSTÄLLNING, inte en kodinvariant.
 *
 *   ANSPRÅKET (villkorad `updateMany`) skyddar mot OMTAG — en omstart mitt i
 *   loopen, ett manuellt återkörande, en framtida retry. Det gäller redan i EN
 *   instans, alltså i dag.
 *
 * Ett lås ovanpå den gamla ovillkorliga `update` + `create` hade sett ut som ett
 * löst problem. Därför prövas de var för sig här.
 *
 * ── VARFÖR MOT RIKTIG REDIS OCH RIKTIG POSTGRES ──────────────────────────────
 *
 * Båda egenskaperna är egenskaper hos INFRASTRUKTUREN, inte hos koden: att
 * `SET NX` ger exakt en vinnare, och att `updateMany` med ett statusvillkor ger
 * `count = 1` för exakt en av två samtidiga körningar. En attrapp bevisar bara
 * att man skrev sin egen attrapp rätt.
 */

import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { PrismaService } from '../common/prisma/prisma.service'
import { LockService } from '../common/redis/lock.service'

/**
 * Hjärtslagsstubb (#710). `LockService` tar numera en PrismaService för att
 * skriva CronHeartbeat. Beroendet är OBLIGATORISKT och inte valfritt med flit:
 * en valfri sänka hade tyst tappat hjärtslaget hos varje anropare som glömde
 * den, och tystnaden är precis det ärendet handlar om. De här proven mäter
 * låsningen, inte hjärtslaget — det ägs av lock-heartbeat.spec.ts och
 * cron-heartbeat.db.spec.ts.
 */
const hjärtslagStubb = () =>
  ({ cronHeartbeat: { upsert: () => Promise.resolve({}) } }) as unknown as PrismaService

const HAR_DB = Boolean(process.env.DATABASE_URL)
const HAR_REDIS = Boolean(process.env.REDIS_URL)
const medDb = HAR_DB ? describe : describe.skip
const medRedis = HAR_REDIS ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot RIKTIG databas och RIKTIG Redis', () => {
    // Utan den här raden är filen grön av att den hoppades över. Se CLAUDE.md:
    // en kontroll som inte kan falla mäter ingenting.
    expect(HAR_DB).toBe(true)
    expect(HAR_REDIS).toBe(true)
  })
})

medRedis('(3) LÅSET — två samtidiga körningar av ett låst jobb', () => {
  let client: Redis
  let locks: LockService

  beforeAll(() => {
    // ioredis DIREKT i stället för RedisService: låset använder bara
    // `redis.client`, och Nest-wrappern drar in ConfigService plus en
    // felhanterare som håller processen vid liv efter att testet är klart.
    client = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 2 })
    locks = new LockService({ client } as never, hjärtslagStubb())
  })
  afterAll(async () => {
    await client.quit()
  })

  it('exakt EN körning gör arbetet — den andra hoppar över', async () => {
    const nyckel = `cron:zzsond-${randomUUID().slice(0, 8)}`
    let körningar = 0
    const arbete = async () => {
      körningar += 1
      await new Promise((r) => setTimeout(r, 60))
      return 'klart'
    }

    const [a, b] = await Promise.all([
      locks.runIfUnlocked(nyckel, arbete, { ttlSec: 30 }),
      locks.runIfUnlocked(nyckel, arbete, { ttlSec: 30 }),
    ])

    // DET AVGÖRANDE: arbetet utfördes en gång, inte två.
    expect(körningar).toBe(1)
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1)
  })

  it('KANARIEFÅGEL: två OLIKA nycklar blockerar inte varandra', async () => {
    // Utan det här fallet vore "ett lås som alltid blockerar" lika grönt som ett
    // som blockerar rätt — och ett cron-lås som stänger av allt är värre än inget.
    let körningar = 0
    const arbete = async () => {
      körningar += 1
      return 'klart'
    }
    const [a, b] = await Promise.all([
      locks.runIfUnlocked(`cron:zzsond-${randomUUID().slice(0, 8)}`, arbete, { ttlSec: 30 }),
      locks.runIfUnlocked(`cron:zzsond-${randomUUID().slice(0, 8)}`, arbete, { ttlSec: 30 }),
    ])
    expect(körningar).toBe(2)
    expect(a.ran && b.ran).toBe(true)
  })
})

describe('anspråket i PRODUKTIONSKODEN', () => {
  // ── VARFÖR DEN HÄR KONTROLLEN BEHÖVS ──────────────────────────────────────
  //
  // Testerna nedan prövar anspråkets FORM mot riktig Postgres, men de gör det
  // med en egen kopia av frågan. Skrivs produktionskoden tillbaka till den
  // ovillkorliga `update` fortsätter de vara gröna — och de befintliga
  // lease-specarna med, eftersom deras attrapper har både `update` och
  // `updateMany`.
  //
  // Den här läser källan och kräver att anspråket faktiskt står där. Ett test
  // som prövar en regel utan att pröva att den är PÅKOPPLAD mäter halva saken.
  it('autoRenewExpiredFixedTerm anspråkar med en VILLKORAD updateMany', () => {
    const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs')
    const { join } = jest.requireActual<typeof import('node:path')>('node:path')
    const källa: string = readFileSync(join(__dirname, 'leases.service.ts'), 'utf8')
    // DEFINITIONEN, inte anropsstället. `indexOf('autoRenew…')` hittade
    // anropet i processLifecycle och läste fel kropp — testet fällde sig självt
    // på det, vilket är precis vad det ska göra när det läser fel ställe.
    const i = källa.indexOf('private async autoRenewExpiredFixedTerm')
    expect(i).toBeGreaterThan(-1)
    const kropp = källa.slice(i, i + 6000)

    // Anspråket: updateMany med statusvillkoret, och en count-grind.
    expect(kropp).toMatch(/tx\.lease\.updateMany\(\{/)
    expect(kropp).toContain("status: 'ACTIVE'")
    expect(kropp).toMatch(/claim\.count === 0/)

    // Och INTE den gamla ovillkorliga skrivningen på samma rad-id.
    expect(kropp).not.toMatch(/tx\.lease\.update\(\{\s*where: \{ id: lease\.id \}/)
  })
})

medDb('(4+5) ANSPRÅKET — villkorad updateMany mot riktig Postgres', () => {
  let prisma: PrismaService
  let orgId: string
  let unitId: string
  let tenantId: string

  beforeAll(async () => {
    prisma = new PrismaService()
    await prisma.$connect()
    const org = await prisma.organization.create({
      data: {
        name: `zz-claim-${randomUUID().slice(0, 8)}`,
        orgNumber: `55${Math.floor(Math.random() * 10_000_000)
          .toString()
          .padStart(8, '0')}`,
        email: 'zz@example.test',
        street: 'Gatan 1',
        city: 'Stockholm',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const prop = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'zz-fastighet',
        propertyDesignation: 'ZZ 1:1',
        street: 'Gatan 1',
        postalCode: '11111',
        city: 'Stockholm',
        type: 'RESIDENTIAL',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        unitNumber: '1001',
        name: 'zz-enhet',
        type: 'APARTMENT',
        area: 50,
        rooms: 2,
        monthlyRent: 10000,
        status: 'OCCUPIED',
      },
      select: { id: true },
    })
    unitId = unit.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Zz',
        lastName: 'Sond',
        email: `zz-${randomUUID().slice(0, 8)}@example.test`,
      },
      select: { id: true },
    })
    tenantId = tenant.id
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.lease.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  // Varje fixturavtal får en EGEN tillträdesdag.
  //
  // Skälet är `@@unique([unitId, tenantId, startDate])`: samma part, samma
  // lägenhet, samma tillträdesdag två gånger är inte två hyresförhållanden utan
  // ett registrerat två gånger. Fixturen skapade tidigare flera avtal på exakt
  // samma tripel, vilket inte motsvarar något verkligt läge — en förnyelse ger
  // efterföljaren `endDate + 1 dag` som start (se autoRenewExpiredFixedTerm),
  // alltså aldrig samma datum.
  //
  // Dagarna räknas BAKÅT från basdatumet så att `endDate` förblir passerat,
  // vilket är hela premissen för att avtalet ska vara en förnyelsekandidat.
  let fixturNr = 0

  async function nyttUtgångetAvtal(): Promise<string> {
    const dag = 86_400_000
    const start = new Date(new Date('2025-06-01').getTime() - fixturNr * dag)
    const slut = new Date(new Date('2026-05-31').getTime() - fixturNr * dag)
    fixturNr++
    const l = await prisma.lease.create({
      data: {
        organizationId: orgId,
        unitId,
        tenantId,
        leaseType: 'FIXED_TERM',
        status: 'ACTIVE',
        startDate: start,
        // Kontinuitetsmarkören (T1-serien): obligatorisk på Lease.
        tenancyStartDate: start,
        endDate: slut,
        monthlyRent: 10000,
        depositAmount: 0,
        noticePeriodMonths: 3,
        renewalPeriodMonths: 12,
      },
      select: { id: true },
    })
    return l.id
  }

  /** EXAKT anspråket ur autoRenewExpiredFixedTerm. */
  const anspråk = (id: string) =>
    prisma.lease.updateMany({
      where: { id, status: 'ACTIVE', leaseType: 'FIXED_TERM', terminatedAt: null },
      data: { status: 'EXPIRED' },
    })

  it('(4) två SAMTIDIGA anspråk på samma kandidat → exakt ETT vinner', async () => {
    // Utan anspråket skrev båda körningarna sitt ovillkorliga `update` och båda
    // gick vidare till `lease.create` — två förnyelseavtal, alltså dubbla avier
    // och en dubbel fordran mot hyresgästen.
    const id = await nyttUtgångetAvtal()
    const utfall = await Promise.all([anspråk(id), anspråk(id), anspråk(id)])
    const vinnare = utfall.filter((u) => u.count === 1)
    expect(vinnare).toHaveLength(1)

    // Och raden är EXPIRED — alltså inte längre en kandidat för nästa körning.
    const efter = await prisma.lease.findUnique({ where: { id }, select: { status: true } })
    expect(efter?.status).toBe('EXPIRED')
  })

  it('(4b) ett OMTAG efter en avslutad körning anspråkar inte igen', async () => {
    // Det som låset INTE skyddar mot: samma instans som kör om jobbet.
    const id = await nyttUtgångetAvtal()
    expect((await anspråk(id)).count).toBe(1)
    expect((await anspråk(id)).count).toBe(0)
  })

  it('(5) NORMALFALLET: en ensam körning anspråkar och får arbeta', async () => {
    // En claim som anspråkar för hårt tystar riktigt arbete. Utan det här fallet
    // vore "count alltid 0" lika grönt som ett korrekt anspråk.
    const id = await nyttUtgångetAvtal()
    expect((await anspråk(id)).count).toBe(1)
  })

  it('(5b) ett UPPSAGT avtal anspråkas inte — villkoret speglar kandidatfrågan', async () => {
    const id = await nyttUtgångetAvtal()
    await prisma.lease.update({ where: { id }, data: { terminatedAt: new Date() } })
    expect((await anspråk(id)).count).toBe(0)
  })
})
