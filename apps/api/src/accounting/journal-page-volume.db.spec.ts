/**
 * Journalväljarens verkliga PostgreSQL-gräns: 2 000 nyare + 55 äldre verifikat.
 * Direktseedade, balanserade testjournaler; inget betalnings-/bokföringsflöde eller
 * kapacitetslöfte. Alla sidläsningar går genom oförändrad AccountingService.
 * Egen UUID-fixtur, inga lånade uppgifter, externa anrop eller överhoppade prov.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { createHash, randomUUID } from 'node:crypto'
import { ActorKind, JournalEntrySource, PrismaClient } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Journalvolymprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error('Journalvolymprovet tillåter bara lokal *_test eller CI:s lokala eken_dev')
  }
  if (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public') {
    throw new Error('Journalvolymprovet tillåter bara public-schema')
  }
  url.searchParams.set('connection_limit', '2')
  return url.toString()
}

interface SeedRow {
  id: string
  date: string
  createdAt: Date
  source: JournalEntrySource
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

describe('Journalvolymprovets förutsättningar', () => {
  it('kräver riktig, uttryckligen isolerad PostgreSQL även när ingen databas angetts', () => {
    expect(isolatedDatabaseUrl()).toBeTruthy()
  })
})

describe('Journalväljarens historik över 2 000 verifikat', () => {
  let prisma: PrismaClient | undefined
  let service: AccountingService
  let organizationId: string
  let otherOrganizationId: string
  let originalDigest: string
  const runId = randomUUID()
  const organizations: string[] = []
  const oldCreatedAt = new Date('2023-12-31T12:00:00Z')
  const ownRows: SeedRow[] = [
    ...Array.from({ length: 55 }, (_, index) => ({
      id: `${runId.slice(0, 24)}${index.toString(16).padStart(12, '0')}`,
      date: '2023-12-31',
      createdAt: oldCreatedAt,
      source: index % 2 === 0 ? JournalEntrySource.PAYMENT : JournalEntrySource.INVOICE,
    })),
    ...Array.from({ length: 2000 }, (_, index) => ({
      id: `${runId.slice(0, 24)}${(index + 55).toString(16).padStart(12, '0')}`,
      date: new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 100))).toISOString().slice(0, 10),
      createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index % 2)),
      source: index % 2 === 0 ? JournalEntrySource.PAYMENT : JournalEntrySource.INVOICE,
    })),
  ]
  const foreignRows: SeedRow[] = [
    { id: randomUUID(), date: '2023-12-31', createdAt: oldCreatedAt, source: 'PAYMENT' },
    {
      id: randomUUID(),
      date: '2026-01-20',
      createdAt: new Date('2026-02-01T00:00:01Z'),
      source: 'INVOICE',
    },
  ]

  function db(): PrismaClient {
    if (!prisma) throw new Error('Journalvolymprovets PostgreSQL-klient har inte startats')
    return prisma
  }

  function organizationName(id: string): string {
    return `synthetic-journal-volume-${runId}-${id}`
  }

  async function seedOrganization(rows: SeedRow[]): Promise<string> {
    const id = randomUUID()
    await db().organization.create({
      data: {
        id,
        name: organizationName(id),
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
        {
          id: debitAccountId,
          organizationId: id,
          number: 1930,
          name: 'Test bank',
          type: 'ASSET',
          actorKind: ActorKind.HUMAN,
        },
        {
          id: creditAccountId,
          organizationId: id,
          number: 1510,
          name: 'Test fordran',
          type: 'ASSET',
          actorKind: ActorKind.HUMAN,
        },
      ],
    })
    const numbers = new Map<number, number>()
    // Infogning i stigande ID-ordning. Likheter ska ändå returneras i fallande
    // ID-ordning, även över 50/5-gränsen mellan de två äldsta sidorna.
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500)
      await db().$transaction(async (tx) => {
        await tx.journalEntry.createMany({
          data: batch.map((item): Prisma.JournalEntryCreateManyInput => {
            const year = Number(item.date.slice(0, 4))
            const verNumber = (numbers.get(year) ?? 0) + 1
            numbers.set(year, verNumber)
            return {
              id: item.id,
              organizationId: id,
              date: new Date(`${item.date}T00:00:00Z`),
              createdAt: item.createdAt,
              description: `Syntetiskt journalval ${item.id}`,
              source: item.source,
              sourceId: `synthetic-journal-volume:${item.id}`,
              fiscalYear: year,
              series: 'A',
              verNumber,
            }
          }),
        })
        await tx.journalEntryLine.createMany({
          data: batch.flatMap((item) => [
            { journalEntryId: item.id, accountId: debitAccountId, debit: '100.00' },
            { journalEntryId: item.id, accountId: creditAccountId, credit: '100.00' },
          ]),
        })
      }, PRISMA_DEFAULT_TX_LIMITS)
    }
    await db().journalEntrySequence.createMany({
      data: [...numbers].map(([fiscalYear, lastNumber]) => ({
        organizationId: id,
        fiscalYear,
        series: 'A',
        lastNumber,
      })),
    })
    return id
  }

  async function savedDigest(): Promise<string> {
    const [journals, accounts, sequences, orgs] = await Promise.all([
      db().journalEntry.findMany({
        where: { organizationId: { in: organizations } },
        include: { lines: { orderBy: { id: 'asc' } } },
        orderBy: { id: 'asc' },
      }),
      db().account.findMany({
        where: { organizationId: { in: organizations } },
        orderBy: { id: 'asc' },
      }),
      db().journalEntrySequence.findMany({
        where: { organizationId: { in: organizations } },
        orderBy: [{ organizationId: 'asc' }, { fiscalYear: 'asc' }, { series: 'asc' }],
      }),
      db().organization.findMany({ where: { id: { in: organizations } }, orderBy: { id: 'asc' } }),
    ])
    expect(journals).toHaveLength(2057)
    for (const journal of journals) {
      expect(journal.lines).toHaveLength(2)
      expect(journal.lines.reduce((sum, line) => sum + Number(line.debit ?? 0), 0)).toBe(100)
      expect(journal.lines.reduce((sum, line) => sum + Number(line.credit ?? 0), 0)).toBe(100)
    }
    return createHash('sha256')
      .update(JSON.stringify({ journals, accounts, sequences, orgs }))
      .digest('hex')
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: isolatedDatabaseUrl() } } })
    await prisma.$connect()
    const servicePrisma = prisma as unknown as PrismaService
    service = new AccountingService(servicePrisma, new VerifikationsnummerService(servicePrisma))
    organizationId = await seedOrganization(ownRows)
    otherOrganizationId = await seedOrganization(foreignRows)
    originalDigest = await savedDigest()
  }, 60_000)

  afterAll(async () => {
    if (!prisma) return
    const failures: unknown[] = []
    for (const id of organizations) {
      try {
        // Kontrollera ägarmarkören innan någon städskrivning; rör aldrig annan data.
        const org = await db().organization.findUnique({
          where: { id },
          select: { name: true, email: true },
        })
        expect(org).toEqual({ name: organizationName(id), email: `${id}@example.invalid` })
        await db().journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
        await db().journalEntry.deleteMany({ where: { organizationId: id } })
        await db().journalEntrySequence.deleteMany({ where: { organizationId: id } })
        await db().account.deleteMany({ where: { organizationId: id } })
        await db().organization.delete({ where: { id } })
      } catch (error) {
        failures.push(error)
      }
    }
    await prisma.$disconnect()
    if (failures.length)
      throw new AggregateError(failures, 'Kunde inte städa journalvolymprovets egna fixturer')
  }, 30_000)

  it('når 50 första, 50 efter offset 2 000 och de sista 5 med exakt total och stabil ID-ordning', async () => {
    const expected = ordered(ownRows)
    const seen: string[] = []
    for (const [offset, length] of [
      [0, 50],
      [2000, 50],
      [2050, 5],
    ] as const) {
      const page = await service.getJournalEntriesPage(organizationId, undefined, {
        offset,
        limit: 50,
      })
      expect(page).toMatchObject({ total: 2055, offset, limit: 50 })
      expect(page.entries).toHaveLength(length)
      expect(page.entries.map((entry) => entry.id)).toEqual(
        expected.slice(offset, offset + 50).map((entry) => entry.id),
      )
      expect(page.entries.every((entry) => entry.organizationId === organizationId)).toBe(true)
      expect(
        page.entries.every((entry) => entry.date.getUTCFullYear() === (offset === 0 ? 2026 : 2023)),
      ).toBe(true)
      seen.push(...page.entries.map((entry) => entry.id))
    }
    expect(new Set(seen).size).toBe(105)
    expect(
      await service.getJournalEntriesPage(organizationId, undefined, { offset: 2055, limit: 50 }),
    ).toEqual({
      entries: [],
      total: 2055,
      offset: 2055,
      limit: 50,
    })
  })

  it('filtrerar datum och source före total/sidgräns och når gamla betalningar utan dolt årsurval', async () => {
    const oldPayments = ordered(
      ownRows.filter((row) => row.date === '2023-12-31' && row.source === 'PAYMENT'),
    )
    expect(oldPayments).toHaveLength(28)
    const old = await service.getJournalEntriesPage(
      organizationId,
      {
        from: '2023-12-31',
        to: '2023-12-31',
        source: 'PAYMENT',
      },
      { offset: 20, limit: 10 },
    )
    expect(old).toMatchObject({ total: 28, offset: 20, limit: 10 })
    expect(old.entries.map((entry) => entry.id)).toEqual(
      oldPayments.slice(20).map((entry) => entry.id),
    )

    const allPayments = await service.getJournalEntriesPage(
      organizationId,
      { source: 'PAYMENT' },
      { offset: 1000, limit: 50 },
    )
    expect(allPayments).toMatchObject({ total: 1028, offset: 1000, limit: 50 })
    expect(allPayments.entries.map((entry) => entry.id)).toEqual(
      oldPayments.map((entry) => entry.id),
    )

    const newPayments = ordered(
      ownRows.filter(
        (row) => row.date >= '2026-01-01' && row.date <= '2026-01-02' && row.source === 'PAYMENT',
      ),
    )
    expect(newPayments).toHaveLength(100)
    const bounded = await service.getJournalEntriesPage(
      organizationId,
      {
        from: '2026-01-01',
        to: '2026-01-02',
        source: 'PAYMENT',
      },
      { offset: 90, limit: 50 },
    )
    expect(bounded).toMatchObject({ total: 100, offset: 90, limit: 50 })
    expect(bounded.entries.map((entry) => entry.id)).toEqual(
      newPayments.slice(90).map((entry) => entry.id),
    )
  })

  it('isolerar annan organisation trots identiska datum/source och ger tomt för okänd organisation', async () => {
    const foreign = await service.getJournalEntriesPage(otherOrganizationId, undefined, {
      offset: 0,
      limit: 50,
    })
    expect(foreign).toMatchObject({ total: 2, offset: 0, limit: 50 })
    expect(foreign.entries.map((entry) => entry.id)).toEqual(
      ordered(foreignRows).map((row) => row.id),
    )
    expect(foreign.entries.every((entry) => entry.organizationId === otherOrganizationId)).toBe(
      true,
    )
    const old = await service.getJournalEntriesPage(
      otherOrganizationId,
      {
        from: '2023-12-31',
        to: '2023-12-31',
        source: 'PAYMENT',
      },
      { offset: 0, limit: 50 },
    )
    expect(old.total).toBe(1)
    expect(old.entries.map((entry) => entry.id)).toEqual([foreignRows[0]!.id])
    expect(
      await service.getJournalEntriesPage(randomUUID(), undefined, { offset: 0, limit: 50 }),
    ).toEqual({
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
    })
  })

  it('lämnar båda organisationernas balanserade journaler, konton och nummersekvenser oförändrade', async () => {
    expect(await savedDigest()).toBe(originalDigest)
  })
})
