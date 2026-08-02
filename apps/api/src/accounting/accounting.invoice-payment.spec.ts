/**
 * #290 — createJournalEntryForInvoiceManualPayment nycklar idempotensen på
 * ALLOKERINGEN, inte på fakturan.
 *
 * Systerspecen accounting.rentnotice-payment.spec.ts låser samma sak för
 * avi-vägen (PR 3b). Faktura-vägen fick aldrig den nyckeln: sourceId var
 * "invoice-manual-payment:<invoiceId>", så en ANDRA delbetalning mot samma
 * faktura träffade den förstas verifikat, createNumberedEntry returnerade det
 * befintliga, och pengarna nådde aldrig huvudboken.
 *
 * ── Varför attrappen har en RIKTIG nyckelindex ─────────────────────────────
 *
 * Läxan från #288: en attrapp som svarar likadant oavsett indata kan inte falla
 * på det testet påstår sig bevisa. En `findFirst` som alltid returnerar null gör
 * BÅDE den gamla och den nya nyckelformen gröna — den kan inte skilja "två
 * distinkta nycklar" från "en nyckel som råkade återanvändas".
 *
 * Därför är journalEntry här en liten butik indexerad på (source, sourceId):
 * idempotenskollen slår upp i den, create skriver till den. En äkta dubblett
 * (samma allokering två gånger) träffar då verkligen befintlig post, medan två
 * olika allokeringar skapar två poster — och byter man tillbaka nyckeln till
 * fakturans id faller testet, vilket är hela poängen.
 */

import { AccountingService } from './accounting.service'

type EntryData = {
  date: Date
  source: string
  sourceId?: string
  description?: string
  lines: { create: Array<Record<string, unknown>> }
}

