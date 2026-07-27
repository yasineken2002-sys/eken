/**
 * C2 — FAKTURAVERIFIKATET MÅSTE BALANSERA (debet = kredit), exakt.
 *
 * Buggen: createJournalEntryForInvoice räknade om momsen från grunden och
 * OAVRUNDAT — `q * unitPrice * (rate/100)` — medan fakturan härledde den som
 * brutto − netto per rad, båda öresavrundade. Två olika formler på samma
 * underlag. Debet togs från det lagrade `invoice.total`, krediten byggdes av
 * den omräknade momsen, och på flerradsfakturor gick de isär:
 *
 *   3 rader à 33,33 kr @ 25 %:  debet 124,98  kredit 124,99  → 1 öre
 *   7 rader à 14,29 kr @ 25 %:  debet 125,02  kredit 125,04  → 2 öre
 *
 * Enradsfakturor balanserade, vilket är varför det aldrig upptäcktes.
 *
 * Ingenting fångade det: createNumberedEntry kontrollerar inte balans (den
 * globala grinden är C1, ett eget ärende) och Decimal(10,2) avrundade tyst vid
 * skrivning så raderna såg rimliga ut i databasen.
 *
 * Testet bevakar arithmetiken, inte formen: varje fall summerar de FAKTISKA
 * verifikatraderna och kräver att debet = kredit till öret.
 */

import { AccountingService } from './accounting.service'

type Line = { quantity: number; unitPrice: number; vatRate: number; total: number }

/** Öresavrundning — samma metod som faktureringen (invoices.service.ts). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Bygger fakturans lagrade totaler EXAKT som computeInvoiceAmounts gör, så
 * testdatan speglar vad som faktiskt ligger i databasen.
 */
function invoiceFrom(rawLines: Array<{ quantity: number; unitPrice: number; vatRate: number }>) {
  let subtotal = 0
  let vatTotal = 0
  const lines: Line[] = rawLines.map((l) => {
    const net = round2(l.quantity * l.unitPrice)
    const gross = round2(l.quantity * l.unitPrice * (1 + l.vatRate / 100))
    subtotal = round2(subtotal + net)
    vatTotal = round2(vatTotal + round2(gross - net))
    return { ...l, total: gross }
  })
  return {
    id: 'inv-1',
    invoiceNumber: 'F-2026-0001',
    leaseId: null,
    issueDate: new Date('2026-05-29'),
    subtotal,
    vatTotal,
    total: round2(subtotal + vatTotal),
    lines,
  }
}

function makeService(opts: { accounts?: Array<{ id: string; number: number }> } = {}) {
  const accounts = opts.accounts ?? [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-3914', number: 3914 },
    { id: 'acc-2611', number: 2611 }, // moms 25 %
    { id: 'acc-2621', number: 2621 }, // moms 12 %
    { id: 'acc-2631', number: 2631 }, // moms 6 %
  ]
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
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, getCreated: () => created }
}

/** Summerar de faktiska verifikatraderna i ören (heltal — ingen float-drift). */
function sums(lines: Array<Record<string, unknown>>) {
  const ore = (v: unknown) => Math.round(Number(v ?? 0) * 100)
  return {
    debitOre: lines.reduce((s, l) => s + ore(l['debit']), 0),
    creditOre: lines.reduce((s, l) => s + ore(l['credit']), 0),
  }
}

const vatLines = (lines: Array<Record<string, unknown>>) =>
  lines.filter((l) => String(l['description'] ?? '').startsWith('Moms'))

