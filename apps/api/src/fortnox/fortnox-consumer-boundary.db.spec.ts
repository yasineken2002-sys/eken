/**
 * Verklig syntetisk PostgreSQL: interna v1/v2-körningar får inte påverka
 * legacy-konsumenter. Ingen extern provider, kundaktivering eller publicering.
 * COMPLETE är ännu förbjudet för managed-runs: endast E-fallen kompletterar
 * beteendefacitet med faktisk SQL, utan att kringgå databasspärrarna.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma, PrismaClient, type FortnoxReadRun } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { OcrService } from '../common/ocr/ocr.service'
import { OpeningEvidenceService } from '../kundstart/opening-evidence.service'
import { OpeningPackageService } from '../kundstart/opening-package.service'
import {
  fixtureActor,
  nextFixtureOrgNumber,
  IMPORT_HEADER_207,
} from '../kundstart/opening-evidence.fixtures'
import { senasteSaldolasning } from '../kundstart/opening-fortnox-balance'
import { ekonomisktLage } from '../kundstart/watermark'
import { fortnoxRiskkontroll, type ForstaPeriodRegister } from '../kundstart/first-period'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import {
  FortnoxReadCheckpointService,
  type CheckpointLease,
} from './fortnox-read-checkpoint.service'
import { FortnoxReadSourceRunService, type SourceRunLease } from './fortnox-read-source-run.service'
import type { StartCheckpointInput } from './fortnox-read-checkpoint-context'
import { FortnoxCustomerActivationService } from './fortnox-customer-activation.service'

const INPUT = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-01-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput
const SALDO_INPUT = { ...INPUT, costAccounts: [1510, 2890] } satisfies StartCheckpointInput
const CUTOVER = new Date('2026-11-01T00:00:00.000Z')
const VERSIONS = [1, 2] as const
const CATALOG_CONFLICT = 'Katalogunderlaget ändrades under läsningen.'
const RUNNING_CONFLICT = 'En Fortnox-läsning pågår redan'
const NOT_FOUND = 'Läsningen hittades inte'
const SYNTHETIC_KEY = 'ab'.repeat(32)

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Konsumentproven kräver explicit syntetisk DATABASE_URL')
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Konsumentproven tillåter endast egen lokal testdatabas eller CI')
  url.searchParams.set('connection_limit', '3')
  return url.toString()
}
// Precondition utanför describe/beforeAll: ingen tyst skip eller produktions-URL.
const DATABASE_URL = isolatedUrl()
const observerUrl = new URL(DATABASE_URL)
observerUrl.searchParams.set('connection_limit', '1')

class TestPrisma extends PrismaClient {
  async onModuleInit() {
    await this.$connect()
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }
}

type Managed = {
  run: FortnoxReadRun
  claim(): Promise<void>
  release(): Promise<void>
  fail(): Promise<void>
}
type LegacyOptions = {
  status?: 'RUNNING' | 'COMPLETE' | 'COMPLETE_WITH_UNCERTAINTY' | 'PARTIAL'
  startedAt?: Date
  costAccounts?: number[]
  periodTo?: string
  summary?: Prisma.InputJsonValue
  rows?: Prisma.InputJsonValue
}

/**
 * Avsiktligt snäv observation av de nuvarande AND-frågorna, inte SQL-parser.
 * Ett fält i SELECT eller ett NULL-villkor i en OR-gren är inte en gräns.
 */
function mandatoryLegacyWhere(query: string): boolean {
  const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bOFFSET\b|$)/iu.exec(query)?.[1]
  return (
    where !== undefined && !/\bOR\b/iu.test(where) && /"workVersion"\s+IS\s+NULL\b/iu.test(where)
  )
}
function runQueries(sql: readonly string[]) {
  // Hela frågetexten: en framtida WITH-fråga får inte döljas av SELECT-prefix.
  return sql.filter((query) => query.includes('"FortnoxReadRun"'))
}

