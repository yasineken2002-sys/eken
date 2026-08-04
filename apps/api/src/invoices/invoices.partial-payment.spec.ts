/**
 * C4/C5 — DELBETALNING MOT FAKTURA. De diskriminerande testerna.
 *
 * Buggen: båda fakturans betalvägar bokförde ALLTID `invoice.total`, oavsett
 * hur mycket som faktiskt kommit in, och flippade fakturan till PAID.
 * En inbetalning på 500 kr mot en faktura på 10 000 kr debiterade 1930 med
 * 10 000 kr — bankkontot divergerade från kontoutdraget och statusen ljög.
 *
 * VARFÖR DEN GAMLA SVITEN ALDRIG KUNDE FÅNGA DET: samtliga befintliga tester
 * använder ett belopp som är EXAKT lika med fakturans total (1250 = 1250).
 * Då sammanfaller "mottaget belopp" och "fakturans total" och assertionen
 * diskriminerar inte. Testerna nedan är de första där de skiljer sig.
 *
 * Affärsregler som testas (bekräftade av användaren, väntar expertgranskning):
 *   • överbetalning AVVISAS på båda vägarna
 *   • 1 kr tolerans för "full reglering" (speglad från hyresavier)
 *   • moms påverkas INTE av delbetalning — den bokfördes i sin helhet vid
 *     faktureringen; betalningen rör bara 1930/1510
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { InvoicesService } from './invoices.service'
import { computeInvoiceDebt } from './invoice-debt'

const TOTAL = 10_000

function makeService(opts: { priorAllocations?: number[]; status?: string } = {}) {
  const priors = opts.priorAllocations ?? []
  const invoiceRow = {
    id: 'inv-1',
    status: opts.status ?? 'SENT',
    invoiceNumber: 'F-2026-0001',
    total: new Prisma.Decimal(TOTAL),
  }

  const updateMany = jest.fn().mockResolvedValue({ count: 1 })

  // #290 — allokeringstabellen är STATEFUL i attrappen: create returnerar ett
  // eget id per rad och findMany svarar med det som faktiskt skrivits.
  //
  // En attrapp som returnerar `{}` (som den gjorde före #290) ger allokeringen
  // id === undefined. Då blir verifikatets nyckel
  // "invoice-manual-payment:undefined" för BÅDA delbetalningarna — attrappen
  // utplånar exakt den distinktion testet ska bevisa, och den gamla
  // faktura-nycklade koden hade sett likadan ut. Samma läxa som #288:s
  // tx === prisma.
  const allocations: Array<{ id: string; amount: Prisma.Decimal }> = priors.map((a, i) => ({
    id: `prior-${i + 1}`,
    amount: new Prisma.Decimal(a),
  }))
  const invoicePaymentCreate = jest.fn((arg: { data: Record<string, unknown> }) => {
    const rad = {
      id: `alloc-${allocations.length + 1}`,
      amount: new Prisma.Decimal(arg.data.amount as Prisma.Decimal),
    }
    allocations.push(rad)
    return Promise.resolve(rad)
  })

  // #288 — transaktionsklienten får EGNA mockar, av samma skäl som beskrivs i
  // invoices.manual-payment.spec.ts: en attrapp där tx === prisma kan inte skilja
  // en skrivning innanför transaktionen från en som läckt utanför, och just den
  // buggen uppstod under bygget av #288. Den här filen testar samma funktion och
  // måste ha samma skydd — annars är halva testytan blind för regressionen.
  const tx = {
    invoice: { findFirst: jest.fn().mockResolvedValue(invoiceRow), updateMany },
    invoicePayment: {
      findMany: jest.fn(() => Promise.resolve(allocations.map((a) => ({ ...a })))),
      create: invoicePaymentCreate,
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  const utanförTx = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(invoiceRow),
  }
  const prisma = {
    invoice: {
      findFirst: utanförTx.findFirst,
      findFirstOrThrow: jest.fn().mockResolvedValue(invoiceRow),
      updateMany: utanförTx.updateMany,
    },
    invoicePayment: {
      findMany: utanförTx.findMany,
      create: utanförTx.create,
      deleteMany: utanförTx.deleteMany,
    },
    $transaction: undefined as unknown as jest.Mock,
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  prisma.$transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx))

  const createJournalEntryForInvoiceManualPayment = jest.fn().mockResolvedValue({ id: 'je-pay-1' })
  const eventsService = { record: jest.fn().mockResolvedValue(undefined) }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never,
    {} as never,
    { createJournalEntryForInvoiceManualPayment } as never,
    { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
  )

  return {
    service,
    tx,
    utanförTx,
    updateMany,
    invoicePaymentCreate,
    createJournalEntryForInvoiceManualPayment,
    eventsService,
  }
}

/** Beloppet som faktiskt gick till bokföringen (arg 1 i journalanropet). */
const bookedAmount = (fn: jest.Mock): number => (fn.mock.calls[0] as unknown[])[1] as number

