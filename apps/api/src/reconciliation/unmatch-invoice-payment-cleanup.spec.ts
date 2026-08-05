/**
 * #326 B — allokeringen följer huvudboken vid avmatchning.
 *
 * Före B raderade `unmatchTransaction` `rentNoticePayment` men ALDRIG
 * `invoicePayment`. Verifikatet reverserades medan allokeringen låg kvar:
 * huvudboken visade hela fordran, `computeInvoiceDebt` visade total − allokering,
 * och den lägre siffran är den inkassoexportens skuldgrind läser (#318).
 *
 * Enhetstesterna här hävdar SEKVENSEN och BESLUTEN — att raderingen sker före
 * verifikatreverseringen, att statusen läses ur loggen i stället för att gissas,
 * och att händelsen skrivs i samma transaktion. Att BÖCKERNA faktiskt stämmer
 * efteråt bevisas mot riktig Postgres i bevisriggen (#326 B, S1–S7).
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'

const INVOICE_ID = 'inv-1'
const TX_ID = 'tx-1'

/** Attrapp-Prisma som loggar ORDNINGEN på varje skrivning. */
function makeService(
  opts: {
    invoiceStatus?: string
    allocation?: { invoiceId: string; amount: number } | null
    remainingAfterDelete?: number
    partialEvents?: Array<{ payload: unknown }>
  } = {},
) {
  const order: string[] = []
  const allocation =
    opts.allocation === undefined ? { invoiceId: INVOICE_ID, amount: 3000 } : opts.allocation

  const tx = {
    $queryRaw: jest.fn(() => {
      order.push('lock:invoice')
      return Promise.resolve([])
    }),
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        status: opts.invoiceStatus ?? 'PARTIAL',
        invoiceNumber: 'F-2026-0042',
      }),
      updateMany: jest.fn(() => {
        order.push('write:invoice.status')
        return Promise.resolve({ count: 1 })
      }),
    },
    invoicePayment: {
      findFirst: jest.fn().mockResolvedValue(
        allocation
          ? {
              id: 'ip-1',
              invoiceId: allocation.invoiceId,
              amount: new Decimal(allocation.amount),
              paidAt: new Date('2026-07-20T00:00:00.000Z'),
              source: 'BANK_RECONCILIATION',
            }
          : null,
      ),
      deleteMany: jest.fn(() => {
        order.push('delete:invoicePayment')
        return Promise.resolve({ count: 1 })
      }),
      findMany: jest.fn().mockResolvedValue(
        Array.from({ length: opts.remainingAfterDelete ?? 0 }, () => ({
          amount: new Decimal(1000),
        })),
      ),
    },
    invoiceEvent: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.partialEvents ?? [{ payload: { previousStatus: 'SENT' } }]),
      create: jest.fn((args: unknown) => {
        order.push('write:invoiceEvent')
        return Promise.resolve(args)
      }),
    },
    rentNoticePayment: {
      // #326 D — allokeringens id läses FÖRE raderingen (verifikatets nyckel).
      // NULL som default: den här filen testar FAKTURA-matchade transaktioner,
      // och XOR-invarianten säger att de aldrig har en avi-allokering. Testet
      // som bryter invarianten sätter den explicit.
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rentNotice: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    bankTransaction: {
      updateMany: jest.fn(() => {
        order.push('write:bankTransaction')
        return Promise.resolve({ count: 1 })
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'Anna', lastName: 'Ek' }) },
  }

  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue({
        id: TX_ID,
        status: 'MATCHED',
        invoice: {
          id: INVOICE_ID,
          status: opts.invoiceStatus ?? 'PARTIAL',
          invoiceNumber: 'F-2026-0042',
        },
        matchedRentNotice: null,
      }),
      updateMany: tx.bankTransaction.updateMany,
    },
    rentNotice: { updateMany: tx.rentNotice.updateMany },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const reverseJournalEntryForPayment = jest.fn(() => {
    order.push('reverse:journalEntry')
    return Promise.resolve()
  })

  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    new InvoiceEventsService(prisma as never) as never,
    { reverseJournalEntryForPayment } as never,
    {} as never,
  )
  return { service, tx, order, reverseJournalEntryForPayment }
}

