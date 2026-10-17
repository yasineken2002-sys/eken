/**
 * Inert fryst källunderlag mot riktig PostgreSQL.
 * Riktig lokal PostgreSQL, syntetiska balanserade journaler och exporter.
 * Ingen provider eller token används. Tabellen har handfacit; SQL-uttrycket
 * kopieras inte hit. Riktiga tabellås skiljer gemensam RepeatableRead-snapshot
 * från två separata källögonblick. SEALED är inte validerad kontext.
 */
import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient, type FortnoxExportState } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import {
  CheckpointContextSchema,
  checkpointDigest,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'
import { FortnoxReadCheckpointService } from './fortnox-read-checkpoint.service'
import { kallkonton } from './fortnox-read-provenance'
import { freezeCheckpointContext } from './fortnox-read-context-snapshot'
import {
  captureCheckpointSource,
  readCheckpointSourceHeader,
  readCheckpointSourceMappingPage,
  readCheckpointSourceExportPage,
} from './fortnox-read-source-capture'

const RAW_MARKER = 'SYNTHETIC_SOURCE_RAW_FIELDS_MUST_NOT_TRAVEL'
const COMPANY = 900001
const INPUT = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Källprojektion kräver uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const database = decodeURIComponent(url.pathname.slice(1))
  const allowed =
    database === 'eveno_fortnox_capacity_test' ||
    (process.env.CI === 'true' && database === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !allowed) {
    throw new Error('Källprojektion tillåter bara lokal kapacitetsdatabas eller CI:s eken_dev')
  }
  url.searchParams.set('connection_limit', '4')
  return url.toString()
}

// Ovillkorlig säkerhetsgrind; inget describe.skip kan göra fel databas grön.
const DATABASE_URL = isolatedDatabaseUrl()

// Samma verkliga PrismaClient som övriga DB-prov. Dessa två livscykelmetoder
// uppfyller tjänstens PrismaService-kontrakt utan extended-client/dubbelcast.
class SourceTestPrisma extends PrismaClient {
  async onModuleInit() {
    await this.$connect()
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }
}

type Outcome = { revision: number | null; perMal: [number, number[]][] } | { error: 'TypeError' }
type SourceCase = {
  name: string
  original: Prisma.InputJsonValue | null
  expected: Outcome
  contextValid?: boolean
  sqlNull?: boolean
}
const empty: Outcome = { revision: null, perMal: [] }
const invalid: Outcome = { error: 'TypeError' }
const line = { localAccountNumber: 5170, externalAccountNumber: 5171 }
const CASES: SourceCase[] = [
  { name: 'SQL-null-draft', original: null, sqlNull: true, expected: empty },
  { name: 'JSON-null-draft', original: null, expected: empty },
  { name: 'missing-fields', original: {}, expected: empty },
  ...['text', 17, false, []].map((original) => ({
    name: `primitive-draft-${JSON.stringify(original)}`,
    original,
    expected: empty,
  })),
  {
    name: 'primitive-provenance',
    original: { provenance: 'text', kontomappning: false },
    expected: empty,
  },
  { name: 'null-lines', original: { provenance: { lines: null } }, expected: empty },
  { name: 'empty-array-lines', original: { provenance: { lines: [] } }, expected: empty },
  {
    name: 'string-lines-is-iterable-and-skipped',
    original: { provenance: { lines: 'abc' } },
    expected: empty,
  },
  ...[{}, 42, false].map((lines) => ({
    name: `noniterable-lines-${JSON.stringify(lines)}`,
    original: { provenance: { lines } },
    expected: invalid,
  })),
  { name: 'null-row-throws', original: { provenance: { lines: [null] } }, expected: invalid },
  {
    name: 'valid-then-null-row-still-throws',
    original: { provenance: { lines: [line, null] } },
    expected: invalid,
  },
  {
    name: 'valid-null-valid-still-throws',
    original: {
      provenance: {
        lines: [line, null, { localAccountNumber: 1930, externalAccountNumber: 1940 }],
      },
    },
    expected: invalid,
  },
  {
    name: 'primitive-array-rows-skip',
    original: { provenance: { lines: ['text', 17, false, [], {}] } },
    expected: empty,
  },
  {
    name: 'nested-arrays-never-flatten-or-expose-null',
    original: { provenance: { lines: [[line], [null], ['text', 17], line] } },
    expected: { revision: null, perMal: [[5171, [5170]]] },
  },
  {
    name: 'string-account-types-skip',
    original: {
      provenance: {
        lines: [
          { ...line, localAccountNumber: '5170' },
          { ...line, externalAccountNumber: '5171' },
        ],
      },
    },
    expected: empty,
  },
  {
    name: 'object-array-account-values-stay-nonnumeric',
    original: {
      provenance: {
        lines: [
          { ...line, localAccountNumber: { value: 5170 } },
          { ...line, externalAccountNumber: [5171] },
        ],
      },
    },
    expected: empty,
  },
  {
    name: 'null-account-values-skip',
    original: {
      provenance: {
        lines: [
          { ...line, localAccountNumber: null },
          { ...line, externalAccountNumber: null },
        ],
      },
    },
    expected: empty,
  },
  {
    name: 'unsafe-integers-skip',
    original: {
      provenance: {
        lines: [
          { ...line, localAccountNumber: 9007199254740992 },
          { ...line, externalAccountNumber: 9007199254740992 },
        ],
      },
    },
    expected: empty,
  },
  {
    name: 'fractional-accounts-skip',
    original: {
      provenance: {
        lines: [
          { ...line, localAccountNumber: 5170.5 },
          { ...line, externalAccountNumber: 5171.5 },
        ],
      },
    },
    expected: empty,
  },
  {
    name: 'first-occurrence-and-dedup',
    original: {
      provenance: {
        lines: [
          { localAccountNumber: 1930, externalAccountNumber: 1940 },
          line,
          { localAccountNumber: 5160, externalAccountNumber: 5171 },
          line,
        ],
      },
      kontomappning: { revision: 7 },
    },
    expected: {
      revision: 7,
      perMal: [
        [1940, [1930]],
        [5171, [5170, 5160]],
      ],
    },
  },
  ...[0, -7, 9007199254740991].map(
    (revision): SourceCase => ({
      name: `safe-revision-${revision}`,
      original: { kontomappning: { revision } },
      expected: { revision, perMal: [] },
    }),
  ),
  ...['7', 7.5, 9007199254740992, null, []].map((revision) => ({
    name: `invalid-revision-${JSON.stringify(revision)}`,
    original: { kontomappning: { revision } },
    expected: empty,
  })),
  {
    name: 'object-revision-remains-invalid',
    original: { kontomappning: { revision: { value: 7 } } },
    expected: empty,
  },
  {
    name: 'safe-account-outside-schema-not-filtered',
    original: { provenance: { lines: [{ localAccountNumber: 999, externalAccountNumber: 5171 }] } },
    expected: { revision: null, perMal: [[5171, [999]]] },
    contextValid: false,
  },
  {
    name: 'irrelevant-fields-do-not-affect-source',
    original: {
      payload: { marker: RAW_MARKER },
      provenance: {
        marker: RAW_MARKER,
        lines: [{ ...line, description: RAW_MARKER, evidence: { marker: RAW_MARKER } }],
      },
      kontomappning: { revision: 7, marker: RAW_MARKER },
    },
    expected: { revision: 7, perMal: [[5171, [5170]]] },
  },
]