describe('C5 — /pay bokför det MOTTAGNA beloppet, inte fakturans total', () => {
  it('delbetalning 500 mot 10 000 → bokför 500, status PARTIAL, restskuld 9 500', async () => {
    const { service, updateMany, invoicePaymentCreate, createJournalEntryForInvoiceManualPayment } =
      makeService()

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 500,
    })

    // DET HÄR är assertionen som fäller den gamla koden: 500, inte 10 000.
    expect(bookedAmount(createJournalEntryForInvoiceManualPayment)).toBe(500)

    // Statusen ljuger inte: fakturan är inte betald.
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'PARTIAL' } })
    // paidAt sätts INTE vid delbetalning.
    expect(updateMany.mock.calls[0]?.[0]?.data?.paidAt).toBeUndefined()

    // Allokeringen registreras med det faktiska beloppet.
    const alloc = invoicePaymentCreate.mock.calls[0]![0].data
    expect(Number(alloc.amount)).toBe(500)
    expect(alloc.source).toBe('MANUAL')

    // Restskuld = 10 000 − 500.
    const debt = computeInvoiceDebt({ total: TOTAL, allocations: [500] })
    expect(debt.outstanding.toNumber()).toBe(9_500)
    expect(debt.isSettled).toBe(false)
  })

  it('andra betalningen slutför → PAID, restskuld 0, bokningarna summerar till 10 000', async () => {
    const { service, updateMany, createJournalEntryForInvoiceManualPayment } = makeService({
      priorAllocations: [500],
      status: 'PARTIAL',
    })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 9_500,
    })

    expect(bookedAmount(createJournalEntryForInvoiceManualPayment)).toBe(9_500)
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'PAID' } })
    expect(updateMany.mock.calls[0]?.[0]?.data?.paidAt).toBeInstanceOf(Date)

    // Summan av båda bokningarna = fakturans total. Ingen krona bokförd två gånger.
    expect(500 + 9_500).toBe(TOTAL)
    const debt = computeInvoiceDebt({ total: TOTAL, allocations: [500, 9_500] })
    expect(debt.outstanding.toNumber()).toBe(0)
    expect(debt.isSettled).toBe(true)
  })

  it('#290: två delbetalningar → verifikaten nycklas på VAR SIN allokering', async () => {
    // Reproduktionen som avslöjade #290, på enhetsnivå: 500 + 9 500 mot 10 000.
    // Före fixen fick båda verifikaten nyckeln "invoice-manual-payment:inv-1";
    // den andra betalningen träffade den förstas verifikat, createNumberedEntry
    // returnerade det befintliga, callern såg ett icke-null-svar och fakturan
    // flippades till PAID med 9 500 kr obokade. Att verifikaten FAKTISKT blir två
    // i huvudboken bevisas mot riktig Postgres — här låses nyckeln.
    const { service, invoicePaymentCreate, createJournalEntryForInvoiceManualPayment } =
      makeService()

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 500,
    })
    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 9_500,
    })

    expect(invoicePaymentCreate).toHaveBeenCalledTimes(2)
    const anrop = createJournalEntryForInvoiceManualPayment.mock.calls as unknown[][]
    expect(anrop).toHaveLength(2)

    // Nyckelargumentet är den allokering som just skapades — inte fakturans id.
    const nycklar = anrop.map((a) => a[6])
    expect(nycklar).toEqual(['alloc-1', 'alloc-2'])
    expect(nycklar[0]).not.toBe(nycklar[1])
    expect(nycklar).not.toContain('inv-1')

    // Beloppen följer allokeringarna: 500 + 9 500 = hela fakturan.
    expect(anrop.map((a) => a[1])).toEqual([500, 9_500])
    expect((anrop[0]![1] as number) + (anrop[1]![1] as number)).toBe(TOTAL)

    // Transaktionsklienten ligger kvar SIST (#288) — allokerings-id sköts in före den.
    expect(anrop[0]![7]).toBeDefined()
    expect(anrop[0]!).toHaveLength(8)
  })

  it('utelämnat belopp = betala resten (bevarar beteendet för normalfallet)', async () => {
    const { service, createJournalEntryForInvoiceManualPayment } = makeService({
      priorAllocations: [2_500],
    })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {})

    expect(bookedAmount(createJournalEntryForInvoiceManualPayment)).toBe(7_500)
  })
})