describe('#326 B — allokeringen raderas, och i rätt ordning', () => {
  it('raderar allokeringen nycklad på banktransaktionen', async () => {
    const { service, tx } = makeService()
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')
    expect(tx.invoicePayment.deleteMany).toHaveBeenCalledWith({
      where: { bankTransactionId: TX_ID },
    })
  })

  it('SEKVENS: lås → radera allokering → statusrättelse → händelse → bank-länk → motverifikat', async () => {
    // Ordningen är lastbärande, inte kosmetisk:
    //  • låset först — låsordningen Invoice → BankTransaction (ingen ABBA)
    //  • raderingen FÖRE reverseringen — annars kan en fallerad reversering
    //    lämna allokeringen borta men verifikatet kvar
    //  • händelsen i samma transaktion som raderingen (BFL 5 kap 11 §)
    const { service, order } = makeService()
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(order).toEqual([
      'lock:invoice',
      'delete:invoicePayment',
      'write:invoice.status',
      'write:invoiceEvent',
      'write:bankTransaction',
      'reverse:journalEntry',
    ])
  })

  it('läser Σ KVARVARANDE allokeringar EFTER raderingen — inte före', async () => {
    const { service, tx } = makeService()
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    const deleteOrder = tx.invoicePayment.deleteMany.mock.invocationCallOrder[0]!
    const readOrder = tx.invoicePayment.findMany.mock.invocationCallOrder[0]!
    expect(readOrder).toBeGreaterThan(deleteOrder)
  })
})

describe('#326 B — statusen läses ur loggen, gissas aldrig', () => {
  it('sista allokeringen borta → återställer till loggens utgångsstatus', async () => {
    const { service, tx } = makeService({
      remainingAfterDelete: 0,
      partialEvents: [{ payload: { previousStatus: 'OVERDUE' } }],
    })
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: INVOICE_ID, organizationId: 'org-1', status: 'PARTIAL' },
      data: { status: 'OVERDUE', paidAt: null },
    })
  })

  it('en allokering KVAR → statusen rörs inte (fakturan är fortfarande delbetald)', async () => {
    const { service, tx } = makeService({ remainingAfterDelete: 1 })
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')
    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
  })

  it('FAIL-CLOSED: PARTIAL utan allokeringar och utan utgångsstatus i loggen → kastar, skriver inget', async () => {
    const { service, tx } = makeService({ remainingAfterDelete: 0, partialEvents: [] })
    await expect(service.unmatchTransaction(TX_ID, 'org-1', 'user-1')).rejects.toThrow(
      /utgångsstatusen före delbetalningen saknas/,
    )
    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled()
  })

  it('FAIL-CLOSED: fakturan finns inte i organisationen (datadrift) → kastar innan något raderas', async () => {
    // DEN FAKTISKA TENANT-GRINDEN FÖR RADERINGEN. `invoicePayment.deleteMany`,
    // `invoicePayment.findMany` och `invoiceEvent.findMany` har inget
    // `organizationId` i sitt where — modellerna saknar kolumnen. Hela
    // scopningen vilar på att den ORG-SCOPADE fakturaläsningen under låset gav
    // en rad. `BankTransaction.invoiceId` är en invariant på applikationsnivå,
    // inte DB-nivå (påpekat i säkerhetsgranskningen av #326 A), så den här
    // grenen är det som stänger luckan — och den måste vara testad, annars kan
    // en refaktorering ta bort den utan att något faller.
    const { service, tx } = makeService()
    tx.invoice.findFirst.mockResolvedValueOnce(null) // org-scopad läsning missar

    await expect(service.unmatchTransaction(TX_ID, 'org-1', 'user-1')).rejects.toThrow(
      /kunde inte läsas i organisationen/,
    )
    expect(tx.invoicePayment.deleteMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled()
  })

  it('FAIL-CLOSED: allokering som pekar på en ANNAN faktura → kastar innan något raderas', async () => {
    const { service, tx } = makeService({
      allocation: { invoiceId: 'nagon-annan-faktura', amount: 3000 },
    })
    await expect(service.unmatchTransaction(TX_ID, 'org-1', 'user-1')).rejects.toThrow(
      /pekar på en annan faktura/,
    )
    expect(tx.invoicePayment.deleteMany).not.toHaveBeenCalled()
  })
})