describe('C2 — fakturaverifikatet balanserar', () => {
  // Exakt de fall som gick isär före fixen.
  const obalansfall: Array<
    [string, Array<{ quantity: number; unitPrice: number; vatRate: number }>]
  > = [
    ['3 rader à 33,33 kr @ 25 %', Array(3).fill({ quantity: 1, unitPrice: 33.33, vatRate: 25 })],
    ['7 rader à 14,29 kr @ 25 %', Array(7).fill({ quantity: 1, unitPrice: 14.29, vatRate: 25 })],
    ['5 rader à 0,07 kr @ 25 %', Array(5).fill({ quantity: 1, unitPrice: 0.07, vatRate: 25 })],
  ]

  it.each(obalansfall)('%s → debet = kredit', async (_namn, raw) => {
    const { service, getCreated } = makeService()
    await service.createJournalEntryForInvoice(invoiceFrom(raw) as never, 'org-1', 'user-1')

    const lines = getCreated()!.data.lines.create
    const { debitOre, creditOre } = sums(lines)
    expect(creditOre).toBe(debitOre)
  })

  it('enradsfaktura är oförändrad (ingen regression)', async () => {
    const { service, getCreated } = makeService()
    const invoice = invoiceFrom([{ quantity: 1, unitPrice: 100, vatRate: 25 }])
    await service.createJournalEntryForInvoice(invoice as never, 'org-1', 'user-1')

    const lines = getCreated()!.data.lines.create
    const { debitOre, creditOre } = sums(lines)
    expect(debitOre).toBe(12_500)
    expect(creditOre).toBe(12_500)
    expect(vatLines(lines)).toEqual([
      expect.objectContaining({ accountId: 'acc-2611', credit: 25, description: 'Moms 25%' }),
    ])
  })
})

describe('C2 — moms per momssats på rätt konto', () => {
  it('flera satser i samma faktura: 25 % och 12 % var för sig', async () => {
    const { service, getCreated } = makeService()
    const invoice = invoiceFrom([
      { quantity: 1, unitPrice: 10_000, vatRate: 25 },
      { quantity: 1, unitPrice: 5_000, vatRate: 12 },
    ])
    await service.createJournalEntryForInvoice(invoice as never, 'org-1', 'user-1')

    const lines = getCreated()!.data.lines.create
    const { debitOre, creditOre } = sums(lines)
    expect(creditOre).toBe(debitOre)

    // Momsen får INTE slås ihop till en rad eller en blandad sats.
    const moms = vatLines(lines)
    expect(moms).toHaveLength(2)
    expect(moms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'acc-2611', credit: 2_500, description: 'Moms 25%' }),
        expect.objectContaining({ accountId: 'acc-2621', credit: 600, description: 'Moms 12%' }),
      ]),
    )
  })

  it('tre satser (25/12/6) hamnar på tre olika konton och balanserar', async () => {
    const { service, getCreated } = makeService()
    const invoice = invoiceFrom([
      { quantity: 3, unitPrice: 33.33, vatRate: 25 },
      { quantity: 3, unitPrice: 33.33, vatRate: 12 },
      { quantity: 3, unitPrice: 33.33, vatRate: 6 },
    ])
    await service.createJournalEntryForInvoice(invoice as never, 'org-1', 'user-1')

    const lines = getCreated()!.data.lines.create
    expect(sums(lines).creditOre).toBe(sums(lines).debitOre)
    expect(
      vatLines(lines)
        .map((l) => l['accountId'])
        .sort(),
    ).toEqual(['acc-2611', 'acc-2621', 'acc-2631'])
  })

  it('0 % ger ingen momsrad (momsbefriat), och balansen håller', async () => {
    const { service, getCreated } = makeService()
    const invoice = invoiceFrom([{ quantity: 1, unitPrice: 10_000, vatRate: 0 }])
    await service.createJournalEntryForInvoice(invoice as never, 'org-1', 'user-1')

    const lines = getCreated()!.data.lines.create
    expect(vatLines(lines)).toHaveLength(0)
    expect(sums(lines).creditOre).toBe(sums(lines).debitOre)
  })
})

describe('C2 — momsraden får aldrig tappas tyst', () => {
  it('saknat momskonto i kontoplanen KASTAR i stället för att skriva obalanserat', async () => {
    // Kontoplan utan 2611 — tidigare utelämnades momsraden tyst och verifikatet
    // blev obalanserat med hela momsbeloppet.
    const { service } = makeService({
      accounts: [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3914', number: 3914 },
      ],
    })
    const invoice = invoiceFrom([{ quantity: 1, unitPrice: 10_000, vatRate: 25 }])

    await expect(
      service.createJournalEntryForInvoice(invoice as never, 'org-1', 'user-1'),
    ).rejects.toThrow(/momskonto 2611/)
  })
})