describe('C5 — delbetalningen skrivs INNANFÖR transaktionen (#288)', () => {
  it('varken allokering eller claim går utanför tx', async () => {
    // Delbetalningen är den gren där en läckt this.prisma-skrivning gör MEST
    // skada: statusen blir PARTIAL och allokeringen finns, men skulle överleva
    // en rollback av bokföringen. Kontrollen är möjlig först sedan attrappen
    // skiljer tx från prisma.
    const { service, tx, utanförTx } = makeService()

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 500,
    })

    expect(tx.invoice.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.invoicePayment.create).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1) // radlåset
    expect(utanförTx.updateMany).not.toHaveBeenCalled()
    expect(utanförTx.create).not.toHaveBeenCalled()
    expect(utanförTx.findMany).not.toHaveBeenCalled()
  })
})

describe('C5 — gränsfall', () => {
  it('EXAKT belopp → PAID', async () => {
    const { service, updateMany, createJournalEntryForInvoiceManualPayment } = makeService()
    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: TOTAL,
    })
    expect(bookedAmount(createJournalEntryForInvoiceManualPayment)).toBe(TOTAL)
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'PAID' } })
  })

  it('ÖVERBETALNING avvisas — ingen bokning, ingen allokering', async () => {
    const { service, createJournalEntryForInvoiceManualPayment, invoicePaymentCreate } =
      makeService()

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
        enteredAmount: 10_001,
      }),
    ).rejects.toThrow(/överstiger fakturans restskuld/)

    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
    expect(invoicePaymentCreate).not.toHaveBeenCalled()
  })

  it('överbetalning mot RESTSKULDEN (inte totalen) avvisas', async () => {
    // 8 000 redan betalt → restskuld 2 000. En betalning på 2 500 är för mycket
    // trots att den är mindre än fakturans total.
    const { service } = makeService({ priorAllocations: [8_000], status: 'PARTIAL' })
    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
        enteredAmount: 2_500,
      }),
    ).rejects.toThrow(/överstiger fakturans restskuld/)
  })

  it('noll eller negativt belopp avvisas', async () => {
    const { service } = makeService()
    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', { enteredAmount: 0 }),
    ).rejects.toThrow(/större än noll/)
  })

  it('redan fullt reglerad faktura avvisas', async () => {
    const { service } = makeService({ priorAllocations: [TOTAL], status: 'PARTIAL' })
    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', { enteredAmount: 1 }),
    ).rejects.toThrow(/redan fullt reglerad/)
  })
})