describe('#326 D — XOR-invarianten mellan faktura- och avi-allokering', () => {
  it('FAIL-CLOSED: allokeringar i BÅDA tabellerna → kastar i stället för att tyst reversera fel verifikat', async () => {
    // Invarianten (en banktransaktion är faktura- ELLER avi-matchad) bärs av
    // app-lagret, inte av en DB-constraint. Bryts den skulle avi-grenen tyst
    // skriva över fakturagrenens reverseringsnyckel — fakturans verifikat
    // reverseras aldrig medan allokeringen raderas och statusen återställs.
    // (Säkerhetsgranskning av #326 D.)
    const { service, tx } = makeService()
    tx.rentNoticePayment.findFirst.mockResolvedValue({ id: 'rnp-drift' })

    await expect(service.unmatchTransaction(TX_ID, 'org-1', 'user-1')).rejects.toThrow(
      /allokeringar i BÅDA tabellerna/,
    )
  })

  it('bara avi-allokering → ingen konflikt, avmatchningen går igenom', async () => {
    const { service, tx } = makeService({ allocation: null })
    tx.rentNoticePayment.findFirst.mockResolvedValue({ id: 'rnp-1' })

    await expect(service.unmatchTransaction(TX_ID, 'org-1', 'user-1')).resolves.not.toThrow()
  })
})

describe('#326 B — behandlingshistoriken (BFL 5 kap 11 §)', () => {
  it('PAYMENT_REVERSED med belopp, transaktion, aktör och tidpunkt', async () => {
    const { service, tx } = makeService()
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(tx.invoiceEvent.create).toHaveBeenCalledTimes(1)
    const arg = tx.invoiceEvent.create.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    expect(arg.data.type).toBe('PAYMENT_REVERSED')
    expect(arg.data.invoiceId).toBe(INVOICE_ID)
    // AKTÖR — kolumnerna, denormaliserade av record()
    expect(arg.data.actorType).toBe('USER')
    expect(arg.data.actorId).toBe('user-1')
    expect(arg.data.actorLabel).toBe('Anna Ek')

    const payload = arg.data.payload as Record<string, unknown>
    expect(payload.amount).toBe(3000) // BELOPP
    expect(payload.transactionId).toBe(TX_ID) // TRANSAKTION
    expect(payload.paidAt).toBe('2026-07-20T00:00:00.000Z') // TIDPUNKT för betalningen
    expect(payload.previousStatus).toBe('PARTIAL')
    expect(payload.newStatus).toBe('SENT')
    expect(payload.statusRestored).toBe(true)
    // (Tidpunkten för RÄTTELSEN är InvoiceEvent.createdAt — DB-default.)
  })

  it('händelsen skrivs även när statusen står kvar — raderingen ska synas oavsett', async () => {
    const { service, tx } = makeService({ remainingAfterDelete: 2 })
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    const payload = (
      tx.invoiceEvent.create.mock.calls[0]![0] as { data: { payload: Record<string, unknown> } }
    ).data.payload
    expect(payload.statusRestored).toBe(false)
    expect(payload.statusKeptReason).toBe('allocations-remain')
    expect(payload.remainingAllocations).toBe(2)
  })
})

describe('#326 B — avgränsning', () => {
  it('ingen allokering (fuzzy-matchad faktura) → ingen radering, ingen status, ingen händelse', async () => {
    const { service, tx, reverseJournalEntryForPayment } = makeService({ allocation: null })
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(tx.invoicePayment.deleteMany).not.toHaveBeenCalled()
    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
    expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    // …men avmatchningen i övrigt körs som förut.
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
  })

  it('OVERDUE med allokering → allokeringen städas, men statusen rörs inte', async () => {
    // OVERDUE är förfallo-härledd, inte betalningshärledd. En förfallen faktura
    // blir inte oförfallen av att en felmatchad betalning rättas bort.
    const { service, tx } = makeService({ invoiceStatus: 'OVERDUE', remainingAfterDelete: 0 })
    await service.unmatchTransaction(TX_ID, 'org-1', 'user-1')

    expect(tx.invoicePayment.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.invoice.updateMany).not.toHaveBeenCalled()
  })
})
