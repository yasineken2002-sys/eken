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
  const invoicePaymentCreate = jest.fn().mockResolvedValue({})
  const prisma = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(invoiceRow),
      findFirstOrThrow: jest.fn().mockResolvedValue(invoiceRow),
      updateMany,
    },
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue(priors.map((a) => ({ amount: new Prisma.Decimal(a) }))),
      create: invoicePaymentCreate,
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  }

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
    const alloc = invoicePaymentCreate.mock.calls[0]?.[0]?.data
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

  it('utelämnat belopp = betala resten (bevarar beteendet för normalfallet)', async () => {
    const { service, createJournalEntryForInvoiceManualPayment } = makeService({
      priorAllocations: [2_500],
    })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {})

    expect(bookedAmount(createJournalEntryForInvoiceManualPayment)).toBe(7_500)
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
