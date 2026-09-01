/**
 * #326 A — EN ÖVERLÄMNAD FORDRAN AVMATCHAS INTE.
 *
 * `unmatchTransaction` raderar `rentNoticePayment` men aldrig `invoicePayment`,
 * och rör aldrig `Invoice.status`. Avmatchas en delbetald faktura reverseras
 * verifikatet medan allokeringen ligger kvar: huvudboken visar hela fordran på
 * 1510, `computeInvoiceDebt` visar total − allokering. Den lägre siffran är den
 * inkassoexportens skuldgrind och kravbelopp läser (#318) — gäldenären krävs på
 * för lite, och ingen upptäcker det.
 *
 * Spärren stänger den vägen för SENT_TO_COLLECTION. Den är INTE fixen: för
 * PARTIAL och övriga statusar består divergensen tills #326 B städar
 * allokeringen och återställer statusen. Testerna nedan hävdar BÅDA delarna —
 * annars kan spärren tyst växa till något den inte skulle vara.
 *
 * Bevisar:
 *   • SENT_TO_COLLECTION nekas — ingen transaktion öppnas, inget raderas,
 *     inget reverseras, ingen status rörs
 *   • meddelandet pekar på en väg som FAKTISKT finns (support), inte på
 *     avmatchning/kreditnota som inte hjälper här
 *   • PARTIAL är OFÖRÄNDRAT (buggen kvarstår tills B — avsett)
 *   • avi-vägen (RentNotice) är OFÖRÄNDRAD
 *   • AI-verktyget `unmatch_transaction` nekas av SAMMA spärr — testet kör en
 *     skarp ReconciliationService genom ToolExecutorService, inte en attrapp
 *     av grinden
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ConflictException } from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { ToolExecutorService } from '../ai/tools/tool-executor.service'

/**
 * Skarp ReconciliationService med attrapp-Prisma. Attrappen räknar VARJE
 * skrivning, så ett test kan hävda att ingenting hände — inte bara att
 * reverseringen uteblev.
 *
 * `statusInsideTx` styr vad omprövningen INNANFÖR radlåset ser. Att den kan
 * skilja sig från statusen den yttre läsningen såg är hela poängen: det är så
 * racet mot en samtidig inkassoexport uttrycks deterministiskt.
 *
 * #326 B: attrappen bär nu även `invoicePayment` och `invoiceEvent`, eftersom
 * avmatchningen städar allokeringen. De två PARTIAL-testerna längre ned hävdade
 * tidigare att allokeringen INTE städades — det var korrekt då och är fel nu;
 * de är omskrivna, inte borttagna, så avgränsningen fortfarande går att läsa.
 */
function makeService(transaction: unknown, statusInsideTx?: string) {
  const outerInvoice = (transaction as { invoice?: { status: string; invoiceNumber: string } })
    ?.invoice
  const tx = {
    // #326 C — behandlingshistoriken på avi-sidan.
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },

    rentNotice: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    bankTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // #518 — krediteringarna läses på samma vägar som allokeringarna.
    rentNoticeCredit: { findMany: jest.fn().mockResolvedValue([]) },
    rentNoticePayment: {
      // #326 D — allokeringens id läses FÖRE raderingen (verifikatets nyckel).
      // XOR: en fakturamatchad transaktion har ingen avi-allokering, och tvärtom.
      findFirst: jest.fn().mockResolvedValue(
        outerInvoice
          ? null
          : {
              id: 'rnp-1',
              rentNoticeId: 'rn-1',
              amount: new Decimal(5000),
              paidAt: new Date('2026-07-20T00:00:00.000Z'),
              source: 'BANK_RECONCILIATION',
            },
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // Radlåset + omprövningen (#326 A).
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: {
      findFirst: jest.fn().mockResolvedValue(
        outerInvoice
          ? {
              status: statusInsideTx ?? outerInvoice.status,
              invoiceNumber: outerInvoice.invoiceNumber,
            }
          : null,
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // Allokeringsstädningen (#326 B).
    invoicePayment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ip-1',
        invoiceId: outerInvoice ? (transaction as { invoice: { id: string } }).invoice.id : null,
        amount: new Decimal(3000),
        paidAt: new Date('2026-07-20'),
        source: 'BANK_RECONCILIATION',
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoiceEvent: {
      findMany: jest.fn().mockResolvedValue([{ payload: { previousStatus: 'SENT' } }]),
      create: jest.fn().mockResolvedValue({}),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  }
  const $transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx))
  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(transaction),
      updateMany: tx.bankTransaction.updateMany,
    },
    rentNotice: { updateMany: tx.rentNotice.updateMany },
    $transaction,
  }
  const reverseJournalEntryForPayment = jest.fn().mockResolvedValue(undefined)
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    new InvoiceEventsService(prisma as never) as never,
    { reverseJournalEntryForPayment } as never,
    {} as never, // PaymentFreshnessService — ej använd i unmatch-vägen,
    { record: jest.fn().mockResolvedValue({}) } as never, // #326 C — RentNoticeEventsService
  )
  return { service, prisma, tx, $transaction, reverseJournalEntryForPayment }
}