function outcome(draft: unknown): Outcome {
  try {
    const value = kallkonton(draft)
    return { revision: value.revision, perMal: [...value.perMal] }
  } catch (error) {
    // Ett annat fel får aldrig räknas som det avsedda negativa facit.
    if (!(error instanceof TypeError)) throw error
    return { error: 'TypeError' }
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const VALID_DRAFT: Prisma.InputJsonObject = {
  payload: { marker: RAW_MARKER },
  kontomappning: { revision: 7, marker: RAW_MARKER },
  provenance: { lines: [{ ...line, description: RAW_MARKER }] },
}
type DraftInput = Prisma.InputJsonValue | Prisma.NullTypes.DbNull | Prisma.NullTypes.JsonNull
type ExportInput = {
  organizationId: string
  journalOrganizationId?: string
  id?: string
  year?: number | null
  company?: number | null
  series?: string | null
  number?: number | null
  state?: FortnoxExportState
  draft?: DraftInput
}

describe('Inert fryst Fortnox-källa mot riktig PostgreSQL', () => {
  let prisma: SourceTestPrisma | undefined
  let sequence = 0
  let matrixOrganizationId = ''
  const matrixCaptureId = randomUUID()
  const organizations = new Set<string>()
  const journalIds = new Set<string>()
  const exportIds = new Set<string>()
  const accounts = new Map<string, { bank: string; expense: string }>()
  const matrixRows = new Map<string, { journalEntryId: string }>()

  function db(): SourceTestPrisma {
    if (!prisma) throw new Error('Källprovets PostgreSQL-fixture har inte startat')
    return prisma
  }
  function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, client = db()) {
    return client.$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
  }
  function rr<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, client = db()) {
    return client.$transaction(work, {
      ...PRISMA_DEFAULT_TX_LIMITS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    })
  }
  function capture(org: string, id: string = randomUUID(), input: StartCheckpointInput = INPUT) {
    return rr((tx) => captureCheckpointSource(tx, org, id, input))
  }
  async function organization() {
    const id = randomUUID()
    await db().organization.create({
      data: {
        id,
        name: `synthetic-read-source-${id}`,
        email: `${id}@example.invalid`,
        street: 'Syntetisk testgata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    organizations.add(id)
    await db().fortnoxConnection.create({
      data: {
        organizationId: id,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: COMPANY,
        fortnoxOrgNumber: 'SYNTHETIC_SOURCE_COMPANY',
      },
    })
    const ids = { bank: randomUUID(), expense: randomUUID() }
    await db().account.createMany({
      data: [
        { id: ids.bank, organizationId: id, number: 1930, name: 'Syntetisk bank', type: 'ASSET' },
        {
          id: ids.expense,
          organizationId: id,
          number: 5170,
          name: 'Syntetisk kostnad',
          type: 'EXPENSE',
        },
      ],
    })
    accounts.set(id, ids)
    return id
  }
  async function seedExports(inputs: ExportInput[]) {
    const rows = inputs.map((input): Prisma.FortnoxVoucherExportCreateManyInput => {
      const id = input.id ?? randomUUID(),
        journalEntryId = randomUUID()
      exportIds.add(id)
      journalIds.add(journalEntryId)
      return {
        id,
        journalEntryId,
        organizationId: input.organizationId,
        state: input.state ?? 'CONFIRMED',
        fortnoxDatabaseNumber: input.company === undefined ? COMPANY : input.company,
        externalYear: input.year === undefined ? 1 : input.year,
        externalSeries: input.series === undefined ? 'L' : input.series,
        externalNumber: input.number === undefined ? ++sequence : input.number,
        draft: input.draft ?? VALID_DRAFT,
        draftHash: 'a'.repeat(64),
      }
    })
    await transaction(async (tx) => {
      await tx.journalEntry.createMany({
        data: rows.map(
          (row, index): Prisma.JournalEntryCreateManyInput => ({
            id: row.journalEntryId,
            organizationId: inputs[index]!.journalOrganizationId ?? inputs[index]!.organizationId,
            date: new Date('2026-01-01T00:00:00Z'),
            description: RAW_MARKER,
            source: 'MANUAL',
            sourceId: `synthetic-source:${row.journalEntryId}`,
            fiscalYear: 2026,
            series: 'A',
            verNumber: ++sequence,
          }),
        ),
      })
      await tx.journalEntryLine.createMany({
        data: rows.flatMap((row, index): Prisma.JournalEntryLineCreateManyInput[] => {
          const org = inputs[index]!.journalOrganizationId ?? inputs[index]!.organizationId
          const ids = accounts.get(org)
          if (!ids) throw new Error('Syntetiska konton saknas')
          return [
            {
              journalEntryId: row.journalEntryId,
              accountId: ids.bank,
              debit: '0.00',
              credit: '100.00',
            },
            {
              journalEntryId: row.journalEntryId,
              accountId: ids.expense,
              debit: '100.00',
              credit: '0.00',
            },
          ]
        }),
      })
      await tx.fortnoxVoucherExport.createMany({ data: rows })
    })
    return rows
  }
  async function seedMappings(org: string, count: number) {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      organizationId: org,
      dimensionType: index % 2 ? ('PROJECT' as const) : ('COST_CENTER' as const),
      code: `${index % 3 === 0 ? 'ä' : index % 3 === 1 ? 'Z' : 'a'}-${index}`,
      propertyId: randomUUID(),
      propertyName: `Syntetiskt hus ${index}`,
    }))
    await transaction(async (tx) => {
      await tx.property.createMany({
        data: rows.map(
          (row): Prisma.PropertyCreateManyInput => ({
            id: row.propertyId,
            organizationId: org,
            name: row.propertyName,
            propertyDesignation: `Syntetisk ${row.propertyId} 1:1`,
            type: 'RESIDENTIAL',
            street: 'Testgata 2',
            city: 'Teststad',
            postalCode: '11111',
            totalArea: '100.00',
          }),
        ),
      })
      await tx.fortnoxDimensionMapping.createMany({
        data: rows.map(({ propertyName, ...row }) => {
          expect(propertyName).toContain('Syntetiskt hus')
          return row
        }),
      })
    })
    return rows
  }
  async function allMappings(org: string, id: string) {
    const rows: Awaited<ReturnType<typeof readCheckpointSourceMappingPage>>['items'] = []
    let after = 0n
    for (;;) {
      const page = await transaction((tx) => readCheckpointSourceMappingPage(tx, org, id, after))
      expect(page.items.length).toBeLessThanOrEqual(100)
      rows.push(...page.items)
      if (page.nextAfterOrdinal === null) return rows
      expect(page.nextAfterOrdinal).toBeGreaterThan(after)
      after = page.nextAfterOrdinal
    }
  }
  async function allExports(org: string, id: string) {
    const rows: Awaited<ReturnType<typeof readCheckpointSourceExportPage>>['items'] = []
    let after = 0n
    for (;;) {
      const page = await transaction((tx) => readCheckpointSourceExportPage(tx, org, id, after))
      expect(page.items.length).toBeLessThanOrEqual(100)
      rows.push(...page.items)
      if (page.nextAfterOrdinal === null) return rows
      expect(page.nextAfterOrdinal).toBeGreaterThan(after)
      after = page.nextAfterOrdinal
    }
  }
  async function observerAbsent(org: string, id: string, expectedCity = 'Teststad') {
    const observer = new SourceTestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      await observer.$connect()
      expect(
        await observer.fortnoxReadSourceCapture.count({ where: { id, organizationId: org } }),
      ).toBe(0)
      expect(
        await observer.fortnoxReadSourceMapping.count({
          where: { captureId: id, organizationId: org },
        }),
      ).toBe(0)
      expect(
        await observer.fortnoxReadSourceExport.count({
          where: { captureId: id, organizationId: org },
        }),
      ).toBe(0)
      expect((await observer.organization.findUniqueOrThrow({ where: { id: org } })).city).toBe(
        expectedCity,
      )
    } finally {
      await observer.$disconnect()
    }
  }
  async function rawHeader(tx: Prisma.TransactionClient, org: string, id: string) {
    const connection = await tx.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: org },
    })
    return tx.fortnoxReadSourceCapture.create({
      data: {
        id,
        organizationId: org,
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        fortnoxDatabaseNumber: connection.fortnoxDatabaseNumber,
        fortnoxOrgNumber: connection.fortnoxOrgNumber,
        input: INPUT,
        requestHash: checkpointDigest(INPUT),
      },
    })
  }
  function rawMapping(org: string, id: string, ordinal = 1n) {
    return {
      organizationId: org,
      captureId: id,
      ordinal,
      sourceId: randomUUID(),
      dimensionType: 'COST_CENTER' as const,
      code: 'A',
      propertyId: 'synthetic-source-id',
      propertyName: 'Syntetiskt hus',
    }
  }
  function rawExport(org: string, id: string, ordinal = 1n) {
    return {
      organizationId: org,
      captureId: id,
      ordinal,
      sourceId: randomUUID(),
      externalYear: 1,
      externalSeries: 'L',
      externalNumber: 1,
      journalEntryId: 'synthetic-historical-journal',
      accountSource: VALID_DRAFT,
    }
  }
  async function waitBlocked(pid: number, blocker: number, expectedQuery: string) {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const rows = await db().$queryRaw<Array<{ blockers: number[]; query: string }>>(Prisma.sql`
        SELECT pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE pid = ${pid}`)
      if (rows[0]?.blockers.includes(blocker)) {
        expect(rows[0].query).toContain(expectedQuery)
        return
      }
    }
    throw new Error('Den verkliga PostgreSQL-låsbarriären observerades inte')
  }

  beforeAll(async () => {
    prisma = new SourceTestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
    matrixOrganizationId = await organization()
    const rows = await seedExports(
      CASES.map((item) => ({
        organizationId: matrixOrganizationId,
        draft: item.sqlNull
          ? Prisma.DbNull
          : item.original === null
            ? Prisma.JsonNull
            : item.original,
      })),
    )
    CASES.forEach((item, index) =>
      matrixRows.set(item.name, { journalEntryId: rows[index]!.journalEntryId }),
    )
    await capture(matrixOrganizationId, matrixCaptureId)
  })
  afterAll(async () => {
    if (!prisma) return
    const failures: unknown[] = []
    try {
      for (const id of organizations) {
        const owner = await prisma.organization.findUniqueOrThrow({
          where: { id },
          select: { name: true },
        })
        if (owner.name !== `synthetic-read-source-${id}`)
          throw new Error('Syntetiskt ägarskap stämmer inte')
      }
      await prisma.fortnoxVoucherExport.deleteMany({ where: { id: { in: [...exportIds] } } })
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: [...journalIds] } },
      })
      await prisma.journalEntry.deleteMany({ where: { id: { in: [...journalIds] } } })
      await prisma.account.deleteMany({
        where: { id: { in: [...accounts.values()].flatMap((ids) => [ids.bank, ids.expense]) } },
      })
      for (const id of organizations) await prisma.organization.delete({ where: { id } })
    } catch (error) {
      failures.push(error)
    } finally {
      await prisma.$disconnect()
    }
    if (failures.length)
      throw new AggregateError(failures, 'Källprovets egna fixturedata kunde inte städas')
  })

  it('KANARIEFÅGEL: explicit lokal DB, verklig försegling och exakt 36 handfall utan skip', async () => {
    const rows = await db().$queryRaw<Array<{ database: string }>>(
      Prisma.sql`SELECT current_database() AS database`,
    )
    expect(rows).toStrictEqual([
      { database: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
    ])
    expect(CASES).toHaveLength(36)
    expect(new Set(CASES.map((item) => item.name)).size).toBe(36)
    expect(
      (
        await transaction((tx) =>
          readCheckpointSourceHeader(tx, matrixOrganizationId, matrixCaptureId),
        )
      ).exportCount,
    ).toBe(36)
    expect(
      await db().fortnoxReadRun.count({ where: { organizationId: matrixOrganizationId } }),
    ).toBe(0)
    expect(
      await db().fortnoxReadContextSnapshot.count({
        where: { organizationId: matrixOrganizationId },
      }),
    ).toBe(0)
  })

  it.each(CASES)(
    '$name: fryst råkälla behåller handfacit och eventuell senare TypeError',
    async (item) => {
      const fixture = matrixRows.get(item.name)
      if (!fixture) throw new Error('Handfallets lagrade export saknas')
      const rows = await allExports(matrixOrganizationId, matrixCaptureId)
      expect(rows).toHaveLength(36)
      const matches = rows.filter((row) => row.journalEntryId === fixture.journalEntryId)
      expect(matches).toHaveLength(1)
      const projected = matches[0]!
      const stored = await db().fortnoxVoucherExport.findUniqueOrThrow({
        where: { journalEntryId: fixture.journalEntryId },
        select: { draft: true },
      })
      if (item.name === 'SQL-null-draft' || item.name === 'JSON-null-draft') {
        const nullKind = await db().$queryRaw<
          Array<{ sqlNull: boolean; jsonNull: boolean | null }>
        >(Prisma.sql`
        SELECT "draft" IS NULL AS "sqlNull", "draft" = 'null'::jsonb AS "jsonNull"
        FROM "FortnoxVoucherExport" WHERE "organizationId" = ${matrixOrganizationId}
          AND "journalEntryId" = ${fixture.journalEntryId}`)
        expect(nullKind).toStrictEqual(
          item.sqlNull ? [{ sqlNull: true, jsonNull: null }] : [{ sqlNull: false, jsonNull: true }],
        )
      }
      expect(outcome(stored.draft)).toStrictEqual(item.expected)
      const actual = outcome(projected.accountSource)
      expect(actual).toStrictEqual(item.expected)
      if (!('error' in actual))
        expect(
          CheckpointContextSchema.safeParse({
            version: 1,
            input: INPUT,
            mappings: [],
            ownExports: [
              {
                voucher: `${projected.externalYear}|${projected.externalSeries}|${projected.externalNumber}`,
                journalEntryId: projected.journalEntryId,
                revision: actual.revision,
                perMal: actual.perMal.map(([account, sources]) => ({ account, sources })),
              },
            ],
          }).success,
        ).toBe(item.contextValid ?? true)
      if (item.name === 'irrelevant-fields-do-not-affect-source') {
        expect(JSON.stringify(stored.draft)).toContain(RAW_MARKER)
        expect(JSON.stringify(projected.accountSource)).not.toContain(RAW_MARKER)
      }
    },
  )

  it.each([0, 1, 100, 101, 201])(
    '%i poster i båda samlingarna: exakt enum/textordning och sidgränser',
    async (count) => {
      const org = await organization(),
        id = randomUUID()
      const mappings = await seedMappings(org, count)
      const prefix = randomUUID()
      const exports = await seedExports(
        Array.from({ length: count }, (_, i) => ({
          organizationId: org,
          id: `${prefix}-${i % 2 ? 'ä' : 'Z'}-${i}`,
        })),
      )
      const expectedMappings = await db().fortnoxDimensionMapping.findMany({
        where: { id: { in: mappings.map((row) => row.id) } },
        orderBy: [{ dimensionType: 'asc' }, { code: 'asc' }],
      })
      const expectedExports = await db().fortnoxVoucherExport.findMany({
        where: { id: { in: exports.map((row) => row.id!) } },
        orderBy: { id: 'asc' },
      })
      const header = await capture(org, id)
      expect(header).toMatchObject({
        mappingCount: count,
        exportCount: count,
        sealedAt: expect.any(Date),
      })
      const actualMappings = await allMappings(org, id),
        actualExports = await allExports(org, id)
      expect(actualMappings.map((row) => row.sourceId)).toStrictEqual(
        expectedMappings.map((row) => row.id),
      )
      expect(actualExports.map((row) => row.sourceId)).toStrictEqual(
        expectedExports.map((row) => row.id),
      )
      expect(actualMappings.map((row) => row.ordinal)).toStrictEqual(
        Array.from({ length: count }, (_, i) => BigInt(i + 1)),
      )
      expect(actualExports.map((row) => row.ordinal)).toStrictEqual(
        Array.from({ length: count }, (_, i) => BigInt(i + 1)),
      )
      for (const after of [...new Set([0, Math.min(100, count), count])]) {
        const m = await transaction((tx) =>
          readCheckpointSourceMappingPage(tx, org, id, BigInt(after)),
        )
        const e = await transaction((tx) =>
          readCheckpointSourceExportPage(tx, org, id, BigInt(after)),
        )
        expect(m.items.map((row) => row.sourceId)).toStrictEqual(
          expectedMappings.slice(after, after + 100).map((row) => row.id),
        )
        expect(e.items.map((row) => row.sourceId)).toStrictEqual(
          expectedExports.slice(after, after + 100).map((row) => row.id),
        )
        const next = after + 100 < count ? BigInt(after + 100) : null
        expect(m.nextAfterOrdinal).toBe(next)
        expect(e.nextAfterOrdinal).toBe(next)
      }
      await expect(
        transaction((tx) => readCheckpointSourceExportPage(tx, org, id, BigInt(count + 1))),
      ).rejects.toBeInstanceOf(BadRequestException)
      await expect(
        transaction((tx) => readCheckpointSourceMappingPage(tx, org, id, -1n)),
      ).rejects.toBeInstanceOf(BadRequestException)
    },
  )

  it('behåller båda orgfiltren, propertyscope, företag/år/status/nullfilter och hela året', async () => {
    const org = await organization(),
      other = await organization()
    const wanted = await seedExports([{ organizationId: org }])
    const sentinels = await seedExports([
      { organizationId: org, year: 2 },
      { organizationId: org, company: COMPANY + 1 },
      { organizationId: org, state: 'RECEIPT_IDENTIFIED' },
      { organizationId: org, series: null },
      { organizationId: org, number: null },
      { organizationId: org, year: null },
      { organizationId: org, company: null },
      { organizationId: org, journalOrganizationId: other },
      { organizationId: other, journalOrganizationId: org },
      { organizationId: other },
    ])
    const ownMappings = await seedMappings(org, 1),
      otherMappings = await seedMappings(other, 1)
    await db().fortnoxDimensionMapping.create({
      data: {
        organizationId: org,
        dimensionType: 'PROJECT',
        code: 'FOREIGN_PROPERTY',
        propertyId: otherMappings[0]!.propertyId,
      },
    })
    const before = await db().fortnoxVoucherExport.findMany({
      where: { id: { in: [...wanted, ...sentinels].map((row) => row.id!) } },
      orderBy: { id: 'asc' },
    })
    expect(before).toHaveLength(11)
    const header = await capture(org)
    expect((await allExports(org, header.id)).map((row) => row.journalEntryId)).toStrictEqual([
      wanted[0]!.journalEntryId,
    ])
    expect((await allMappings(org, header.id)).map((row) => row.sourceId)).toStrictEqual([
      ownMappings[0]!.id,
    ])
    const foreign = await capture(other)
    expect((await allExports(other, foreign.id)).map((row) => row.journalEntryId)).toStrictEqual([
      sentinels[9]!.journalEntryId,
    ])
    await expect(
      transaction((tx) => readCheckpointSourceHeader(tx, other, header.id)),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      transaction((tx) => readCheckpointSourceExportPage(tx, other, header.id)),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      transaction((tx) => readCheckpointSourceMappingPage(tx, other, header.id)),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(capture(other, header.id)).rejects.toBeInstanceOf(ConflictException)
    expect(
      await db().fortnoxVoucherExport.findMany({
        where: { id: { in: before.map((row) => row.id) } },
        orderBy: { id: 'asc' },
      }),
    ).toStrictEqual(before)
  })

  it('nekar ReadCommitted och felaktigt urval innan någon kopia skrivs', async () => {
    const org = await organization(),
      id = randomUUID()
    await expect(
      transaction((tx) => captureCheckpointSource(tx, org, id, INPUT)),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(capture(org, id, { ...INPUT, periodFrom: '2026-02-30' })).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await observerAbsent(org, id)
  })

  it('två fångster i samma caller-Tx fungerar även efter ALL IMMEDIATE och delar inga barn', async () => {
    const org = await organization(),
      a = randomUUID(),
      b = randomUUID()
    await seedMappings(org, 1)
    await seedExports([{ organizationId: org }])
    const result = await rr(async (tx) => {
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
      const first = await captureCheckpointSource(tx, org, a, INPUT)
      const second = await captureCheckpointSource(tx, org, b, INPUT)
      return [first, second]
    })
    expect(result.map((row) => row.id)).toStrictEqual([a, b])
    expect((await allExports(org, a)).map((row) => row.sourceId)).toStrictEqual(
      (await allExports(org, b)).map((row) => row.sourceId),
    )
    expect((await allMappings(org, a)).map((row) => row.id)).not.toStrictEqual(
      (await allMappings(org, b)).map((row) => row.id),
    )
  })

  it('Europe/Stockholm bevarar skapande- och förseglingstid som verkliga instanter', async () => {
    const org = await organization(),
      id = randomUUID()
    const earliest = (
      await db().$queryRaw<Array<{ now: number }>>`
        SELECT extract(epoch FROM clock_timestamp())::float8 * 1000 AS now`
    )[0]!.now
    const header = await rr(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Europe/Stockholm'`
      const before = (
        await tx.$queryRaw<Array<{ started: number; now: number; zone: string }>>`
        SELECT extract(epoch FROM CURRENT_TIMESTAMP)::float8 * 1000 AS started,
          extract(epoch FROM clock_timestamp())::float8 * 1000 AS now,
          current_setting('TimeZone') AS zone`
      )[0]!
      expect(before.zone).toBe('Europe/Stockholm')
      const value = await captureCheckpointSource(tx, org, id, INPUT)
      const after = (
        await tx.$queryRaw<Array<{ created: number; sealed: number; now: number }>>(Prisma.sql`
        SELECT extract(epoch FROM "createdAt")::float8 * 1000 AS created,
          extract(epoch FROM "sealedAt")::float8 * 1000 AS sealed,
          extract(epoch FROM clock_timestamp())::float8 * 1000 AS now
        FROM "FortnoxReadSourceCapture" WHERE id=${id} AND "organizationId"=${org}`)
      )[0]!
      // Helpern binder uttryckligen CURRENT_TIMESTAMP från samma caller-Tx.
      // Separata DB-klockor avgränsar operationen, och lagrad TIMESTAMPTZ-epoch
      // bevisar att Date-värdet representerar exakt samma instant utan TZ-offset.
      expect(Math.abs(value.createdAt.getTime() - before.started)).toBeLessThanOrEqual(1)
      expect(value.createdAt.getTime()).toBe(Math.round(after.created))
      expect(value.createdAt.getTime()).toBeGreaterThanOrEqual(earliest - 1)
      expect(value.createdAt.getTime()).toBeLessThanOrEqual(after.now + 1)
      expect(value.sealedAt).toBeInstanceOf(Date)
      expect(value.sealedAt!.getTime()).toBe(Math.round(after.sealed))
      expect(value.sealedAt!.getTime()).toBeGreaterThanOrEqual(before.now - 1)
      expect(value.sealedAt!.getTime()).toBeLessThanOrEqual(after.now + 1)
      return value
    })
    expect(await transaction((tx) => readCheckpointSourceHeader(tx, org, id))).toStrictEqual(header)
  })

  it('anslutningsbyte framför väntande RR-lås propagerar serialiseringsfel; bara ny Tx får ny binding', async () => {
    const org = await organization(),
      id = randomUUID()
    const locked = deferred(),
      change = deferred(),
      started = deferred()
    let writerPid = 0,
      readerPid = 0
    const writer = transaction(async (tx) => {
      writerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
        .pid
      await tx.$queryRaw`SELECT id FROM "FortnoxConnection" WHERE "organizationId"=${org} FOR UPDATE`
      locked.resolve()
      await change.promise
      await tx.fortnoxConnection.update({
        where: { organizationId: org },
        data: {
          generation: { increment: 1 },
          fortnoxDatabaseNumber: COMPANY + 1,
        },
      })
    })
    const writerOutcome = Promise.allSettled([writer])
    let readerOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await Promise.race([
        locked.promise,
        writer.then(() => {
          throw new Error('Writer slutade före låsbarriären')
        }),
      ])
      const reader = rr(async (tx) => {
        readerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
          .pid
        started.resolve()
        return captureCheckpointSource(tx, org, id, INPUT)
      })
      readerOutcome = Promise.allSettled([reader])
      await Promise.race([
        started.promise,
        reader.then(() => {
          throw new Error('Capture passerade anslutningslåset')
        }),
      ])
      await waitBlocked(readerPid, writerPid, 'FortnoxConnection')
      change.resolve()
      await writer
      const [result] = await readerOutcome
      expect(result?.status).toBe('rejected')
      if (result?.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
        if (!(result.reason instanceof Prisma.PrismaClientKnownRequestError)) throw result.reason
        expect(
          result.reason.code === 'P2034' ||
            (result.reason.code === 'P2010' && result.reason.meta?.code === '40001'),
        ).toBe(true)
      }
      await observerAbsent(org, id)
      expect(await capture(org, id)).toMatchObject({
        connectionGeneration: 1,
        fortnoxDatabaseNumber: COMPANY + 1,
      })
    } finally {
      change.resolve()
      await writerOutcome
      if (readerOutcome) await readerOutcome
    }
  })

  it('byte efter capture-låset väntar på commit och kan aldrig skriva om den frysta bindningen', async () => {
    const org = await organization(),
      id = randomUUID()
    const captured = deferred(),
      commit = deferred(),
      writerStarted = deferred()
    let readerPid = 0,
      writerPid = 0
    const reader = rr(async (tx) => {
      readerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
        .pid
      const value = await captureCheckpointSource(tx, org, id, INPUT)
      captured.resolve()
      await commit.promise
      return value
    })
    const readerOutcome = Promise.allSettled([reader])
    let writerOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await Promise.race([
        captured.promise,
        reader.then(() => {
          throw new Error('Capture slutade före commitbarriären')
        }),
      ])
      const writer = transaction(async (tx) => {
        writerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
          .pid
        writerStarted.resolve()
        await tx.fortnoxConnection.update({
          where: { organizationId: org },
          data: {
            generation: { increment: 1 },
            status: 'DISCONNECTED',
          },
        })
      })
      writerOutcome = Promise.allSettled([writer])
      await Promise.race([
        writerStarted.promise,
        writer.then(() => {
          throw new Error('Anslutningsbytet passerade låset')
        }),
      ])
      await waitBlocked(writerPid, readerPid, 'FortnoxConnection')
      commit.resolve()
      const header = await reader
      await writer
      expect(header.connectionGeneration).toBe(0)
      expect(await transaction((tx) => readCheckpointSourceHeader(tx, org, id))).toStrictEqual(
        header,
      )
      await expect(capture(org, id)).rejects.toBeInstanceOf(ConflictException)
      await expect(capture(org)).rejects.toBeInstanceOf(ConflictException)
      expect(await db().fortnoxReadSourceCapture.count({ where: { organizationId: org } })).toBe(1)
    } finally {
      commit.resolve()
      await readerOutcome
      if (writerOutcome) await writerOutcome
    }
  })

  it('förlorat svar replayas i ny klient; historisk läsning kräver ingen aktuell anslutning', async () => {
    const org = await organization(),
      id = randomUUID()
    const [live] = await seedExports([{ organizationId: org }])
    const header = await capture(org, id)
    const rows = await allExports(org, id)
    await db().fortnoxVoucherExport.update({
      where: { id: live!.id! },
      data: { draft: {}, externalNumber: 7777 },
    })
    await db().fortnoxConnection.update({
      where: { organizationId: org },
      data: { tokenVersion: { increment: 1 } },
    })
    const observer = new SourceTestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      await observer.$connect()
      expect(
        await rr(
          (tx) => captureCheckpointSource(tx, org, id, { ...INPUT, costAccounts: [5170, 5170] }),
          observer,
        ),
      ).toStrictEqual(header)
      expect(
        await transaction((tx) => readCheckpointSourceExportPage(tx, org, id), observer),
      ).toStrictEqual({ items: rows, nextAfterOrdinal: null })
      await expect(capture(org, id, { ...INPUT, periodTo: '2026-10-30' })).rejects.toBeInstanceOf(
        ConflictException,
      )
      await db().fortnoxConnection.update({
        where: { organizationId: org },
        data: { generation: { increment: 1 }, status: 'DISCONNECTED' },
      })
      await expect(capture(org, id)).rejects.toBeInstanceOf(ConflictException)
      expect(
        await transaction((tx) => readCheckpointSourceHeader(tx, org, id), observer),
      ).toStrictEqual(header)
      expect(
        await transaction((tx) => readCheckpointSourceExportPage(tx, org, id), observer),
      ).toStrictEqual({ items: rows, nextAfterOrdinal: null })
    } finally {
      await observer.$disconnect()
    }
  })

  it('explicit undefined-årgräns lagras utan nyckeln och replayas identiskt när den utelämnas', async () => {
    const org = await organization(),
      id = randomUUID()
    await seedExports([{ organizationId: org }])
    const absent = {
      financialYearId: INPUT.financialYearId,
      periodFrom: INPUT.periodFrom,
      periodTo: INPUT.periodTo,
      costAccounts: INPUT.costAccounts,
    }
    const header = await capture(org, id, {
      ...absent,
      financialYearStart: undefined,
      financialYearEnd: undefined,
    })
    const stored = await db().fortnoxReadSourceCapture.findUniqueOrThrow({ where: { id } })
    expect(stored.input).toStrictEqual(absent)
    expect(stored.input).not.toHaveProperty('financialYearStart')
    expect(stored.input).not.toHaveProperty('financialYearEnd')
    expect(stored.requestHash).toBe(checkpointDigest(absent))
    const exports = await allExports(org, id)
    expect(await transaction((tx) => readCheckpointSourceHeader(tx, org, id))).toStrictEqual(header)
    expect(await capture(org, id, absent)).toStrictEqual(header)
    expect(await allExports(org, id)).toStrictEqual(exports)
    expect(await db().fortnoxReadSourceCapture.count({ where: { organizationId: org } })).toBe(1)
  })

  it('samtidiga anrop med samma id ger högst en kopia och kan replayas i ny RR-transaktion', async () => {
    const org = await organization(),
      id = randomUUID()
    await seedMappings(org, 1)
    await seedExports([{ organizationId: org }])
    const attempts = await Promise.allSettled([capture(org, id), capture(org, id)])
    expect(attempts.some((result) => result.status === 'fulfilled')).toBe(true)
    for (const result of attempts)
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException)
    expect(await db().fortnoxReadSourceCapture.count({ where: { id, organizationId: org } })).toBe(
      1,
    )
    expect(await db().fortnoxReadSourceMapping.count({ where: { captureId: id } })).toBe(1)
    expect(await db().fortnoxReadSourceExport.count({ where: { captureId: id } })).toBe(1)
    expect(await capture(org, id)).toStrictEqual(
      await transaction((tx) => readCheckpointSourceHeader(tx, org, id)),
    )
  })

  it('RR fryser samma gamla mängd trots update samt INSERT/DELETE-phantom mellan kopiorna', async () => {
    const org = await organization(),
      id = randomUUID()
    const mappings = await seedMappings(org, 2)
    const live = await seedExports([{ organizationId: org }, { organizationId: org }])
    const beforeMappings = await db().fortnoxDimensionMapping.findMany({
      where: { organizationId: org },
      orderBy: [{ dimensionType: 'asc' }, { code: 'asc' }],
    })
    const beforeExports = await db().fortnoxVoucherExport.findMany({
      where: { organizationId: org },
      orderBy: { id: 'asc' },
    })
    const writerReady = deferred(),
      writeNow = deferred(),
      captureReady = deferred()
    let writerPid = 0,
      capturePid = 0
    const phantomId = randomUUID()
    exportIds.add(phantomId)
    const writer = transaction(async (tx) => {
      writerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
        .pid
      await tx.$executeRaw`LOCK TABLE "FortnoxVoucherExport" IN ACCESS EXCLUSIVE MODE`
      writerReady.resolve()
      await writeNow.promise
      await tx.property.update({
        where: { id: mappings[0]!.propertyId },
        data: { name: 'SYNTHETIC_CHANGED' },
      })
      await tx.fortnoxDimensionMapping.update({
        where: { id: mappings[0]!.id },
        data: { code: 'SYNTHETIC_CHANGED' },
      })
      await tx.fortnoxDimensionMapping.delete({ where: { id: mappings[1]!.id } })
      await tx.fortnoxDimensionMapping.create({
        data: {
          organizationId: org,
          dimensionType: 'PROJECT',
          code: 'PHANTOM',
          propertyId: mappings[1]!.propertyId,
        },
      })
      await tx.fortnoxVoucherExport.update({
        where: { id: live[0]!.id! },
        data: { draft: {}, externalNumber: 991 },
      })
      await tx.fortnoxVoucherExport.delete({ where: { id: live[1]!.id! } })
      await tx.fortnoxVoucherExport.create({
        data: {
          id: phantomId,
          organizationId: org,
          journalEntryId: live[1]!.journalEntryId,
          state: 'CONFIRMED',
          fortnoxDatabaseNumber: COMPANY,
          externalYear: 1,
          externalSeries: 'L',
          externalNumber: 992,
          draft: VALID_DRAFT,
        },
      })
    })
    const writerSettled = writer.then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    )
    let captureAttempt: Promise<Awaited<ReturnType<typeof capture>>> | undefined
    try {
      await Promise.race([
        writerReady.promise,
        writer.then(() => {
          throw new Error('Writer slutade före barriären')
        }),
      ])
      captureAttempt = rr(async (tx) => {
        capturePid = (
          await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        )[0]!.pid
        captureReady.resolve()
        return captureCheckpointSource(tx, org, id, INPUT)
      })
      const captured = captureAttempt
      const completed = captured.then(() => {
        throw new Error('Capture passerade före verklig låsbarriär')
      })
      await Promise.race([captureReady.promise, completed])
      await waitBlocked(capturePid, writerPid, 'FortnoxReadSourceExport')
      writeNow.resolve()
      await writer
      await captured
      const actualMappings = await allMappings(org, id),
        actualExports = await allExports(org, id)
      expect(
        actualMappings.map((row) => ({ id: row.sourceId, code: row.code, name: row.propertyName })),
      ).toStrictEqual(
        beforeMappings.map((row) => ({
          id: row.id,
          code: row.code,
          name: mappings.find((m) => m.id === row.id)!.propertyName,
        })),
      )
      expect(
        actualExports.map((row) => ({
          id: row.sourceId,
          number: row.externalNumber,
          source: outcome(row.accountSource),
        })),
      ).toStrictEqual(
        beforeExports.map((row) => ({
          id: row.id,
          number: row.externalNumber,
          source: outcome(row.draft),
        })),
      )
      expect(await db().fortnoxVoucherExport.findUnique({ where: { id: live[1]!.id! } })).toBeNull()
      expect(
        await db().fortnoxVoucherExport.findUniqueOrThrow({ where: { id: phantomId } }),
      ).toMatchObject({ externalNumber: 992 })
    } finally {
      writeNow.resolve()
      await writerSettled
      if (captureAttempt) await captureAttempt.catch(() => undefined)
    }
  })

  it.each([
    { stage: 'mapping', caught: false, immediate: false },
    { stage: 'export', caught: false, immediate: false },
    { stage: 'export', caught: true, immediate: false },
    { stage: 'export', caught: true, immediate: true },
  ] as const)(
    'fel efter $stage, caught=$caught immediate=$immediate: hela caller-Tx återställs',
    async ({ stage, caught, immediate }) => {
      const org = await organization(),
        id = randomUUID()
      await seedMappings(org, 1)
      await seedExports([{ organizationId: org }])
      const injected = new Error('SYNTHETIC_SOURCE_COPY_FAILURE')
      let wroteChildren = false,
        callerMarker = false
      const attempt = rr(async (tx) => {
        await tx.organization.update({ where: { id: org }, data: { city: 'BEFORE_CAPTURE' } })
        const rawExecute = tx.$executeRaw.bind(tx),
          rawQuery = tx.$queryRaw.bind(tx)
        const executeSpy = jest.spyOn(tx, '$executeRaw').mockImplementation((query, ...values) => {
          const text = 'sql' in query ? query.sql : query.join('')
          if (stage === 'mapping' && text.includes('INSERT INTO "FortnoxReadSourceExport"'))
            throw injected
          return rawExecute(query, ...values)
        })
        const querySpy = jest.spyOn(tx, '$queryRaw').mockImplementation((query, ...values) => {
          const text = 'sql' in query ? query.sql : query.join('')
          if (stage === 'export' && text.includes('UPDATE "FortnoxReadSourceCapture"'))
            throw injected
          return rawQuery(query, ...values)
        })
        try {
          await captureCheckpointSource(tx, org, id, INPUT)
        } catch (error) {
          expect(error).toBe(injected)
          expect(await tx.fortnoxReadSourceMapping.count({ where: { captureId: id } })).toBe(1)
          expect(await tx.fortnoxReadSourceExport.count({ where: { captureId: id } })).toBe(
            stage === 'export' ? 1 : 0,
          )
          expect(
            (await tx.fortnoxReadSourceCapture.findUniqueOrThrow({ where: { id } })).sealedAt,
          ).toBeNull()
          await expect(readCheckpointSourceHeader(tx, org, id)).rejects.toBeInstanceOf(
            ConflictException,
          )
          await expect(readCheckpointSourceMappingPage(tx, org, id)).rejects.toBeInstanceOf(
            ConflictException,
          )
          wroteChildren = true
          if (!caught) throw error
          await tx.organization.update({ where: { id: org }, data: { city: 'AFTER_CAUGHT_ERROR' } })
          expect((await tx.organization.findUniqueOrThrow({ where: { id: org } })).city).toBe(
            'AFTER_CAUGHT_ERROR',
          )
          callerMarker = true
          if (immediate)
            await tx.$executeRaw`SET CONSTRAINTS "fortnox_source_commit_seal" IMMEDIATE`
        } finally {
          executeSpy.mockRestore()
          querySpy.mockRestore()
        }
      })
      const [result] = await Promise.allSettled([attempt])
      expect(wroteChildren).toBe(true)
      expect(callerMarker).toBe(caught)
      if (!caught) {
        expect(result?.status).toBe('rejected')
        if (result?.status === 'rejected') expect(result.reason).toBe(injected)
      }
      if (immediate) {
        expect(result?.status).toBe('rejected')
        if (result?.status === 'rejected')
          expect(result.reason).toMatchObject({ code: 'P2010', meta: { code: '23514' } })
      }
      // Prisma5.22 kan felaktigt fulfilled vid deferred COMMIT-avslag. Oberoende
      // klient måste se både källa OCH caller-markör fullständigt återställda.
      await observerAbsent(org, id)
    },
  )

  it('även fel efter komplett seal rullar tillbaka; befintlig v1-run/snapshot ändras aldrig', async () => {
    const org = await organization(),
      id = randomUUID()
    await seedMappings(org, 1)
    await seedExports([{ organizationId: org }])
    const service = new FortnoxReadCheckpointService(db())
    const run = await service.start(org, null, INPUT)
    const snapshot = await transaction((tx) => freezeCheckpointContext(tx, org, run.id))
    const pages = await db().fortnoxReadContextPage.findMany({
      where: { snapshotId: snapshot.id },
      orderBy: [{ kind: 'asc' }, { page: 'asc' }],
    })
    const marker = new Error('SYNTHETIC_AFTER_SEAL')
    await expect(
      rr(async (tx) => {
        await tx.organization.update({ where: { id: org }, data: { city: 'BEFORE_CAPTURE' } })
        expect((await captureCheckpointSource(tx, org, id, INPUT)).sealedAt).toBeInstanceOf(Date)
        throw marker
      }),
    ).rejects.toBe(marker)
    await observerAbsent(org, id)
    await capture(org, id)
    expect(await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } })).toStrictEqual(
      run,
    )
    expect(await transaction((tx) => freezeCheckpointContext(tx, org, run.id))).toStrictEqual(
      snapshot,
    )
    expect(
      await db().fortnoxReadContextPage.findMany({
        where: { snapshotId: snapshot.id },
        orderBy: [{ kind: 'asc' }, { page: 'asc' }],
      }),
    ).toStrictEqual(pages)
  })

  it('direkt SQL nekar ändring/radering/truncate för båda barn och binder parent till org', async () => {
    const org = await organization(),
      other = await organization()
    await seedMappings(org, 1)
    await seedExports([{ organizationId: org }])
    const header = await capture(org),
      mappings = await allMappings(org, header.id),
      exports = await allExports(org, header.id)
    const actions: Prisma.Sql[] = [
      Prisma.sql`UPDATE "FortnoxReadSourceMapping" SET "code"='CHANGED' WHERE "captureId"=${header.id}`,
      Prisma.sql`UPDATE "FortnoxReadSourceExport" SET "accountSource"='{}'::jsonb WHERE "captureId"=${header.id}`,
      Prisma.sql`UPDATE "FortnoxReadSourceMapping" SET "code"='CHANGED' WHERE FALSE`,
      Prisma.sql`UPDATE "FortnoxReadSourceExport" SET "accountSource"='{}'::jsonb WHERE FALSE`,
      Prisma.sql`DELETE FROM "FortnoxReadSourceMapping" WHERE "captureId"=${header.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadSourceExport" WHERE "captureId"=${header.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadSourceCapture" WHERE "id"=${header.id}`,
      Prisma.sql`UPDATE "FortnoxReadSourceCapture" SET "sealedAt"=NULL WHERE "id"=${header.id}`,
      Prisma.sql`UPDATE "FortnoxReadSourceCapture" SET "fortnoxDatabaseNumber"=900002 WHERE "id"=${header.id}`,
      Prisma.sql`TRUNCATE "FortnoxReadSourceMapping"`,
      Prisma.sql`TRUNCATE "FortnoxReadSourceExport"`,
      Prisma.sql`TRUNCATE "FortnoxReadSourceCapture" CASCADE`,
    ]
    for (const sql of actions)
      await expect(transaction((tx) => tx.$executeRaw(sql))).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '23514' },
      })
    await expect(
      transaction((tx) =>
        tx.fortnoxReadSourceMapping.create({ data: rawMapping(org, header.id, 2n) }),
      ),
    ).rejects.toThrow()
    await expect(
      transaction((tx) =>
        tx.fortnoxReadSourceExport.create({ data: rawExport(org, header.id, 2n) }),
      ),
    ).rejects.toThrow()
    await expect(
      transaction((tx) =>
        tx.$executeRaw(
          Prisma.sql`INSERT INTO "FortnoxReadSourceMapping" (id,"organizationId","captureId",ordinal,"sourceId","dimensionType",code,"propertyId","propertyName") VALUES (${randomUUID()},${other},${header.id},1,${randomUUID()},'COST_CENTER','A','X','X')`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } })
    await expect(
      transaction((tx) =>
        tx.$executeRaw(
          Prisma.sql`INSERT INTO "FortnoxReadSourceExport" (id,"organizationId","captureId",ordinal,"sourceId","externalYear","externalSeries","externalNumber","journalEntryId","accountSource") VALUES (${randomUUID()},${other},${header.id},1,${randomUUID()},1,'L',1,'X','{}'::jsonb)`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } })
    expect(await transaction((tx) => readCheckpointSourceHeader(tx, org, header.id))).toStrictEqual(
      header,
    )
    expect(await allMappings(org, header.id)).toStrictEqual(mappings)
    expect(await allExports(org, header.id)).toStrictEqual(exports)
  })

  it.each(
    (['mapping', 'export'] as const).flatMap((collection) =>
      (['zero', 'duplicate-ordinal', 'duplicate-source', 'gap', 'wrong-count'] as const).map(
        (kind) => ({ collection, kind }),
      ),
    ),
  )(
    'direkt SQL-fel $collection/$kind lämnar inga halvfärdiga rader',
    async ({ collection, kind }) => {
      const org = await organization(),
        id = randomUUID()
      await expect(
        transaction(async (tx) => {
          await rawHeader(tx, org, id)
          const sourceId = randomUUID()
          const insert = (ordinal: bigint, source: string) =>
            collection === 'mapping'
              ? tx.$executeRaw(
                  Prisma.sql`INSERT INTO "FortnoxReadSourceMapping" (id,"organizationId","captureId",ordinal,"sourceId","dimensionType",code,"propertyId","propertyName") VALUES (${randomUUID()},${org},${id},${ordinal},${source},'COST_CENTER','A','X','X')`,
                )
              : tx.$executeRaw(
                  Prisma.sql`INSERT INTO "FortnoxReadSourceExport" (id,"organizationId","captureId",ordinal,"sourceId","externalYear","externalSeries","externalNumber","journalEntryId","accountSource") VALUES (${randomUUID()},${org},${id},${ordinal},${source},1,'L',1,'X','{}'::jsonb)`,
                )
          await insert(kind === 'zero' ? 0n : kind === 'gap' ? 2n : 1n, sourceId)
          if (kind === 'duplicate-ordinal' || kind === 'duplicate-source')
            await insert(
              kind === 'duplicate-source' ? 2n : 1n,
              kind === 'duplicate-source' ? sourceId : randomUUID(),
            )
          await tx.$executeRaw(Prisma.sql`UPDATE "FortnoxReadSourceCapture"
        SET "sealedAt"=clock_timestamp(),
          "mappingCount"=${collection === 'mapping' && kind !== 'wrong-count' ? 1 : 0},
          "exportCount"=${collection === 'export' && kind !== 'wrong-count' ? 1 : 0}
        WHERE id=${id}`)
        }),
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: kind.startsWith('duplicate') ? '23505' : '23514' },
      })
      await observerAbsent(org, id)
    },
  )

  it.each(['presealed', 'rebind-before-seal'] as const)(
    'header %s nekas direkt i SQL',
    async (kind) => {
      const org = await organization(),
        id = randomUUID()
      await expect(
        transaction(async (tx) => {
          if (kind === 'presealed') {
            const connection = await tx.fortnoxConnection.findUniqueOrThrow({
              where: { organizationId: org },
            })
            await tx.$executeRaw(
              Prisma.sql`INSERT INTO "FortnoxReadSourceCapture" (id,"organizationId","connectionId","connectionGeneration","fortnoxDatabaseNumber","input","requestHash","sealedAt") VALUES (${id},${org},${connection.id},0,${COMPANY},${JSON.stringify(INPUT)}::jsonb,${checkpointDigest(INPUT)},now())`,
            )
          } else {
            await rawHeader(tx, org, id)
            await tx.$executeRaw(
              Prisma.sql`UPDATE "FortnoxReadSourceCapture" SET "sealedAt"=now(), "connectionGeneration"=1 WHERE id=${id}`,
            )
          }
        }),
      ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
      await observerAbsent(org, id)
    },
  )

  it('historisk header nekar ett välformat men felaktigt inputhashbevis', async () => {
    const org = await organization(),
      id = randomUUID()
    await transaction(async (tx) => {
      const connection = await tx.fortnoxConnection.findUniqueOrThrow({
        where: { organizationId: org },
      })
      await tx.fortnoxReadSourceCapture.create({
        data: {
          id,
          organizationId: org,
          connectionId: connection.id,
          connectionGeneration: 0,
          fortnoxDatabaseNumber: COMPANY,
          input: INPUT,
          requestHash: 'a'.repeat(64),
        },
      })
      await tx.fortnoxReadSourceCapture.update({ where: { id }, data: { sealedAt: new Date() } })
    })
    await expect(
      transaction((tx) => readCheckpointSourceHeader(tx, org, id)),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      transaction((tx) => readCheckpointSourceExportPage(tx, org, id)),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('riktig orgcascade raderar bara egna förseglade källor, även med båda org-FK-vägarna', async () => {
    const org = await organization(),
      other = await organization()
    await seedMappings(org, 1)
    await seedMappings(other, 1)
    const ownLive = await seedExports([{ organizationId: org }])
    await seedExports([{ organizationId: other }])
    const a = await capture(org),
      b = await capture(other)
    expect(a).toMatchObject({ mappingCount: 1, exportCount: 1 })
    const foreignMappings = await allMappings(other, b.id),
      foreignExports = await allExports(other, b.id)
    expect(foreignMappings).toHaveLength(1)
    expect(foreignExports).toHaveLength(1)
    await transaction(async (tx) => {
      // Bara provets egna Restrict-beroenden städas före den verkliga orgcascaden.
      // Frysta historiska källor har avsiktligt inga FK till dessa live-rader.
      await tx.fortnoxVoucherExport.deleteMany({
        where: { id: { in: ownLive.map((row) => row.id!) } },
      })
      await tx.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: ownLive.map((row) => row.journalEntryId) } },
      })
      await tx.journalEntry.deleteMany({
        where: { id: { in: ownLive.map((row) => row.journalEntryId) } },
      })
      await tx.account.deleteMany({ where: { organizationId: org } })
      await tx.organization.delete({ where: { id: org } })
    })
    organizations.delete(org)
    accounts.delete(org)
    expect(await db().fortnoxReadSourceCapture.findUnique({ where: { id: a.id } })).toBeNull()
    expect(await db().fortnoxReadSourceMapping.count({ where: { captureId: a.id } })).toBe(0)
    expect(await db().fortnoxReadSourceExport.count({ where: { captureId: a.id } })).toBe(0)
    expect(await transaction((tx) => readCheckpointSourceHeader(tx, other, b.id))).toStrictEqual(b)
    expect(await allMappings(other, b.id)).toStrictEqual(foreignMappings)
    expect(await allExports(other, b.id)).toStrictEqual(foreignExports)
  })
})
