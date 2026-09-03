/**
 * C0 — IDEMPOTENSNYCKELN i createNumberedEntry måste finnas och vara org-scopad.
 *
 * `idempotencyWhere` är redan obligatorisk i TYPEN. Den här specen bevakar
 * runtime-spärren, som finns för det typen inte kan se: ett värde som råkar bli
 * `undefined` (ett spec som går via `as any` förbi den privata metodens
 * synlighet, ett params-objekt byggt med spridning, en `JSON.parse`).
 *
 * VARFÖR EN EGEN SPÄRR OCH INTE BARA "hittar fel rad". Uppslaget är
 * `findFirst({ where: { ...idempotencyWhere, source } })`. `{ ...undefined }`
 * är laglig JS och ger `{}`, så utan nyckeln återstår bara `source` — ingen
 * `organizationId`. Frågan returnerar då första verifikatet med den källan i
 * HELA tabellen, tvärs över organisationsgränsen, och anroparen får en annan
 * organisations verifikat som om det vore en lyckad idempotent träff.
 *
 * Fyndet kom ur en mätrigg som underskapade tyst: tre anrop gav ETT verifikat,
 * och talen såg balanserade ut ändå.
 *
 * DET BÄRANDE PROVET är inte att spärren kastar — det är att `findFirst` ALDRIG
 * ANROPAS. Kastar den efter uppslaget har den oscopade läsningen redan skett.
 */

import { AccountingService } from './accounting.service'

function makeService() {
  const prisma = {
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((arg: unknown) => Promise.resolve({ id: 'je-1', ...(arg as object) })),
    },
    account: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3911', number: 3911 },
      ]),
    },
    lease: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const allocate = jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 })
  const service = new AccountingService(prisma as never, { allocate } as never)
  return { service, prisma, allocate }
}

const BALANSERADE_RADER = [
  { accountId: 'acc-1510', debit: 100.0 },
  { accountId: 'acc-3911', credit: 100.0 },
]

/**
 * Når den privata skrivaren. Just den här vägen — `as unknown as` — är den som
 * kringgår typen, alltså exakt det spärren finns för.
 */
const write = (service: AccountingService, idempotencyWhere: unknown) =>
  (
    service as unknown as {
      createNumberedEntry: (p: Record<string, unknown>) => Promise<unknown>
    }
  ).createNumberedEntry({
    organizationId: 'org-1',
    date: new Date('2026-05-29'),
    description: 'Testverifikat',
    source: 'MANUAL',
    sourceId: 'src-1',
    createdById: 'user-1',
    lines: BALANSERADE_RADER,
    idempotencyWhere,
  })

describe('C0 — idempotensnyckeln saknas helt', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('%s avvisas, och det oscopade uppslaget sker ALDRIG', async (_namn, nyckel) => {
    const { service, prisma, allocate } = makeService()

    await expect(write(service, nyckel)).rejects.toThrow(/utan idempotencyWhere/)

    // Det bärande: läsningen är inte gjord, numret inte bränt, inget skrivet.
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled()
    expect(allocate).not.toHaveBeenCalled()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })
})

describe('C0 — nyckeln finns men är inte org-scopad', () => {
  it.each([
    ['tomt objekt', {}],
    ['bara sourceId', { sourceId: 'src-1' }],
    ['organizationId undefined', { organizationId: undefined, sourceId: 'src-1' }],
  ])('%s avvisas innan uppslaget', async (_namn, nyckel) => {
    const { service, prisma, allocate } = makeService()

    await expect(write(service, nyckel)).rejects.toThrow(/saknar organizationId/)

    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled()
    expect(allocate).not.toHaveBeenCalled()
  })
})

describe('C0 — kanariefågeln: spärren får inte fälla en LEGITIM väg', () => {
  it('org-scopad nyckel går igenom och skriver verifikatet', async () => {
    const { service, prisma, allocate } = makeService()

    await expect(
      write(service, { organizationId: 'org-1', source: 'MANUAL', sourceId: 'src-1' }),
    ).resolves.toBeDefined()

    expect(prisma.journalEntry.findFirst).toHaveBeenCalledTimes(1)
    expect(allocate).toHaveBeenCalledTimes(1)
    expect(prisma.journalEntry.create).toHaveBeenCalledTimes(1)
  })

  it('uppslaget bär organizationId — det är den som spärren skyddar', async () => {
    const { service, prisma } = makeService()

    await write(service, { organizationId: 'org-1', source: 'MANUAL', sourceId: 'src-1' })

    const where = prisma.journalEntry.findFirst.mock.calls[0]![0].where
    expect(where).toMatchObject({ organizationId: 'org-1', source: 'MANUAL', sourceId: 'src-1' })
  })
})

describe('C0 — mekaniken som gör hålet farligt, belagd', () => {
  it('spridning av undefined ger ett where UTAN organizationId', () => {
    const idempotencyWhere = undefined
    expect({ ...idempotencyWhere, source: 'MANUAL' }).toEqual({ source: 'MANUAL' })
  })
})
