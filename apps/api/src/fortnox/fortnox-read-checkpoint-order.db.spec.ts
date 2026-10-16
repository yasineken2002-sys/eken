/**
 * Beteendebaslinje för checkpointnycklarnas ordning och sidgränser. Riktig lokal
 * PostgreSQL och egna syntetiska organisationer; inga provideranrop. Facit är
 * uttryckligt och oberoende av SQL/index eller tjänstens interna sortering.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import {
  FortnoxReadCheckpointService,
  type CheckpointLease,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint.service'
import type { FortnoxVoucher } from './fortnox.types'

const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
// Strängordning: versaler före gemener, och 1 < 10 < 2. Ingen numerisk sortering.
const ORDER = ['1|B|1', '1|L|1', '1|L|10', '1|L|2', '1|a|1'] as const
const UNSORTED = ['1|a|1', '1|L|2', '1|L|10', '1|B|1', '1|L|1'] as const
const FOREIGN_MARKER = 'SYNTHETIC_FOREIGN_CHECKPOINT_REFERENCE'

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Checkpointordningsprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error(
      'Checkpointordningsprovet tillåter bara lokal *_test eller CI:s lokala eken_dev',
    )
  }
  url.searchParams.set('connection_limit', '2')
  return url.toString()
}

function catalog() {
  return {
    version: 1,
    companyDatabaseNumber: 900001,
    financialYear: {
      id: 1,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
      accountingMethod: 'ACCRUAL',
    },
    accounts: [{ number: 5170, active: true, balanceBroughtForwardOre: 0 }],
    dimensions: [],
    coverage: {
      costCenters: { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 },
    },
  }
}

function identity(key: string) {
  const [year, series, number] = key.split('|')
  if (!year || !series || !number) throw new Error('Ogiltig syntetisk nyckel')
  return { Year: Number(year), VoucherSeries: series, VoucherNumber: Number(number) }
}

function manifest(keys: readonly string[]) {
  return {
    MetaInformation: {
      '@CurrentPage': 1,
      '@TotalPages': keys.length ? 1 : 0,
      '@TotalResources': keys.length,
    },
    Vouchers: keys.map(identity),
  }
}

function detail(key: string, reference: string | null = null): FortnoxVoucher {
  return {
    ...identity(key),
    TransactionDate: '2026-10-01',
    ReferenceType: reference ? 'MANUAL' : null,
    ReferenceNumber: reference,
    VoucherRows: [
      { Account: 5170, Debit: 10.05 },
      { Account: 2440, Credit: 10.05 },
    ],
  }
}

describe('Fortnox-checkpointens nyckelordning mot riktig PostgreSQL', () => {
  let prisma: PrismaClient | undefined
  const organizations: string[] = []

  function db(): PrismaClient {
    if (!prisma) throw new Error('PostgreSQL-fixturen har inte startats')
    return prisma
  }

  function service(): FortnoxReadCheckpointService {
    return new FortnoxReadCheckpointService(db() as unknown as PrismaService)
  }

  async function organization() {
    const id = randomUUID()
    await db().organization.create({
      data: {
        id,
        name: `synthetic-checkpoint-order-${id}`,
        email: `${id}@example.invalid`,
        street: 'Syntetisk testgata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    organizations.push(id)
    await db().fortnoxConnection.create({
      data: { organizationId: id, status: 'ACTIVE', fortnoxDatabaseNumber: 900001 },
    })
    return id
  }

  async function pending(organizationId: string, keys: readonly string[]) {
    const checkpoints = service()
    const run = await checkpoints.start(organizationId, null, INPUT)
    const lease = await checkpoints.claim(organizationId, run.id)
    if (!lease) throw new Error('Fixturens första claim saknas')
    await checkpoints.commitCatalog(lease, catalog())
    await checkpoints.commitVoucherPage(lease, manifest(keys))
    return { checkpoints, run, lease }
  }

  async function completeDetails(
    checkpoints: FortnoxReadCheckpointService,
    lease: CheckpointLease,
    keys: readonly string[],
    reference: string | null = null,
  ) {
    for (const key of keys) {
      await expect(checkpoints.nextStep(lease)).resolves.toStrictEqual({ phase: 'DETAILS', key })
      await checkpoints.commitVoucherDetail(lease, key, detail(key, reference))
    }
    await expect(checkpoints.nextStep(lease)).resolves.toStrictEqual({ phase: 'READY_TO_REDUCE' })
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: isolatedDatabaseUrl() } } })
    await prisma.$connect()
  })

  afterAll(async () => {
    if (!prisma) return
    const failures: unknown[] = []
    for (const id of organizations) {
      try {
        await prisma.organization.delete({ where: { id } })
      } catch (error) {
        failures.push(error)
      }
    }
    await prisma.$disconnect()
    if (failures.length)
      throw new AggregateError(failures, 'Kunde inte städa checkpointordningsprovets egna fixturer')
  })

  it('KANARIEFÅGEL: använder den uttryckliga isolerade PostgreSQL-databasen utan skip', async () => {
    const expected = decodeURIComponent(new URL(isolatedDatabaseUrl()).pathname.slice(1))
    const rows = await db().$queryRaw<Array<{ database: string }>>(
      Prisma.sql`SELECT current_database() AS database`,
    )
    expect(rows).toStrictEqual([{ database: expected }])
  })

  it('nextStep följer C-ordningen och hoppar över verkligt observerade detaljer', async () => {
    const f = await pending(await organization(), UNSORTED)
    const completedKeys: string[] = []
    for (const key of ORDER) {
      const expected = { phase: 'DETAILS', key }
      await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual(expected)
      await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual(expected)
      const updated = await f.checkpoints.commitVoucherDetail(f.lease, key, detail(key))
      completedKeys.push(key)
      const stored = await db().fortnoxReadVoucherCheckpoint.findMany({
        where: { runId: f.run.id },
        select: { key: true, detailDigest: true, observedAt: true },
      })
      for (const row of stored) {
        if (completedKeys.includes(row.key)) {
          expect(row.detailDigest).toMatch(/^[a-f0-9]{64}$/)
          expect(row.observedAt).toBeInstanceOf(Date)
        } else {
          expect(row.detailDigest).toBeNull()
          expect(row.observedAt).toBeNull()
        }
      }
      expect(stored.filter((row) => row.detailDigest === null)).toHaveLength(
        ORDER.length - completedKeys.length,
      )
      expect(updated.phase).toBe(
        completedKeys.length === ORDER.length ? 'READY_TO_REDUCE' : 'DETAILS',
      )
    }
    await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual({
      phase: 'READY_TO_REDUCE',
    })
    const saved = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
    expect(saved).toMatchObject({ status: 'RUNNING', summary: null, rows: null, completedAt: null })
  })

  it('restore-sidor saknar luckor och dubbletter och avgränsas från andra körningar och organisationer', async () => {
    const ownOrganizationId = await organization()
    const previous = await pending(ownOrganizationId, ['1|A|2', '1|A|1'])
    await previous.checkpoints.commitVoucherDetail(previous.lease, '1|A|1', detail('1|A|1'))
    await previous.checkpoints.invalidate(previous.lease, 'AUTH_LOST')
    // Gammal run har både en sparad detalj och en tidigare sorterad, ännu oläst nyckel.
    const older = await db().fortnoxReadVoucherCheckpoint.findMany({
      where: { runId: previous.run.id },
      orderBy: { id: 'asc' },
    })
    expect(older.find((row) => row.key === '1|A|1')?.detailDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(older.find((row) => row.key === '1|A|2')?.detailDigest).toBeNull()

    const foreignOrganizationId = await organization()
    const foreign = await pending(foreignOrganizationId, ['1|L|1'])
    await completeDetails(foreign.checkpoints, foreign.lease, ['1|L|1'], FOREIGN_MARKER)
    const foreignBefore = await db().fortnoxReadVoucherCheckpoint.findMany({
      where: { runId: foreign.run.id },
      orderBy: { id: 'asc' },
    })
    expect(JSON.stringify(foreignBefore)).toContain(FOREIGN_MARKER)

    const current = await pending(ownOrganizationId, UNSORTED)
    expect(current.run.id).not.toBe(previous.run.id)
    await completeDetails(current.checkpoints, current.lease, ORDER)
    for (const limit of [1, 2, 3]) {
      const seen: string[] = []
      let afterKey: string | undefined
      let reachedEnd = false
      for (let attempt = 0; attempt <= ORDER.length; attempt += 1) {
        const batch = await current.checkpoints.readValidatedPage(current.lease, {
          limit,
          ...(afterKey === undefined ? {} : { afterKey }),
        })
        expect(batch.length).toBeLessThanOrEqual(limit)
        expect(JSON.stringify(batch)).not.toContain(FOREIGN_MARKER)
        if (!batch.length) {
          reachedEnd = true
          break
        }
        seen.push(...batch.map((item) => item.key))
        afterKey = batch[batch.length - 1]!.key
      }
      expect(reachedEnd).toBe(true)
      expect(seen).toStrictEqual([...ORDER])
      expect(new Set(seen).size).toBe(ORDER.length)
    }
    // Markören behöver inte motsvara en existerande rad; gränsen är strikt större än.
    expect(
      (
        await current.checkpoints.readValidatedPage(current.lease, { afterKey: '1|L|11', limit: 3 })
      ).map((item) => item.key),
    ).toStrictEqual(['1|L|2', '1|a|1'])
    await expect(
      current.checkpoints.readValidatedPage(current.lease, { afterKey: '1|a|1' }),
    ).resolves.toStrictEqual([])

    const wrongOrganization = { ...current.lease, organizationId: foreignOrganizationId }
    const wrongRun = { ...current.lease, runId: foreign.run.id }
    for (const forged of [wrongOrganization, wrongRun]) {
      await expect(current.checkpoints.nextStep(forged)).rejects.toBeInstanceOf(ConflictException)
      await expect(current.checkpoints.readValidatedPage(forged)).rejects.toBeInstanceOf(
        ConflictException,
      )
    }
    expect(
      await db().fortnoxReadVoucherCheckpoint.findMany({
        where: { runId: previous.run.id },
        orderBy: { id: 'asc' },
      }),
    ).toStrictEqual(older)
    expect(
      await db().fortnoxReadVoucherCheckpoint.findMany({
        where: { runId: foreign.run.id },
        orderBy: { id: 'asc' },
      }),
    ).toStrictEqual(foreignBefore)
  })

  it('tom återstående mängd är READY utan rapport, och ett terminalt READY får inte läsas', async () => {
    const f = await pending(await organization(), [])
    await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual({
      phase: 'READY_TO_REDUCE',
    })
    await expect(f.checkpoints.readValidatedPage(f.lease)).resolves.toStrictEqual([])
    const ready = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
    expect(ready).toMatchObject({
      status: 'RUNNING',
      phase: 'READY_TO_REDUCE',
      summary: null,
      rows: null,
      completedAt: null,
    })
    await f.checkpoints.invalidate(f.lease, 'AUTH_LOST')
    const stopped = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
    expect(stopped).toMatchObject({
      status: 'AUTH_LOST',
      phase: 'READY_TO_REDUCE',
      summary: null,
      rows: null,
    })
    await expect(f.checkpoints.nextStep(f.lease)).rejects.toBeInstanceOf(ConflictException)
    await expect(f.checkpoints.readValidatedPage(f.lease)).rejects.toBeInstanceOf(ConflictException)
  })
})