function makeService(opts?: { accounts?: Array<{ id: string; number: number }> }) {
  const accounts = opts?.accounts ?? [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-1910', number: 1910 },
    { id: 'acc-1930', number: 1930 },
    { id: 'acc-1934', number: 1934 },
  ]

  // Butiken: verifikat indexerade på source + sourceId, precis som DB:ns unika
  // index (organizationId, source, sourceId).
  const store = new Map<string, { id: string; data: EntryData }>()
  let seq = 0

  const prisma = {
    journalEntry: {
      findFirst: jest.fn((args: { where?: { source?: string; sourceId?: string } }) => {
        const source = args?.where?.source
        // A2 fail-closed slår upp fakturans accrual (source='INVOICE') — den
        // finns, annars falsk-nekas varje frisk betalning.
        if (source === 'INVOICE') return Promise.resolve({ id: 'accrual-1' })
        return Promise.resolve(store.get(`${source}:${args?.where?.sourceId}`) ?? null)
      }),
      create: jest.fn((arg: { data: EntryData }) => {
        const key = `${arg.data.source}:${arg.data.sourceId}`
        const entry = { id: `je-${++seq}`, data: arg.data }
        store.set(key, entry)
        return Promise.resolve(entry)
      }),
    },
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    invoice: { findFirst: jest.fn().mockResolvedValue({ tenant: null }) },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 7, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return {
    service,
    prisma,
    store,
    entries: () => [...store.values()],
  }
}

const INVOICE = { id: 'inv-1', invoiceNumber: 'F-2026-0001' }
const paidAt = new Date('2026-06-15T00:00:00.000Z')

describe('#290 — createJournalEntryForInvoiceManualPayment: nyckel per allokering', () => {
  it('nycklar sourceId på ALLOKERINGEN, inte på fakturan', async () => {
    const { service, entries } = makeService()

    await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      500,
      paidAt,
      'BANK',
      'org-1',
      'user-1',
      'alloc-1',
    )

    expect(entries()).toHaveLength(1)
    expect(entries()[0]!.data.sourceId).toBe('invoice-manual-payment:alloc-1')
    // Den gamla formen får inte finnas kvar någonstans i nyckeln.
    expect(entries()[0]!.data.sourceId).not.toContain(INVOICE.id)
  })

  it('två delbetalningar mot SAMMA faktura → TVÅ verifikat, hela beloppet i huvudboken', async () => {
    // Exakt reproduktionen från #290: 500 + 9 500 mot en faktura på 10 000.
    const { service, entries } = makeService()

    await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      500,
      paidAt,
      'BANK',
      'org-1',
      'user-1',
      'alloc-A',
    )
    await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      9_500,
      paidAt,
      'BANK',
      'org-1',
      'user-1',
      'alloc-B',
    )

    const alla = entries()
    expect(alla).toHaveLength(2)
    expect(alla.map((e) => e.data.sourceId)).toEqual([
      'invoice-manual-payment:alloc-A',
      'invoice-manual-payment:alloc-B',
    ])

    // Summan i huvudboken = summan av inbetalningarna. Före fixen bokfördes 500.
    const debet = alla
      .flatMap((e) => e.data.lines.create)
      .reduce((s, l) => s + Number(l.debit ?? 0), 0)
    const kredit = alla
      .flatMap((e) => e.data.lines.create)
      .reduce((s, l) => s + Number(l.credit ?? 0), 0)
    expect(debet).toBe(10_000)
    expect(kredit).toBe(10_000)
    // 1510 krediteras hela vägen ned till noll — fordran är stängd.
    const på1510 = alla
      .flatMap((e) => e.data.lines.create)
      .filter((l) => l.accountId === 'acc-1510')
      .reduce((s, l) => s + Number(l.credit ?? 0), 0)
    expect(på1510).toBe(10_000)
  })

  it('SAMMA allokering två gånger (äkta dubblett) → ETT verifikat, idempotensen greppar', async () => {
    const { service, entries } = makeService()

    const första = await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      500,
      paidAt,
      'BANK',
      'org-1',
      'user-1',
      'alloc-1',
    )
    const andra = await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      500,
      paidAt,
      'BANK',
      'org-1',
      'user-1',
      'alloc-1',
    )

    expect(entries()).toHaveLength(1)
    expect((andra as { id: string }).id).toBe((första as { id: string }).id)
  })

  it('konteringen är oförändrad: likvidkonto per betalsätt D / 1510 K, balanserad', async () => {
    const { service, entries } = makeService()

    await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      1_250,
      paidAt,
      // CASH → 1910 (Kassa). SWISH och MANUAL bokförs mot 1930 med flit, se
      // PAYMENT_METHOD_TO_ACCOUNT — kontant är det betalsätt som faktiskt byter konto.
      'CASH',
      'org-1',
      'user-1',
      'alloc-1',
    )

    const lines = entries()[0]!.data.lines.create
    expect(lines.find((l) => l.debit != null)).toMatchObject({
      accountId: 'acc-1910',
      debit: 1_250,
    })
    expect(lines.find((l) => l.credit != null)).toMatchObject({
      accountId: 'acc-1510',
      credit: 1_250,
    })
    expect(entries()[0]!.data.description).toBe('Inbetalning faktura F-2026-0001')
    expect(entries()[0]!.data.date).toBe(paidAt)
  })

  it('belopp <= 0 → null (ingen halv post), oavsett allokerings-id', async () => {
    const { service, entries } = makeService()
    expect(
      await service.createJournalEntryForInvoiceManualPayment(
        INVOICE,
        0,
        paidAt,
        'BANK',
        'org-1',
        null,
        'alloc-1',
      ),
    ).toBeNull()
    expect(entries()).toHaveLength(0)
  })

  it('saknat likvidkonto → null (ingen halv post)', async () => {
    const { service, entries } = makeService({ accounts: [{ id: 'acc-1510', number: 1510 }] })
    expect(
      await service.createJournalEntryForInvoiceManualPayment(
        INVOICE,
        500,
        paidAt,
        'BANK',
        'org-1',
        null,
        'alloc-1',
      ),
    ).toBeNull()
    expect(entries()).toHaveLength(0)
  })
})