describe('Fortnox: legacy-konsumentgräns mot riktiga managed v1/v2-körningar', () => {
  let prisma: TestPrisma | undefined
  let observer: PrismaClient | undefined
  const orgs = new Set<string>()

  function db() {
    if (!prisma) throw new Error('Konsumentfixturen har inte startat')
    return prisma
  }
  function observed() {
    if (!observer) throw new Error('Konsumentobservatören har inte startat')
    return observer
  }
  const tx = <T>(work: (client: Prisma.TransactionClient) => Promise<T>) =>
    db().$transaction(work, PRISMA_DEFAULT_TX_LIMITS)

  function rig(client: PrismaService = db()) {
    const config = new ConfigService({
      NODE_ENV: 'test',
      FORTNOX_TOKEN_KEY: SYNTHETIC_KEY,
      FORTNOX_CUSTOMER_WRITES: '',
      FORTNOX_TEST_VOUCHER_WRITES: '',
      FORTNOX_CALLBACK_URL: 'http://localhost:3000/v1/integrations/fortnox/callback',
    })
    const auth = new MockFortnoxAuthProvider()
    const reader = new MockFortnoxLedgerReader()
    reader.costCenters = []
    reader.accounts = [
      { Number: 5170, Active: true, BalanceBroughtForward: 0 },
      { Number: 2440, Active: true, BalanceBroughtForward: 0 },
    ]
    reader.vouchers = [
      {
        Year: 1,
        VoucherSeries: 'L',
        VoucherNumber: 1,
        TransactionDate: '2026-10-01',
        VoucherRows: [
          { Account: 5170, Debit: 100, Credit: 0 },
          { Account: 2440, Debit: 0, Credit: 100 },
        ],
      },
    ]
    const crypto = new FortnoxTokenCryptoService(config)
    const connections = new FortnoxConnectionService(client, crypto, config, auth, reader)
    const readback = new FortnoxReadbackService(client, connections, reader)
    return { config, auth, reader, connections, readback }
  }

  async function fixture() {
    const org = randomUUID()
    const orgNumber = await nextFixtureOrgNumber(db())
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-boundary-${org}`,
        orgNumber,
        email: `${org}@example.invalid`,
        street: 'Syntetgatan 1',
        city: 'Teststad',
        postalCode: '11111',
        billingCutoverDate: CUTOVER,
      },
    })
    orgs.add(org)
    const r = rig()
    r.reader.company.OrganizationNumber = orgNumber
    const { authUrl } = await r.connections.begin(org, 'synthetic-boundary-actor')
    const state = new URL(authUrl).searchParams.get('state')
    if (!state) throw new Error('Syntetisk OAuth-state saknas')
    expect(await r.connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)).toEqual({
      organizationId: org,
    })
    // Historiska legacy-läsningar ska vara efter denna koppling. Detta görs
    // ENDAST i setup, före managed start och vattenmärkets första observation.
    const connection = await db().fortnoxConnection.update({
      where: { organizationId: org },
      data: { connectedAt: new Date(Date.now() - 3_600_000) },
    })
    r.reader.calls = []
    return { org, orgNumber, connection, ...r }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function legacy(f: Fixture, options: LegacyOptions = {}) {
    const status = options.status ?? 'COMPLETE'
    const startedAt = options.startedAt ?? new Date(Date.now() - 120_000)
    const successful = status === 'COMPLETE' || status === 'COMPLETE_WITH_UNCERTAINTY'
    return db().fortnoxReadRun.create({
      data: {
        organizationId: f.org,
        connectionId: f.connection.id,
        fortnoxDatabaseNumber: f.connection.fortnoxDatabaseNumber,
        workVersion: null,
        status,
        financialYearId: 1,
        financialYearStart: new Date('2026-01-01T00:00:00.000Z'),
        financialYearEnd: new Date('2026-12-31T00:00:00.000Z'),
        periodFrom: new Date('2026-01-01T00:00:00.000Z'),
        periodTo: new Date(`${options.periodTo ?? '2026-10-31'}T00:00:00.000Z`),
        costAccounts: options.costAccounts ?? [5170],
        startedAt,
        completedAt: status === 'RUNNING' ? null : new Date(startedAt.getTime() + 1),
        summary: successful
          ? (options.summary ?? { totalOre: 12345, financialYearAccountingMethod: 'ACCRUAL' })
          : Prisma.DbNull,
        rows: successful ? (options.rows ?? { rows: [], references: [] }) : Prisma.DbNull,
        coverage: { synthetic: 'legacy-boundary' },
        uncertainties: status === 'COMPLETE_WITH_UNCERTAINTY' ? ['Syntetisk osäkerhet'] : [],
        reason: status === 'PARTIAL' ? 'Syntetiskt ofullständigt underlag' : null,
      },
    })
  }

  async function managed(
    f: Fixture,
    version: (typeof VERSIONS)[number],
    input: StartCheckpointInput = INPUT,
  ): Promise<Managed> {
    if (version === 1) {
      const service = new FortnoxReadCheckpointService(db())
      const run = await service.start(f.org, null, input)
      let lease: CheckpointLease | null = null
      async function claim() {
        lease = await service.claim(f.org, run.id)
        if (!lease) throw new Error('Egen v1-run kunde inte claima:s')
      }
      return {
        run,
        claim,
        async release() {
          if (!lease) throw new Error('V1-fixturen saknar anspråk')
          await service.release(lease)
          lease = null
        },
        async fail() {
          if (!lease) await claim()
          if (!lease) throw new Error('V1-fixturen saknar anspråk')
          await service.invalidate(lease, 'INVALID_CONTEXT')
          lease = null
          expect(
            await observed().fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } }),
          ).toMatchObject({
            status: 'FAILED',
            workVersion: 1,
            claimToken: null,
            leaseUntil: null,
            summary: null,
            rows: null,
          })
        },
      }
    }
    const service = new FortnoxReadSourceRunService(db())
    const run = await service.start(f.org, null, input)
    let lease: SourceRunLease | null = null
    async function claim() {
      lease = await service.claim(f.org, run.id)
      if (!lease) throw new Error('Egen v2-run kunde inte claima:s')
    }
    return {
      run,
      claim,
      async release() {
        if (!lease) throw new Error('V2-fixturen saknar anspråk')
        await service.release(lease)
        lease = null
      },
      async fail() {
        if (!lease) await claim()
        if (!lease) throw new Error('V2-fixturen saknar anspråk')
        await service.prepareNormalization(lease)
        await expect(service.commitCatalog(lease, {})).rejects.toMatchObject({
          status: 409,
          message: CATALOG_CONFLICT,
        })
        lease = null
        expect(
          await observed().fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toMatchObject({
          status: 'FAILED',
          workVersion: 2,
          claimToken: null,
          leaseUntil: null,
          summary: null,
          rows: null,
        })
      },
    }
  }

  async function durableManaged(f: Fixture, runId: string) {
    const client = observed()
    return {
      run: await client.fortnoxReadRun.findUniqueOrThrow({
        where: { id: runId, organizationId: f.org },
      }),
      captures: await client.fortnoxReadSourceCapture.findMany({
        where: { organizationId: f.org },
      }),
      stages: await client.fortnoxReadNormalizationStage.findMany({
        where: { organizationId: f.org },
      }),
      snapshots: await client.fortnoxReadContextSnapshot.findMany({
        where: { organizationId: f.org },
      }),
    }
  }

  async function captured<T>(work: (client: PrismaService) => Promise<T>) {
    const logged = new PrismaClient({
      datasources: { db: { url: observerUrl.toString() } },
      log: [{ emit: 'event', level: 'query' }],
    })
    const sql: string[] = []
    let active = false
    logged.$on('query', (event) => {
      if (active) sql.push(event.query) // Aldrig params, args, tokens eller resultat.
    })
    const dependency = Object.assign(logged, {
      onModuleInit: async () => {
        await logged.$connect()
      },
      onModuleDestroy: async () => {
        await logged.$disconnect()
      },
    })
    try {
      await logged.$connect()
      active = true
      const value = await work(dependency)
      return { value, sql }
    } finally {
      active = false
      await logged.$disconnect()
    }
  }

  it.each(VERSIONS)(
    'A: faktisk legacy-read lyckas vid intern v%i RUNNING utan att ändra den',
    async (version) => {
      const f = await fixture()
      const internal = await managed(f, version)
      const before = await durableManaged(f, internal.run.id)
      const count = await observed().fortnoxReadRun.count({ where: { organizationId: f.org } })
      expect(before.run.status).toBe('RUNNING')
      expect(before.run.workVersion).toBe(version)

      const result = await f.readback.read(f.org, null, INPUT)
      expect(result.status).toBe('COMPLETE')
      expect(result.summary).toMatchObject({ totalOre: 10000 })
      expect(f.reader.calls).toContain('/3/vouchers/sublist')
      expect(
        await observed().fortnoxReadRun.findUniqueOrThrow({ where: { id: result.id } }),
      ).toMatchObject({
        organizationId: f.org,
        workVersion: null,
        status: 'COMPLETE',
      })
      expect(await observed().fortnoxReadRun.count({ where: { organizationId: f.org } })).toBe(
        count + 1,
      )
      expect(await durableManaged(f, internal.run.id)).toStrictEqual(before)
    },
  )

  it('A: färsk egen legacy RUNNING blockerar, gammal legacy och främmande färsk körning gör det inte', async () => {
    const blocked = await fixture()
    const running = await legacy(blocked, { status: 'RUNNING', startedAt: new Date() })
    const before = await observed().fortnoxReadRun.findMany({
      where: { organizationId: blocked.org },
    })
    const denied = blocked.readback.read(blocked.org, null, INPUT)
    await expect(denied).rejects.toBeInstanceOf(ConflictException)
    await expect(denied).rejects.toMatchObject({
      status: 409,
      message: RUNNING_CONFLICT,
    })
    expect(blocked.reader.calls).toEqual([])
    expect(
      await observed().fortnoxReadRun.findMany({ where: { organizationId: blocked.org } }),
    ).toStrictEqual(before)

    const allowed = await fixture()
    const old = await legacy(allowed, {
      status: 'RUNNING',
      startedAt: new Date(Date.now() - 11 * 60_000),
    })
    const result = await allowed.readback.read(allowed.org, null, INPUT)
    expect(result.status).toBe('COMPLETE')
    expect(result.summary).toMatchObject({ totalOre: 10000 })
    expect(allowed.reader.calls).toContain('/3/vouchers/sublist')
    expect(
      await observed().fortnoxReadRun.findUniqueOrThrow({ where: { id: old.id } }),
    ).toStrictEqual(old)
    expect(
      await observed().fortnoxReadRun.findUniqueOrThrow({ where: { id: running.id } }),
    ).toStrictEqual(running)
  })

  it.each(VERSIONS)(
    'B: latest/AI visar legacy-facit och inga interna v%i RUNNING/FAILED',
    async (version) => {
      const only = await fixture()
      const onlyInternal = await managed(only, version)
      const onlyBefore = await durableManaged(only, onlyInternal.run.id)
      expect(await only.readback.latest(only.org)).toEqual({
        latestRead: null,
        latestCompleteRead: null,
      })
      expect(await only.readback.aiSnapshot(only.org)).toMatchObject({
        latestRead: null,
        latestCompleteRead: null,
      })
      expect(await durableManaged(only, onlyInternal.run.id)).toStrictEqual(onlyBefore)

      const f = await fixture()
      const complete = await legacy(f)
      const partial = await legacy(f, {
        status: 'PARTIAL',
        startedAt: new Date(Date.now() - 60_000),
      })
      const latestBaseline = await f.readback.latest(f.org)
      const aiBaseline = await f.readback.aiSnapshot(f.org)
      expect(latestBaseline.latestRead).toMatchObject({
        id: partial.id,
        status: 'PARTIAL',
        summary: null,
      })
      expect(latestBaseline.latestCompleteRead).toMatchObject({
        id: complete.id,
        status: 'COMPLETE',
        summary: { totalOre: 12345 },
      })
      expect(aiBaseline.latestRead?.id).toBe(partial.id)
      expect(aiBaseline.latestCompleteRead?.id).toBe(complete.id)

      const internal = await managed(f, version)
      expect(internal.run.startedAt.getTime()).toBeGreaterThan(partial.startedAt.getTime())
      const foreign = await legacy(only, { startedAt: new Date() })
      expect(foreign.startedAt.getTime()).toBeGreaterThan(partial.startedAt.getTime())
      const runningBefore = await durableManaged(f, internal.run.id)
      expect(await f.readback.latest(f.org)).toStrictEqual(latestBaseline)
      expect(await f.readback.aiSnapshot(f.org)).toStrictEqual(aiBaseline)
      expect(await durableManaged(f, internal.run.id)).toStrictEqual(runningBefore)

      await internal.fail()
      const failedBefore = await durableManaged(f, internal.run.id)
      expect(await f.readback.latest(f.org)).toStrictEqual(latestBaseline)
      expect(await f.readback.aiSnapshot(f.org)).toStrictEqual(aiBaseline)
      expect(await durableManaged(f, internal.run.id)).toStrictEqual(failedBefore)
    },
  )

  it.each(VERSIONS)(
    'C: saldo och explicit bindning utesluter v%i, men nyare legacy PARTIAL fortsätter blockera',
    async (version) => {
      const f = await fixture()
      const admin = await fixtureActor(db(), f.org, 'ADMIN')
      const packages = new OpeningPackageService(
        db(),
        new OcrService(db()),
        new OpeningEvidenceService(db()),
      )
      const pkg = await packages.create(f.org, admin, {
        sourceName: 'synthetic-boundary-empty.csv',
        innehall: IMPORT_HEADER_207,
        nollOppning: true,
      })
      const good = await legacy(f, {
        costAccounts: [1510, 2890],
        summary: { balanceBroughtForwardOre: { '1510': 100000, '2890': -50000 } },
      })
      expect(good.startedAt.getTime()).toBeGreaterThan(f.connection.connectedAt.getTime())
      const internal = await managed(f, version, SALDO_INPUT)
      expect(internal.run.startedAt.getTime()).toBeGreaterThan(good.startedAt.getTime())
      expect((await senasteSaldolasning(db(), f.org))?.id).toBe(good.id)
      const bound = await packages.bindFortnoxRead(f.org, pkg.id, admin, good.id)
      expect(bound).toMatchObject({
        fortnoxReadRunId: good.id,
        fortnoxBalance1510Ore: 100000,
        fortnoxBalance2890Ore: 50000,
      })

      const foreign = await fixture()
      const foreignRead = await legacy(foreign, { costAccounts: [1510, 2890] })
      for (const invisible of [internal.run.id, foreignRead.id]) {
        const before = await observed().openingPackage.findUniqueOrThrow({ where: { id: pkg.id } })
        const denied = packages.bindFortnoxRead(f.org, pkg.id, admin, invisible)
        await expect(denied).rejects.toBeInstanceOf(NotFoundException)
        await expect(denied).rejects.toThrow(NOT_FOUND)
        expect(
          await observed().openingPackage.findUniqueOrThrow({ where: { id: pkg.id } }),
        ).toStrictEqual(before)
      }

      const partial = await legacy(f, {
        status: 'PARTIAL',
        costAccounts: [1510, 2890],
        startedAt: new Date(),
      })
      expect((await senasteSaldolasning(db(), f.org))?.id).toBe(partial.id)
      const before = await observed().openingPackage.findUniqueOrThrow({ where: { id: pkg.id } })
      await expect(packages.bindFortnoxRead(f.org, pkg.id, admin, good.id)).rejects.toMatchObject({
        status: 409,
        message: 'Det finns en nyare läsning av 1510/2890 — bind den senaste.',
      })
      expect(
        await observed().openingPackage.findUniqueOrThrow({ where: { id: pkg.id } }),
      ).toStrictEqual(before)
      expect(await observed().rentNotice.count({ where: { organizationId: f.org } })).toBe(0)
      expect(await observed().journalEntry.count({ where: { organizationId: f.org } })).toBe(0)
    },
  )

  it.each(VERSIONS)(
    'D: hela vattenmärket är oförändrat av v%i start/claim/release/FAILED, men ändras av legacy',
    async (version) => {
      const f = await fixture()
      await legacy(f)
      const readWatermark = () =>
        tx((client) => ekonomisktLage(client, f.org, { leaseIds: [], tenantIds: [] }))
      const baseline = await readWatermark()
      const connectionBefore = await observed().fortnoxConnection.findUniqueOrThrow({
        where: { organizationId: f.org },
      })
      const internal = await managed(f, version)
      expect(await readWatermark()).toStrictEqual(baseline)
      await internal.claim()
      expect(
        await observed().fortnoxReadRun.findUniqueOrThrow({ where: { id: internal.run.id } }),
      ).toMatchObject({
        status: 'RUNNING',
        claimVersion: 1,
        claimToken: expect.any(String),
        leaseUntil: expect.any(Date),
      })
      expect(await readWatermark()).toStrictEqual(baseline)
      await internal.release()
      expect(
        await observed().fortnoxReadRun.findUniqueOrThrow({ where: { id: internal.run.id } }),
      ).toMatchObject({
        status: 'RUNNING',
        claimToken: null,
        leaseUntil: null,
      })
      expect(await readWatermark()).toStrictEqual(baseline)
      await internal.claim()
      await internal.fail()
      expect(await readWatermark()).toStrictEqual(baseline)
      expect(
        await observed().fortnoxConnection.findUniqueOrThrow({ where: { organizationId: f.org } }),
      ).toStrictEqual(connectionBefore)

      await legacy(f, { startedAt: new Date() })
      const changed = await readWatermark()
      expect(changed.delar.lasningar).not.toBe(baseline.delar.lasningar)
      expect(changed.sha256).not.toBe(baseline.sha256)
      expect({ ...changed.delar, lasningar: baseline.delar.lasningar }).toStrictEqual(
        baseline.delar,
      )
    },
  )

  it('E: senaste lyckade behåller COMPLETE_WITH_UNCERTAINTY; båda verkliga latest/AI-urvalen kräver legacy', async () => {
    // Kanarier: kolumnnamn, projektion och OR-frikort ska aldrig räcka.
    expect(
      mandatoryLegacyWhere(
        'SELECT "workVersion" FROM "FortnoxReadRun" WHERE "organizationId" = $1',
      ),
    ).toBe(false)
    expect(
      mandatoryLegacyWhere(
        'SELECT * FROM "FortnoxReadRun" WHERE "organizationId" = $1 OR "workVersion" IS NULL',
      ),
    ).toBe(false)
    expect(
      mandatoryLegacyWhere(
        'SELECT * FROM "FortnoxReadRun" WHERE "organizationId" = $1 AND ("workVersion" IS NULL OR TRUE)',
      ),
    ).toBe(false)
    expect(
      mandatoryLegacyWhere(
        'SELECT * FROM "FortnoxReadRun" WHERE "organizationId" = $1 AND "workVersion" IS NOT NULL',
      ),
    ).toBe(false)
    const withQuery =
      'WITH selected AS (SELECT * FROM "FortnoxReadRun" WHERE "organizationId" = $1 AND "workVersion" IS NULL) SELECT * FROM selected'
    expect(runQueries([withQuery])).toEqual([withQuery])
    expect(mandatoryLegacyWhere(withQuery)).toBe(true)

    const f = await fixture()
    await legacy(f)
    const uncertain = await legacy(f, {
      status: 'COMPLETE_WITH_UNCERTAINTY',
      startedAt: new Date(Date.now() - 60_000),
    })
    const latest = await captured((client) => rig(client).readback.latest(f.org))
    const ai = await captured((client) => rig(client).readback.aiSnapshot(f.org))
    for (const result of [latest, ai]) {
      expect(result.value.latestRead?.id).toBe(uncertain.id)
      expect(result.value.latestCompleteRead).toMatchObject({
        id: uncertain.id,
        status: 'COMPLETE_WITH_UNCERTAINTY',
        uncertainties: ['Syntetisk osäkerhet'],
      })
      const queries = runQueries(result.sql)
      // Två befintliga urvalsgränser: senaste och senaste kompletta. Inga
      // assertions om övriga roundtrips, SELECT-bredd eller aliasnamn.
      expect(queries).toHaveLength(2)
      for (const query of queries) expect(mandatoryLegacyWhere(query)).toBe(true)
    }
  })

  it('E: riktig första-periodrisk och årsmetod använder legacy; faktiska COMPLETE-frågor har NULL-gräns', async () => {
    const f = await fixture()
    await legacy(f, {
      periodTo: '2026-12-31',
      costAccounts: [1510, 2890, 3911, 2420],
      summary: {
        financialYearAccountingMethod: 'ACCRUAL',
        balanceBroughtForwardOre: { '1510': 0, '2890': 0, '3911': 0, '2420': 0 },
      },
      rows: {
        rows: [
          {
            account: 3911,
            amountOre: -10000,
            transactionDate: '2026-11-01',
            evenoExport: false,
            bucket: 'UNALLOCATED',
          },
        ],
        references: [],
      },
    })
    const reg: ForstaPeriodRegister = {
      sha256: 'a'.repeat(64),
      filnamn: 'synthetic-boundary-period.csv',
      system: 'Syntetiskt tidigare system',
      ansvarig: 'Syntetisk ansvarig',
      tackningFran: '2026-11-01',
      tackningTill: '2026-12-31',
      intaktskonton: [3911],
      forskottskonton: [2420],
      antal: 0,
      poster: [],
      registreradAv: 'synthetic-boundary-actor',
      registreradTid: '2026-10-01T00:00:00.000Z',
    }
    const risk = await captured((client) =>
      fortnoxRiskkontroll(client, f.org, f.connection.id, CUTOVER, reg),
    )
    expect(risk.value).toBe(
      'Fortnox har 1 verifikatrader från tidigare system på eller efter brytdatum 2026-11-01 på konto 3911 — första perioden kan redan vara fakturerad eller betald. Kundstarten är blockerad.',
    )
    const status = await captured((client) =>
      new FortnoxCustomerActivationService(client, rig(client).config).status(f.org, 1),
    )
    expect(status.value.flaggaPa).toBe(false)
    expect(status.value.aktiv).toBeNull()
    expect(status.value.forslag.ok).toBe(false)
    expect(status.value.forslag.hinder).toContain(
      'Driftflaggan FORTNOX_CUSTOMER_WRITES är av i denna miljö — kundskrivning är avstängd.',
    )
    expect(
      status.value.forslag.hinder.some((reason) => reason.includes('är inte verifierat i Fortnox')),
    ).toBe(false)
    expect(
      status.value.forslag.hinder.some((reason) =>
        reason.includes('Eveno stödjer bara faktureringsmetoden'),
      ),
    ).toBe(false)
    for (const result of [risk, status]) {
      const queries = runQueries(result.sql)
      expect(queries).toHaveLength(1)
      expect(mandatoryLegacyWhere(queries[0]!)).toBe(true)
    }
    expect(
      await observed().fortnoxCustomerActivation.count({ where: { organizationId: f.org } }),
    ).toBe(0)
    expect(await observed().fortnoxVoucherExport.count({ where: { organizationId: f.org } })).toBe(
      0,
    )
  })

  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    observer = new PrismaClient({ datasources: { db: { url: observerUrl.toString() } } })
    await prisma.$connect()
    await observer.$connect()
    expect(await prisma.$queryRaw`SELECT current_database() AS name`).toStrictEqual([
      { name: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
    ])
  })

  afterAll(async () => {
    try {
      if (prisma) {
        for (const org of orgs) {
          expect((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).name).toBe(
            `synthetic-boundary-${org}`,
          )
        }
        // Tillåten orgcascade; aldrig direkt DELETE av skyddade managed-rader.
        await prisma.organization.deleteMany({ where: { id: { in: [...orgs] } } })
        const where = { organizationId: { in: [...orgs] } }
        expect(await prisma.organization.count({ where: { id: { in: [...orgs] } } })).toBe(0)
        expect(await prisma.fortnoxReadRun.count({ where })).toBe(0)
        expect(await prisma.fortnoxReadSourceCapture.count({ where })).toBe(0)
        expect(await prisma.fortnoxReadContextSnapshot.count({ where })).toBe(0)
        expect(await prisma.fortnoxReadNormalizationStage.count({ where })).toBe(0)
        expect(await prisma.openingPackage.count({ where })).toBe(0)
      }
    } finally {
      await Promise.all([prisma?.$disconnect(), observer?.$disconnect()])
      prisma = undefined
      observer = undefined
    }
  })
})