describe('computeInvoiceDebt — restskuld som beräknat tillstånd', () => {
  it('summerar allokeringar i Decimal (ingen float-drift)', () => {
    // 0.1 + 0.2 !== 0.3 i float.
    const debt = computeInvoiceDebt({ total: '0.30', allocations: ['0.10', '0.20'] })
    expect(debt.outstanding.toNumber()).toBe(0)
    expect(debt.isSettled).toBe(true)
  })

  it('klampar aldrig till negativ restskuld men behåller rå claim', () => {
    const debt = computeInvoiceDebt({ total: 100, allocations: [150] })
    expect(debt.outstanding.toNumber()).toBe(0)
    expect(debt.claim.toNumber()).toBe(-50) // signalen som gör överbetalning upptäckbar
  })

  it('öresbelopp summerar exakt', () => {
    const debt = computeInvoiceDebt({
      total: '99.99',
      allocations: ['33.33', '33.33', '33.33'],
    })
    expect(debt.outstanding.toNumber()).toBe(0)
  })
})

describe('C4/C5 — VOID-guarden nyckar på ALLOKERINGAR, inte status', () => {
  /**
   * PR #166 blockerade makulering när `status === 'PARTIAL'`. Det räckte så
   * länge PARTIAL i praktiken var onåbart. Med delbetalningsmodellen är det
   * nåbart — och INVOICE_TRANSITIONS tillåter PARTIAL → OVERDUE → VOID. Eftersom
   * PATCH /invoices/:id/status bara blockerar PAID kunde en delbetald faktura
   * annars makuleras i två steg, förbi spärren, med mottagna pengar kvar obokade.
   */
  function makeVoidService(opts: { status: string; allocations: number[] }) {
    const invoiceRow = {
      id: 'inv-1',
      status: opts.status,
      invoiceNumber: 'F-2026-0001',
      total: new Prisma.Decimal(TOTAL),
    }
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoiceRow),
        update: jest.fn().mockResolvedValue(invoiceRow),
      },
      invoicePayment: {
        findMany: jest.fn().mockResolvedValue(opts.allocations.map((id) => ({ id: String(id) }))),
      },
      // #301: radlåset (låsordning Invoice → Deposit) + namnrymdsuppslaget för
      // depositionens accrual. Ingen deposition här → reverseringen blir no-op.
      $queryRaw: jest.fn().mockResolvedValue([]),
      deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    }
    const prisma = {
      invoice: { findFirst: jest.fn().mockResolvedValue(invoiceRow) },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    }
    const service = new InvoicesService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      { reverseJournalEntryForInvoice: jest.fn().mockResolvedValue(undefined) } as never,
      { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
    )
    return { service, tx }
  }

  it('PARTIAL med allokering → VOID blockeras (som förut)', async () => {
    const { service } = makeVoidService({ status: 'PARTIAL', allocations: [1] })
    await expect(
      service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER', {}),
    ).rejects.toThrow(/registrerad betalning/)
  })

  it('OVERDUE med allokering → VOID blockeras (hålet som statusvarianten missade)', async () => {
    const { service } = makeVoidService({ status: 'OVERDUE', allocations: [1] })
    await expect(
      service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER', {}),
    ).rejects.toThrow(/registrerad betalning/)
  })

  it('SENT_TO_COLLECTION med allokering → VOID blockeras', async () => {
    const { service } = makeVoidService({ status: 'SENT_TO_COLLECTION', allocations: [1] })
    await expect(
      service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER', {}),
    ).rejects.toThrow(/registrerad betalning/)
  })

  it('UTAN allokering → VOID tillåts (obetald faktura får makuleras)', async () => {
    const { service, tx } = makeVoidService({ status: 'OVERDUE', allocations: [] })
    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER', {})
    expect(tx.invoice.update).toHaveBeenCalled()
  })
})
