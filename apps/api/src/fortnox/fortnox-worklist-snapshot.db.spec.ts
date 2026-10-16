/**
 * Verklig PostgreSQL och oförändrade queryresultat. Läsningen pausas först EFTER
 * en genomförd SELECT; en separat klient committar sedan en samtidig ändring.
 * Provar sammanhängande sida/total/detaljer inom ett anrop, inte fryst historik
 * mellan olika sidbyten. Inga provideranrop, sömner eller krav på antal SQL-frågor.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import type { FortnoxExportsPageQuery } from '@eken/shared'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Snapshotprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error('Snapshotprovet tillåter bara lokal *_test eller CI:s lokala eken_dev')
  }
  url.searchParams.set('connection_limit', '2')
  return url.toString()
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Endast en felgräns för trasiga barriärer, aldrig tidssynkronisering. */
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Snapshotbarriären fastnade: ${label}`)), 5000)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

interface OrganizationFixture {
  id: string
  debitAccountId: string
  creditAccountId: string
}

const QUERY: FortnoxExportsPageQuery = {
  group: 'NEEDS_REVIEW',
  source: 'PAYMENT',
  from: '2024-02-01',
  to: '2024-03-31',
  offset: 0,
  limit: 50,
}

describe('Fortnox-arbetslistans sammanhängande läsbild', () => {
  let reader: PrismaClient | undefined
  let writer: PrismaClient | undefined
  let service: FortnoxExportService
  const organizations = new Set<string>()
  const builder: FortnoxVoucherDraftBuilder = {
    build: jest.fn(async () => {
      throw new Error('Snapshotläsningen får inte bygga om eller sända ett verifikat')
    }),
  }

  function readDb(): PrismaClient {
    if (!reader) throw new Error('Läsklienten har inte startats')
    return reader
  }

  function writeDb(): PrismaClient {
    if (!writer) throw new Error('Skrivklienten har inte startats')
    return writer
  }

  async function organization(): Promise<OrganizationFixture> {
    const id = randomUUID()
    await writeDb().organization.create({
      data: {
        id,
        name: `synthetic-snapshot-${id}`,
        email: `${id}@example.invalid`,
        street: 'Syntetisk testgata 1',
        postalCode: '11111',
        city: 'Teststad',
      },
    })
    organizations.add(id)
    const debitAccountId = randomUUID()
    const creditAccountId = randomUUID()
    await writeDb().account.createMany({
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
    return { id, debitAccountId, creditAccountId }
  }

  async function entry(
    org: OrganizationFixture,
    verNumber: number,
    date: string,
    exportOrganizationId = org.id,
  ) {
    const journalEntryId = randomUUID()
    await writeDb().journalEntry.create({
      data: {
        id: journalEntryId,
        organizationId: org.id,
        date: new Date(`${date}T00:00:00Z`),
        description: 'Syntetiskt snapshotunderlag',
        source: 'PAYMENT',
        sourceId: `synthetic-snapshot:${journalEntryId}`,
        fiscalYear: 2024,
        series: 'A',
        verNumber,
        lines: {
          create: [
            { accountId: org.debitAccountId, debit: '100.00' },
            { accountId: org.creditAccountId, credit: '100.00' },
          ],
        },
      },
    })
    return writeDb().fortnoxVoucherExport.create({
      data: {
        organizationId: exportOrganizationId,
        journalEntryId,
        state: 'UNKNOWN',
        draftHash: 'a'.repeat(64),
        blockReason: `Syntetiskt ursprung ${verNumber}`,
        draft: {
          privateSentinel: 'SYNTHETIC_SNAPSHOT_PRIVATE',
          provenance: {
            text: {
              falt: [
                { falt: 'Description', rad: null, ra: 'Före — ändring', export: 'Före – ändring' },
              ],
            },
          },
        },
        attemptHistory: [{ typ: 'SYNTHETIC_SNAPSHOT_EVIDENCE' }],
        createdAt: new Date('2024-04-01T00:00:00Z'),
      },
    })
  }

  async function cleanupFixtures() {
    if (!writer || organizations.size === 0) return
    const ids = [...organizations]
    // Alla egna exportrader först: scopeprovet har avsiktligt korsade FK-ägare.
    await writer.fortnoxVoucherExport.deleteMany({ where: { organizationId: { in: ids } } })
    await writer.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: { in: ids } } },
    })
    await writer.journalEntry.deleteMany({ where: { organizationId: { in: ids } } })
    await writer.account.deleteMany({ where: { organizationId: { in: ids } } })
    await writer.organization.deleteMany({ where: { id: { in: ids } } })
    organizations.clear()
  }

  /**
   * Håller den första riktiga findMany- eller $queryRaw-läsningen efter SQL,
   * oavsett bred/smal projektion. Samma barriär täcker även ett CTE-urval.
   * count väntar FÖRE SQL tills skrivningen committat. Därmed kan den inte råka
   * hinna före ändringen och göra en osammanhängande läsning falskt grön.
   */
  async function changeAfterSelection(
    organizationId: string,
    input: FortnoxExportsPageQuery,
    change: () => Promise<unknown>,
  ) {
    const selected = barrier()
    const release = barrier()
    let held = false
    async function holdFirst<T>(result: T): Promise<T> {
      if (!held) {
        held = true
        selected.resolve()
        await release.promise
      }
      return result
    }
    const observed = readDb().$extends({
      query: {
        async $queryRaw({ args, query }) {
          return holdFirst(await query(args))
        },
        fortnoxVoucherExport: {
          async findMany({ args, query }) {
            return holdFirst(await query(args))
          },
          async count({ args, query }) {
            await release.promise
            return query(args)
          },
        },
      },
    })
    const racing = new FortnoxExportService(observed as unknown as PrismaService, builder)
    const reading = racing.listPage(organizationId, input)
    // Fånga även tidigt DB-fel, så en utebliven barriär inte gömmer det bakom timeout.
    const reached = Promise.race([
      selected.promise,
      reading.then(() => {
        throw new Error('Listläsningen avslutades utan den verkliga läsbarriären')
      }),
    ])
    let writing: Promise<unknown> | undefined
    try {
      await bounded(reached, 'första läsningen')
      writing = change()
      await bounded(writing, 'separat committad ändring')
      release.resolve()
      return await bounded(reading, 'läsning efter släppt barriär')
    } finally {
      release.resolve()
      await Promise.allSettled(writing ? [reading, writing] : [reading])
    }
  }

  beforeAll(async () => {
    const url = isolatedDatabaseUrl()
    reader = new PrismaClient({ datasources: { db: { url } } })
    writer = new PrismaClient({ datasources: { db: { url } } })
    await Promise.all([reader.$connect(), writer.$connect()])
    service = new FortnoxExportService(reader as unknown as PrismaService, builder)
  })

  afterEach(async () => {
    await cleanupFixtures()
    expect(builder.build).not.toHaveBeenCalled()
  })

  afterAll(async () => {
    try {
      await cleanupFixtures()
    } finally {
      await Promise.allSettled([reader?.$disconnect(), writer?.$disconnect()])
    }
  })

  it('statusbyte efter urval ger samma gamla status, detaljer och total inom svaret', async () => {
    const org = await organization()
    const older = await entry(org, 1, '2024-02-28')
    const newer = await entry(org, 2, '2024-02-29')
    const before = await service.listPage(org.id, QUERY)
    expect(before.total).toBe(2)
    expect(before.items.map((item) => item.id)).toEqual([newer.id, older.id])
    const during = await changeAfterSelection(org.id, QUERY, () =>
      writeDb().fortnoxVoucherExport.update({
        where: { id: newer.id, organizationId: org.id },
        data: { state: 'CONFIRMED', blockReason: 'Syntetiskt ändrad efter första läsningen' },
      }),
    )
    const after = await service.listPage(org.id, QUERY)
    expect(after.total).toBe(1)
    expect(after.items.map((item) => item.id)).toEqual([older.id])
    expect(during).toEqual(before)
  })

  it('en nyare rad flyttar inte redan valt sidinnehåll eller dess total mitt i anropet', async () => {
    const org = await organization()
    const older = await entry(org, 1, '2024-02-28')
    const newer = await entry(org, 2, '2024-02-29')
    const input = { ...QUERY, offset: 1, limit: 1 }
    const before = await service.listPage(org.id, input)
    expect(before.total).toBe(2)
    expect(before.items.map((item) => item.id)).toEqual([older.id])
    const during = await changeAfterSelection(org.id, input, () => entry(org, 3, '2024-03-01'))
    const after = await service.listPage(org.id, input)
    expect(after.total).toBe(3)
    expect(after.items.map((item) => item.id)).toEqual([newer.id])
    expect(during).toEqual(before)
  })

  it('radering av en vald syntetisk export tappar inte detaljer eller ändrar total mitt i svaret', async () => {
    const org = await organization()
    const older = await entry(org, 1, '2024-02-28')
    const newer = await entry(org, 2, '2024-02-29')
    const before = await service.listPage(org.id, QUERY)
    expect(before.total).toBe(2)
    expect(before.items.map((item) => item.id)).toEqual([newer.id, older.id])
    const during = await changeAfterSelection(org.id, QUERY, () =>
      writeDb().fortnoxVoucherExport.delete({ where: { id: newer.id, organizationId: org.id } }),
    )
    const after = await service.listPage(org.id, QUERY)
    expect(after.total).toBe(1)
    expect(after.items.map((item) => item.id)).toEqual([older.id])
    expect(during).toEqual(before)
  })

  it('kräver samma företag på både export och journal, även när båda FK-raderna finns', async () => {
    const own = await organization()
    const foreign = await organization()
    const ownRow = await entry(own, 1, '2024-02-29')
    const foreignRow = await entry(foreign, 1, '2024-02-29')
    // Giltiga separata FK:er men fel domänägare. Nyare datum skulle annars ta första platsen.
    const crossed = await entry(foreign, 2, '2024-03-01', own.id)
    expect(await writeDb().fortnoxVoucherExport.count({ where: { id: crossed.id } })).toBe(1)
    const ownPage = await service.listPage(own.id, { ...QUERY, limit: 1 })
    const foreignPage = await service.listPage(foreign.id, { ...QUERY, limit: 1 })
    expect(ownPage.total).toBe(1)
    expect(ownPage.items.map((item) => item.id)).toEqual([ownRow.id])
    expect(foreignPage.total).toBe(1)
    expect(foreignPage.items.map((item) => item.id)).toEqual([foreignRow.id])
    expect(JSON.stringify([ownPage, foreignPage])).not.toContain(crossed.id)
    expect(JSON.stringify([ownPage, foreignPage])).not.toContain('SYNTHETIC_SNAPSHOT_PRIVATE')
  })
})
