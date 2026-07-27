/**
 * C1 — DEN GLOBALA BALANSGRINDEN i createNumberedEntry.
 *
 * Ett verifikat måste balansera: summa debet = summa kredit (BFL 5 kap). Fram
 * till denna grind fanns INGEN sådan kontroll någonstans i skrivvägen — alla 15
 * verifikatvägar förlitade sig på att var och en var individuellt korrekt.
 * C2 visade att det inte höll (momsen gick isär med ett öre och skrevs in).
 *
 * Grinden ligger i den DELADE skrivaren, som varenda verifikat passerar. Testet
 * verifierar den genom en riktig verifikatväg (bookBadDebtWriteOff m.fl.) OCH
 * genom att mata skevа rader direkt, så att både grinden och dess placering
 * bevakas.
 *
 * Två egenskaper utöver själva balansen:
 *   • grinden körs FÖRE verifikationsnumret allokeras — ett obalanserat
 *     verifikat får aldrig bränna ett nummer (numret ska vara gap-fritt)
 *   • nolltolerans: ett öre är ett fel, inte brus
 */

import { AccountingService } from './accounting.service'

function makeService(accounts: Array<{ id: string; number: number }>) {
  let created: { data: { lines: { create: Array<Record<string, unknown>> } } } | null = null
  const prisma = {
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((arg: typeof created) => {
        created = arg
        return Promise.resolve({ id: 'je-1', ...arg })
      }),
    },
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    lease: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const allocate = jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 })
  const service = new AccountingService(prisma as never, { allocate } as never)
  return { service, allocate, getCreated: () => created }
}

/** Når den privata skrivaren — grinden ska gälla oavsett vilken väg som anropar. */
const write = (service: AccountingService, lines: unknown[], extra: Record<string, unknown> = {}) =>
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
    lines,
    idempotencyWhere: { organizationId: 'org-1', sourceId: 'src-1' },
    ...extra,
  })

const ACCOUNTS = [
  { id: 'acc-1510', number: 1510 },
  { id: 'acc-1930', number: 1930 },
  { id: 'acc-2611', number: 2611 },
  { id: 'acc-3911', number: 3911 },
]

describe('C1 — obalanserat verifikat avvisas', () => {
  it('debet ≠ kredit kastar och skriver ingenting', async () => {
    const { service, getCreated } = makeService(ACCOUNTS)

    await expect(
      write(service, [
        { accountId: 'acc-1510', debit: 125.0 },
        { accountId: 'acc-3911', credit: 100.0 },
      ]),
    ).rejects.toThrow(/balanserar inte/)

    expect(getCreated()).toBeNull()
  })

  it('ETT ÖRE fel räcker — ingen tolerans', async () => {
    const { service } = makeService(ACCOUNTS)

    // Exakt C2-buggens storleksordning.
    await expect(
      write(service, [
        { accountId: 'acc-1510', debit: 124.98 },
        { accountId: 'acc-3911', credit: 99.99 },
        { accountId: 'acc-2611', credit: 25.0 },
      ]),
    ).rejects.toThrow(/debet 124\.98 ≠ kredit 124\.99/)
  })

  it('brinner INTE ett verifikationsnummer när balansen fallerar', async () => {
    const { service, allocate } = makeService(ACCOUNTS)

    await expect(
      write(service, [
        { accountId: 'acc-1510', debit: 100 },
        { accountId: 'acc-3911', credit: 90 },
      ]),
    ).rejects.toThrow()

    // Grinden måste ligga före allokeringen — annars uppstår ett gap i serien.
    expect(allocate).not.toHaveBeenCalled()
  })
})

describe('C1 — balanserade verifikat passerar oförändrat', () => {
  it('tvåradigt verifikat skrivs som förut', async () => {
    const { service, getCreated, allocate } = makeService(ACCOUNTS)

    await write(service, [
      { accountId: 'acc-1930', debit: 12_500 },
      { accountId: 'acc-1510', credit: 12_500 },
    ])

    expect(allocate).toHaveBeenCalledTimes(1)
    expect(getCreated()!.data.lines.create).toHaveLength(2)
  })

  it('flerradigt med moms (debet = netto + moms) passerar', async () => {
    const { service, getCreated } = makeService(ACCOUNTS)

    await write(service, [
      { accountId: 'acc-1510', debit: 125.0 },
      { accountId: 'acc-3911', credit: 100.0 },
      { accountId: 'acc-2611', credit: 25.0 },
    ])

    expect(getCreated()!.data.lines.create).toHaveLength(3)
  })

  it('öresbelopp som summerar exakt passerar (ingen float-drift i grinden)', async () => {
    const { service, getCreated } = makeService(ACCOUNTS)

    // 0.1 + 0.2 !== 0.3 i float; i Decimal gör det det.
    await write(service, [
      { accountId: 'acc-1510', debit: 0.3 },
      { accountId: 'acc-3911', credit: 0.1 },
      { accountId: 'acc-2611', credit: 0.2 },
    ])

    expect(getCreated()).not.toBeNull()
  })
})

describe('C1 — malformade rader avvisas', () => {
  it('rad med BÅDE debet och kredit kastar', async () => {
    const { service } = makeService(ACCOUNTS)
    await expect(
      write(service, [
        { accountId: 'acc-1510', debit: 100, credit: 100 },
        { accountId: 'acc-3911', credit: 100 },
      ]),
    ).rejects.toThrow(/inte båda/)
  })

  it('rad UTAN både debet och kredit kastar', async () => {
    const { service } = makeService(ACCOUNTS)
    await expect(
      write(service, [
        { accountId: 'acc-1510', debit: 100 },
        { accountId: 'acc-3911', credit: 100 },
        { accountId: 'acc-2611' },
      ]),
    ).rejects.toThrow(/inte ingetdera/)
  })

  it('verifikat helt utan rader kastar', async () => {
    const { service } = makeService(ACCOUNTS)
    await expect(write(service, [])).rejects.toThrow(/utan konteringsrader/)
  })
})

describe('C1 — grinden gäller en RIKTIG verifikatväg, inte bara den privata skrivaren', () => {
  it('bookBadDebtWriteOff (balanserad) går igenom', async () => {
    const { service, getCreated } = makeService([
      { id: 'acc-1515', number: 1515 },
      { id: 'acc-6352', number: 6352 },
    ])

    await service.bookBadDebtWriteOff({
      organizationId: 'org-1',
      amount: 4_500,
      date: new Date('2026-05-29'),
      sourceId: 'notice-1',
      description: 'Konstaterad kundförlust',
    } as never)

    const lines = getCreated()!.data.lines.create
    const ore = (v: unknown) => Math.round(Number(v ?? 0) * 100)
    expect(lines.reduce((s, l) => s + ore(l['debit']), 0)).toBe(
      lines.reduce((s, l) => s + ore(l['credit']), 0),
    )
  })
})
