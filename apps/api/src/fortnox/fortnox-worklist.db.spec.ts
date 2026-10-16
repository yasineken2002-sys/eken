/**
 * Arbetslistans verkliga PostgreSQL-gräns. Alla rader är syntetiska och ägs av
 * denna svit. Ingen Fortnox-provider, betalning eller automatisk sändning används.
 * 205 rader är ett regressionsprov för ett listtak, inte ett kapacitetsbevis.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import type { FortnoxExportState, JournalEntrySource, Prisma } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Arbetslisteprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error('Arbetslisteprovet tillåter bara lokal *_test eller CI:s lokala eken_dev')
  }
  url.searchParams.set('connection_limit', '2')
  return url.toString()
}

interface SeedRow {
  id: string
  journalEntryId: string
  state: FortnoxExportState
  source: JournalEntrySource
  date: string
  createdAt: Date
  updatedAt: Date
}

const PROBLEM_STATES = ['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH', 'RECEIPT_IDENTIFIED'] as const
const PRIVATE_MARKER = 'SYNTHETIC_WORKLIST_PRIVATE_SENTINEL'
const HISTORY_MARKER = 'SYNTHETIC_WORKLIST_EVIDENCE_SENTINEL'

describe('Fortnox exportarbetslista mot riktig PostgreSQL', () => {
  let prisma: PrismaClient | undefined
  let service: FortnoxExportService
  let organizationId: string
  let otherOrganizationId: string
  let ownRows: SeedRow[]
  let foreignRows: SeedRow[]
  const organizations: string[] = []
  const builder: FortnoxVoucherDraftBuilder = {
    build: jest.fn(async () => {
      throw new Error('En läsning får inte bygga om eller sända ett verifikat')
    }),
  }
  let originalExports: Awaited<ReturnType<typeof savedExports>>

  function db(): PrismaClient {
    if (!prisma) throw new Error('PostgreSQL-fixturen har inte startats')
    return prisma
  }

  async function savedExports() {
    return db().fortnoxVoucherExport.findMany({
      where: { organizationId: { in: organizations } },
      orderBy: { id: 'asc' },
    })
  }

  function row(
    state: FortnoxExportState,
    source: JournalEntrySource,
    date: string,
    createdAt: Date,
    updatedAt: Date,
  ): SeedRow {
    return {
      id: randomUUID(),
      journalEntryId: randomUUID(),
      state,
      source,
      date,
      createdAt,
      updatedAt,
    }
  }

  async function seedOrganization(rows: SeedRow[]): Promise<string> {
    const id = randomUUID()
    await db().organization.create({
      data: {
        id,
        name: `synthetic-worklist-${id}`,
        email: `${id}@example.invalid`,
        street: 'Syntetisk testgata 1',
        postalCode: '11111',
        city: 'Teststad',
      },
    })
    organizations.push(id)
    const debitAccountId = randomUUID()
    const creditAccountId = randomUUID()
    await db().account.createMany({
      data: [
        { id: debitAccountId, organizationId: id, number: 1930, name: 'Test bank', type: 'ASSET' },
        {
          id: creditAccountId,
          organizationId: id,
          number: 1510,
          name: 'Test fordran',
          type: 'ASSET',
        },
      ],
    })
    await db().journalEntry.createMany({
      data: rows.map((item, index) => ({
        id: item.journalEntryId,
        organizationId: id,
        date: new Date(`${item.date}T00:00:00Z`),
        description: `Syntetiskt listunderlag ${index}`,
        source: item.source,
        sourceId: `synthetic-worklist:${item.journalEntryId}`,
        fiscalYear: Number(item.date.slice(0, 4)),
        series: 'A',
        verNumber: index + 1,
        // Avsiktligt annan tid än exportens: sorteringen ska följa kontraktet.
        createdAt: new Date('2026-06-01T00:00:00Z'),
      })),
    })
    await db().journalEntryLine.createMany({
      data: rows.flatMap((item) => [
        { journalEntryId: item.journalEntryId, accountId: debitAccountId, debit: '100.00' },
        { journalEntryId: item.journalEntryId, accountId: creditAccountId, credit: '100.00' },
      ]),
    })
    const draft: Prisma.InputJsonObject = {
      privateBankReference: PRIVATE_MARKER,
      provenance: {
        privateSource: PRIVATE_MARKER,
        text: {
          falt: [
            { falt: 'Description', rad: null, ra: 'Test — original', export: 'Test – original' },
          ],
        },
      },
    }
    await db().fortnoxVoucherExport.createMany({
      data: rows.map((item) => ({
        id: item.id,
        organizationId: id,
        journalEntryId: item.journalEntryId,
        state: item.state,
        draft,
        draftHash: 'a'.repeat(64),
        attemptHistory: [{ typ: 'SYNTHETIC_EVIDENCE', privateEvidence: HISTORY_MARKER }],
        lastOutcome: item.state === 'REJECTED' ? 'REJECTED' : null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    })
    return id
  }

  function ordered(rows: SeedRow[]): SeedRow[] {
    return [...rows].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return b.createdAt.getTime() - a.createdAt.getTime()
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: isolatedDatabaseUrl() } } })
    await prisma.$connect()
    service = new FortnoxExportService(prisma as unknown as PrismaService, builder)
    const old = new Date('2024-04-01T00:00:00Z')
    ownRows = [
      row('UNKNOWN', 'PAYMENT', '2023-12-31', old, old),
      row('REJECTED', 'PAYMENT', '2024-02-29', old, old),
      row('RECEIPT_MISMATCH', 'INVOICE', '2024-02-29', old, old),
      row('RECEIPT_IDENTIFIED', 'LEASE', '2024-03-01', old, old),
      ...Array.from({ length: 201 }, (_, index) =>
        row(
          'CONFIRMED',
          index % 2 === 0 ? 'PAYMENT' : 'INVOICE',
          new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 3))).toISOString().slice(0, 10),
          // Samma datum/tid förekommer: id måste bryta likheten över sidgränser.
          new Date(Date.UTC(2026, 3, 1, 0, 0, index % 2)),
          // Motsatt ordning mot verifikationsdatum: updatedAt är inte datumfiltret.
          new Date(Date.UTC(2026, 4, 1, 0, 0, 201 - index)),
        ),
      ),
    ]
    foreignRows = [
      ...PROBLEM_STATES.map((state) => row(state, 'PAYMENT', '2024-02-29', old, old)),
      ...(['DRY_RUN_READY', 'BLOCKED', 'SENDING'] as const).map((state) =>
        row(state, 'PAYMENT', '2026-01-01', old, old),
      ),
    ]
    organizationId = await seedOrganization(ownRows)
    otherOrganizationId = await seedOrganization(foreignRows)
    originalExports = await savedExports()
  })

  afterAll(async () => {
    if (!prisma) return
    const failures: unknown[] = []
    for (const id of organizations) {
      try {
        await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
        await prisma.journalEntryLine.deleteMany({
          where: { journalEntry: { organizationId: id } },
        })
        await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
        await prisma.account.deleteMany({ where: { organizationId: id } })
        await prisma.organization.delete({ where: { id } })
      } catch (error) {
        failures.push(error)
      }
    }
    await prisma.$disconnect()
    if (failures.length)
      throw new AggregateError(failures, 'Kunde inte städa arbetslistans egna fixturer')
  })

  it('hittar alla fyra äldre problem bakom 201 nyare CONFIRMED, även utan datumfilter', async () => {
    const page = await service.listPage(organizationId, { group: 'NEEDS_REVIEW' })
    expect(page).toMatchObject({ total: 4, offset: 0, limit: 50 })
    expect(page.items.map((item) => item.id)).toEqual(
      ordered(ownRows.slice(0, 4)).map((item) => item.id),
    )
    expect(page.items.map((item) => item.state).sort()).toEqual([...PROBLEM_STATES].sort())
  })

  it('har standard 0/50/ALL och når första, mellanliggande och sista sidan utan tapp eller dubbletter', async () => {
    const first = await service.listPage(organizationId, {})
    expect(first).toMatchObject({ total: 205, offset: 0, limit: 50 })
    const ids = first.items.map((item) => item.id)
    expect(ids).toEqual(
      ordered(ownRows)
        .slice(0, 50)
        .map((item) => item.id),
    )
    for (const offset of [50, 100, 150, 200]) {
      const page = await service.listPage(organizationId, { offset, limit: 50 })
      expect(page).toMatchObject({ total: 205, offset, limit: 50 })
      expect(page.items).toHaveLength(offset === 200 ? 5 : 50)
      ids.push(...page.items.map((item) => item.id))
    }
    expect(ids).toEqual(ordered(ownRows).map((item) => item.id))
    expect(new Set(ids).size).toBe(205)
  })

  it('sorterar samma verifikationsdatum och exporttid stabilt med id även på enradssidor', async () => {
    const expected = ordered(ownRows.filter((item) => item.date === '2026-01-01'))
    expect(expected).toHaveLength(3)
    const actual: string[] = []
    for (const offset of [0, 1, 2]) {
      const page = await service.listPage(organizationId, {
        from: '2026-01-01',
        to: '2026-01-01',
        offset,
        limit: 1,
      })
      expect(page.total).toBe(3)
      expect(page.items).toHaveLength(1)
      actual.push(...page.items.map((item) => item.id))
    }
    expect(actual).toEqual(expected.map((item) => item.id))
  })

  it('använder inkluderat verifikationsdatum på skottdagen, samma source och filter före total/sida', async () => {
    const all = await service.listPage(organizationId, {
      from: '2024-02-29',
      to: '2024-02-29',
      group: 'NEEDS_REVIEW',
      limit: 1,
    })
    expect(all.total).toBe(2)
    expect(all.items).toHaveLength(1)
    const payment = await service.listPage(organizationId, {
      from: '2024-02-29',
      to: '2024-02-29',
      source: 'PAYMENT',
      group: 'NEEDS_REVIEW',
    })
    expect(payment.total).toBe(1)
    expect(payment.items.map((item) => item.id)).toEqual([ownRows[1]!.id])
    const next = await service.listPage(organizationId, {
      from: '2024-02-29',
      to: '2024-02-29',
      source: 'PAYMENT',
      group: 'NEEDS_REVIEW',
      offset: 1,
    })
    expect(next.total).toBe(1)
    expect(next.items).toEqual([])
  })

  it('tillåter ensidiga datumgränser och source utan ett dolt 90-dagarsvillkor', async () => {
    const before = await service.listPage(organizationId, { to: '2024-02-29', source: 'PAYMENT' })
    expect(before.total).toBe(2)
    expect(before.items.map((item) => item.id)).toEqual([ownRows[1]!.id, ownRows[0]!.id])
    const after = await service.listPage(organizationId, { from: '2024-03-01', source: 'LEASE' })
    expect(after.total).toBe(1)
    expect(after.items.map((item) => item.id)).toEqual([ownRows[3]!.id])
  })

  it('OTHER är komplementet till alla fyra problemstatusar, även READY/BLOCKED/SENDING finns kvar', async () => {
    const own = await service.listPage(organizationId, { group: 'OTHER', limit: 200 })
    expect(own.total).toBe(201)
    expect(own.items).toHaveLength(200)
    expect(own.items.every((item) => item.state === 'CONFIRMED')).toBe(true)
    const foreign = await service.listPage(otherOrganizationId, { group: 'OTHER' })
    expect(foreign.total).toBe(3)
    expect(foreign.items.map((item) => item.state).sort()).toEqual([
      'BLOCKED',
      'DRY_RUN_READY',
      'SENDING',
    ])
  })

  it('isolerar organisationer även när datum/source/status är identiska och ger sann tom sida', async () => {
    const foreign = await service.listPage(otherOrganizationId, {
      from: '2024-02-29',
      to: '2024-02-29',
      source: 'PAYMENT',
      group: 'NEEDS_REVIEW',
    })
    expect(foreign.total).toBe(4)
    expect(foreign.items.map((item) => item.id)).toEqual(
      ordered(foreignRows.slice(0, 4)).map((item) => item.id),
    )
    expect(foreign.items.every((item) => ownRows.every((own) => own.id !== item.id))).toBe(true)
    const empty = await service.listPage(organizationId, { from: '2022-01-01', to: '2022-12-31' })
    expect(empty).toMatchObject({ items: [], total: 0, offset: 0, limit: 50 })
    const unknown = await service.listPage(randomUUID(), {})
    expect(unknown).toMatchObject({ items: [], total: 0, offset: 0, limit: 50 })
  })

  it('lämnar inte ut rådraft/bevis och ändrar inga sparade försök eller historikrader', async () => {
    const page = await service.listPage(organizationId, { group: 'NEEDS_REVIEW' })
    for (const item of page.items) {
      expect(item).not.toHaveProperty('draft')
      expect(item).not.toHaveProperty('attemptHistory')
      expect(item.exportText).toEqual([
        {
          falt: 'Description',
          rad: null,
          originaltext: 'Test — original',
          exporttext: 'Test – original',
        },
      ])
    }
    expect(JSON.stringify(page)).not.toContain(PRIVATE_MARKER)
    expect(JSON.stringify(page)).not.toContain(HISTORY_MARKER)
    expect(await savedExports()).toEqual(originalExports)
    expect(builder.build).not.toHaveBeenCalled()
  })
})