/**
 * DISKRIMINERANDE DATA. Fakturanumret i meddelandet (F-2026-0042) skiljer sig
 * från transaktions-id:t, och statusen är den enda skillnaden mot PARTIAL-fallet
 * nedan — faller ett test kan det bara bero på statusen.
 */
const COLLECTION_TX = {
  id: 'tx-inkasso',
  status: 'MATCHED',
  invoice: { id: 'inv-1', status: 'SENT_TO_COLLECTION', invoiceNumber: 'F-2026-0042' },
  matchedRentNotice: null,
}

const PARTIAL_TX = {
  id: 'tx-partial',
  status: 'MATCHED',
  invoice: { id: 'inv-2', status: 'PARTIAL', invoiceNumber: 'F-2026-0043' },
  matchedRentNotice: null,
}

describe('#326 A — unmatchTransaction spärrar SENT_TO_COLLECTION', () => {
  it('nekar avmatchning av en överlämnad fordran (409 — tillståndskonflikt, inte felformad begäran)', async () => {
    const { service } = makeService(COLLECTION_TX)
    await expect(
      service.unmatchTransaction('tx-inkasso', 'org-1', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('INGENTING skrivs: ingen transaktion öppnas, inget raderas, inget reverseras, ingen status rörs', async () => {
    const { service, tx, $transaction, reverseJournalEntryForPayment } = makeService(COLLECTION_TX)

    await expect(service.unmatchTransaction('tx-inkasso', 'org-1', 'user-1')).rejects.toThrow()

    // Spärren ligger FÖRE $transaction — inget halvvägs städat tillstånd kan uppstå.
    expect($transaction).not.toHaveBeenCalled()
    expect(tx.rentNoticePayment.deleteMany).not.toHaveBeenCalled()
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled()
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(reverseJournalEntryForPayment).not.toHaveBeenCalled()
  })

  it('meddelandet pekar på support — INTE på en väg som inte finns', async () => {
    const { service } = makeService(COLLECTION_TX)

    // Hävda VILKET fel som kastades. Ett kast av annan orsak skulle annars
    // passera som grönt (läxan från #297).
    const err = await service
      .unmatchTransaction('tx-inkasso', 'org-1', 'user-1')
      .then(() => null)
      .catch((e: unknown) => e as ConflictException)

    const message = String(err?.message)
    expect(message).toContain('F-2026-0042')
    expect(message).toContain('inkasso')
    expect(message).toContain('supporten')
    // Får INTE upprepa VOID-grindens rundgång ("avmatcha/återbetala") eller
    // PAID-spärrens kreditnota — ingen av dem löser det här fallet.
    expect(message).not.toContain('kreditnota')
    expect(message).not.toMatch(/återbetala/i)
  })
})

describe('#326 A — omprövningen innanför radlåset är den lastbärande', () => {
  /**
   * RACET, deterministiskt uttryckt. `claimForExport` tar medvetet inget radlås
   * utan claimar med en status-guardad `updateMany` — den kan alltså committa
   * PARTIAL → SENT_TO_COLLECTION i fönstret mellan unmatchens olåsta läsning och
   * dess skrivning. Attrappen låter den yttre läsningen se PARTIAL och den inre,
   * låsta läsningen se SENT_TO_COLLECTION: exakt det fönstret.
   *
   * Utan omprövningen rullar avmatchningen vidare på en inaktuell status och
   * lämnar divergensen på en faktura som FAKTISKT är överlämnad.
   */
  it('yttre läsningen ser PARTIAL, den låsta ser SENT_TO_COLLECTION → nekas ändå, inget skrivs', async () => {
    const { service, tx, $transaction, reverseJournalEntryForPayment } = makeService(
      PARTIAL_TX,
      'SENT_TO_COLLECTION',
    )

    await expect(
      service.unmatchTransaction('tx-partial', 'org-1', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException)

    // Transaktionen ÖPPNAS här (till skillnad från förkontrollen) — och rullas
    // tillbaka av kastet. Ingen skrivning hann ske innan omprövningen.
    expect($transaction).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1) // radlåset togs
    expect(tx.rentNoticePayment.deleteMany).not.toHaveBeenCalled()
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled()
    expect(reverseJournalEntryForPayment).not.toHaveBeenCalled()
  })

  it('radlåset tas FÖRE bank-skrivningen — låsordningen Invoice → BankTransaction hålls', async () => {
    const { service, tx } = makeService(PARTIAL_TX)
    const order: string[] = []
    tx.$queryRaw.mockImplementation(() => {
      order.push('lock:invoice')
      return Promise.resolve([])
    })
    tx.bankTransaction.updateMany.mockImplementation(() => {
      order.push('write:bankTransaction')
      return Promise.resolve({ count: 1 })
    })

    await service.unmatchTransaction('tx-partial', 'org-1', 'user-1')

    expect(order).toEqual(['lock:invoice', 'write:bankTransaction'])
  })
})

describe('#326 A — spärren är avgränsad: allt annat är oförändrat', () => {
  // OMSKRIVET AV #326 B. Testet hävdade tidigare att allokeringen INTE städades
  // ("buggen kvarstår tills B") — sant då, fel nu. Det står kvar i A:s fil för
  // att avgränsningen ska gå att läsa: spärren gäller SENT_TO_COLLECTION, och
  // PARTIAL avmatchas fortfarande. Vad som HÄNDER vid den avmatchningen ägs av
  // B och bevisas i unmatch-invoice-payment-cleanup.spec.ts.
  it('PARTIAL avmatchas fortfarande — spärren gäller bara överlämnade fordringar', async () => {
    const { service, tx, $transaction, reverseJournalEntryForPayment } = makeService(PARTIAL_TX)

    await service.unmatchTransaction('tx-partial', 'org-1', 'user-1')

    expect($transaction).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled() // ingen avi inblandad
  })

  it('avi-vägen (RentNotice) är oförändrad — spärren gäller bara fakturor', async () => {
    const { service, tx, reverseJournalEntryForPayment } = makeService({
      id: 'tx-avi',
      status: 'MATCHED',
      invoice: null,
      matchedRentNotice: { id: 'rn-1', status: 'PAID' },
    })

    await service.unmatchTransaction('tx-avi', 'org-1', 'user-1')

    expect(tx.rentNoticePayment.deleteMany).toHaveBeenCalledWith({
      where: { bankTransactionId: 'tx-avi' },
    })
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
  })
})

describe('#326 A — AI-verktyget unmatch_transaction nekas av SAMMA spärr', () => {
  /**
   * Ingen attrapp av grinden: ToolExecutorService får en SKARP
   * ReconciliationService. Faller spärren i servicen faller det här testet
   * också — vilket är hela poängen. En attrapp hade bevisat att attrappen
   * nekar, inte att produkten gör det.
   */
  function makeExecutor(transaction: unknown) {
    const rig = makeService(transaction)
    const audit = {
      logToolExecution: jest.fn().mockResolvedValue(undefined),
      // Steg 3b: produktionsvägen öppnar och stänger spåret för FÖRE_EFFEKTEN-verktyg.
      beginToolExecution: jest.fn().mockResolvedValue(undefined),
      completeToolExecution: jest.fn().mockResolvedValue(undefined),
    }
    const noop = {} as never
    const executor = new ToolExecutorService(
      noop, // 1 prisma
      noop, // 2 invoicesService
      noop, // 3 pdfService
      noop, // 4 tenantsService
      noop, // 5 leasesService
      noop, // 6 rentIncreasesService
      noop, // 7 propertiesService
      noop, // 8 unitsService
      noop, // 9 accountingService
      noop, // 10 verifikationsnummer
      noop, // 11 mailService
      noop, // 12 maintenanceService
      noop, // 13 aviseringService
      noop, // 14 inspectionsService
      noop, // 15 maintenancePlanService
      rig.service as never, // 16 reconciliationService — SKARP
      noop, // 17 collectionExport
      noop, // 18 paymentReminders
      noop, // 19 storage
      noop, // 20 redis
      audit as never, // 21 audit
      noop, // 22 documentDelivery
      noop, // 23 signingService
      noop, // 24 accountingPeriods
    )
    return { executor, ...rig }
  }

  it('AI:n får success=false och spärrens egen text — inte ett tyst lyckat svar', async () => {
    const { executor, $transaction, reverseJournalEntryForPayment } = makeExecutor(COLLECTION_TX)

    const result = await executor.executeTool(
      'unmatch_transaction',
      { transactionId: 'tx-inkasso', reason: 'Fel faktura' },
      'org-1',
      'user-1',
      'ACCOUNTANT',
      // Bindande verktyg kräver bevis på en konsumerad bekräftelse
      // (action-authorization.ts). Testet efterliknar confirm-vägen.
      { actionProof: { claimed: true } },
    )

    expect(result.success).toBe(false)
    // Spärrens EGEN formulering når fram — inte bara ett generiskt "misslyckades".
    expect(result.message).toContain('överlämnad till inkasso')
    expect(result.message).toContain('supporten')
    // Och ingenting skrevs på vägen dit.
    expect($transaction).not.toHaveBeenCalled()
    expect(reverseJournalEntryForPayment).not.toHaveBeenCalled()
  })

  it('AI-vägen för en PARTIAL-faktura är oförändrad (success=true)', async () => {
    const { executor, reverseJournalEntryForPayment } = makeExecutor(PARTIAL_TX)

    const result = await executor.executeTool(
      'unmatch_transaction',
      { transactionId: 'tx-partial', reason: 'Fel faktura' },
      'org-1',
      'user-1',
      'ACCOUNTANT',
      // Bindande verktyg kräver bevis på en konsumerad bekräftelse
      // (action-authorization.ts). Testet efterliknar confirm-vägen.
      { actionProof: { claimed: true } },
    )

    expect(result.success).toBe(true)
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
  })
})
