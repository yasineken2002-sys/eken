/**
 * Issue #33 (BFL 5 kap 5 §/9 §) — unmatchTransaction återställer status och
 * bokför motverifikat ATOMISKT.
 *
 * Verifierar att unmatchTransaction():
 *   • vid lyckad unmatch awaitar reverseJournalEntryForPayment INNE i en
 *     transaktion (samma tx skickas in) och återställer hyresavi-status
 *   • vid misslyckad reversering PROPAGERAR felet (tx rullar tillbaka) i
 *     stället för att tyst svälja det (gammalt fire-and-forget-beteende)
 *   • avvisar avmatchning av betald faktura (kreditnota krävs) och omatchade tx
 *   • är idempotent vid retry (reverseringen är idempotent i accounting-lagret)
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

function makeService(opts: {
  transaction?: unknown
  /** #326 C — allokeringens avi. Ska spegla transaktionens matchedRentNotice. */
  allocationNoticeId?: string
  reverseThrows?: boolean
  remainingAllocations?: Array<{ amount: number }>
  /** H3 PR A: allokeringarna avmatchningen ska plocka bort. Flera = vattenfall. */
  removedAllocations?: Array<{
    id: string
    rentNoticeId: string
    amount: Decimal
    paidAt: Date
    source: string
  }>
  noticeRow?: Record<string, unknown> | null
}) {
  const tx = {
    // #326 C — behandlingshistoriken på avi-sidan.
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },

    rentNotice: {
      // PR 3b — org-scopad updateMany (defense-in-depth), inte update på enbart id.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // PR 3b — unmatch läser avins skuldkomponenter för att avgöra reopen + paidAmount.
      findFirst: jest.fn().mockResolvedValue(
        opts.noticeRow === undefined
          ? {
              type: 'RENT',
              status: 'PAID',
              totalAmount: 7_000,
              consumptionAmount: 0,
              miscChargeAmount: 0,
              reminderFeeAmount: 0,
              interestAccruedAmount: 0,
            }
          : opts.noticeRow,
      ),
    },
    bankTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // Bankavstämnings-härdning PR 1/3b — allokeringen städas i samma transaktion;
    // findMany läser KVARVARANDE allokeringar för paidAmount-omräkningen.
    rentNoticePayment: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      // H3 PR A: #326 D:s läsning FÖRE raderingen är nu findMany (flera möjliga
      // allokeringar). Samma metod läser de kvarvarande — riggen skiljer dem åt
      // på where-satsen.
      findMany: jest.fn((args: { where?: Record<string, unknown> }) => {
        if (args?.where && 'bankTransactionId' in args.where) {
          return Promise.resolve(
            opts.removedAllocations ?? [
              {
                id: 'rnp-1',
                rentNoticeId: opts.allocationNoticeId ?? 'rn-1',
                amount: new Decimal(5000),
                paidAt: new Date('2026-07-20T00:00:00.000Z'),
                source: 'BANK_RECONCILIATION',
              },
            ],
          )
        }
        return Promise.resolve(opts.remainingAllocations ?? [])
      }),
    },
  }
  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(opts.transaction),
      updateMany: tx.bankTransaction.updateMany,
    },
    rentNotice: { updateMany: tx.rentNotice.updateMany },
    // Speglar Prisma $transaction: kör callbacken; kastar callbacken
    // propagerar felet (= rollback i verklig DB).
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const reverseJournalEntryForPayment = jest.fn(
    opts.reverseThrows
      ? () => Promise.reject(new Error('Kontoplan saknas'))
      : () => Promise.resolve(),
  )
  const accounting = { reverseJournalEntryForPayment }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    {} as never,
    accounting as never,
    {} as never, // PaymentFreshnessService — ej använd i unmatch-vägen,
    { record: jest.fn().mockResolvedValue({}) } as never, // #326 C — RentNoticeEventsService
  )
  return { service, prisma, tx, reverseJournalEntryForPayment }
}

const MATCHED_RENT_TX = {
  id: 'tx-1',
  status: 'MATCHED',
  invoice: null,
  matchedRentNotice: { id: 'rn-1', status: 'PAID' },
}

describe('ReconciliationService.unmatchTransaction — atomisk reversering (#33)', () => {
  it('awaitar reverseringen inne i transaktionen och återställer avi-status', async () => {
    const { service, tx, reverseJournalEntryForPayment } = makeService({
      transaction: MATCHED_RENT_TX,
    })

    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    // avi flippad SENT + nollställd (org-scopad updateMany)
    expect(tx.rentNotice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rn-1', organizationId: 'org-1' },
        data: { status: 'SENT', paidAt: null, paidAmount: null },
      }),
    )
    // reversering anropad MED transaktionsklienten (4:e argumentet) → atomiskt
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
    // #326 D — reverseringen får ALLOKERINGENS nyckel, inte bara transaktions-id.
    // Utan den letar den efter en post skrivaren aldrig skrev, hittar inget, och
    // blir en tyst no-op (`if (!original) return`).
    expect(reverseJournalEntryForPayment).toHaveBeenCalledWith(
      'tx-1',
      'org-1',
      'user-1',
      tx,
      'rent-notice-bank-payment:rnp-1',
    )

    // Bankavstämnings-härdning PR 1 — allokeringen raderas i SAMMA transaktion,
    // nycklad på bank-transaktionen (0 eller 1 rad).
    expect(tx.rentNoticePayment.deleteMany).toHaveBeenCalledWith({
      where: { bankTransactionId: 'tx-1' },
    })
  })

  it('propagerar felet om reverseringen fallerar (rullar tillbaka, sväljer ej)', async () => {
    const { service } = makeService({ transaction: MATCHED_RENT_TX, reverseThrows: true })
    await expect(service.unmatchTransaction('tx-1', 'org-1', 'user-1')).rejects.toThrow(
      'Kontoplan saknas',
    )
  })

  it('avvisar avmatchning av betald faktura (kreditnota krävs)', async () => {
    const { service, reverseJournalEntryForPayment } = makeService({
      transaction: {
        id: 'tx-2',
        status: 'MATCHED',
        invoice: { status: 'PAID' },
        matchedRentNotice: null,
      },
    })
    await expect(service.unmatchTransaction('tx-2', 'org-1', 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(reverseJournalEntryForPayment).not.toHaveBeenCalled()
  })

  it('avvisar omatchad transaktion', async () => {
    const { service } = makeService({
      transaction: { id: 'tx-3', status: 'UNMATCHED', invoice: null, matchedRentNotice: null },
    })
    await expect(service.unmatchTransaction('tx-3', 'org-1', 'user-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('är idempotent vid retry — reversering anropas igen (idempotent i accounting)', async () => {
    const { service, reverseJournalEntryForPayment } = makeService({ transaction: MATCHED_RENT_TX })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(2)
  })
})

// ── Bank-härdning PR 3b — granulär unmatch av en DELbetalning ───────────────────
describe('ReconciliationService.unmatchTransaction — partiell unmatch (PR 3b)', () => {
  it('avmatchar EN delbetalning på en fortfarande obetald avi → paidAmount = Σ kvarvarande, ingen reopen', async () => {
    // Avin är SENT (delbetald), en annan delbetalning på 5 000 finns kvar efter raderingen.
    const { service, tx, reverseJournalEntryForPayment } = makeService({
      transaction: {
        id: 'tx-part-2',
        status: 'MATCHED',
        invoice: null,
        matchedRentNotice: { id: 'rn-9', status: 'SENT' },
      },
      allocationNoticeId: 'rn-9',
      remainingAllocations: [{ amount: 5_000 }],
      noticeRow: {
        type: 'RENT',
        status: 'SENT',
        totalAmount: 8_000,
        consumptionAmount: 0,
        miscChargeAmount: 0,
        reminderFeeAmount: 0,
        interestAccruedAmount: 0,
      },
    })

    await service.unmatchTransaction('tx-part-2', 'org-1', 'user-1')

    // Bara denna transaktions allokering raderas (granulärt).
    expect(tx.rentNoticePayment.deleteMany).toHaveBeenCalledWith({
      where: { bankTransactionId: 'tx-part-2' },
    })
    // paidAmount räknas om till Σ KVARVARANDE (5 000), status rörs INTE (ej reopen).
    const upd = tx.rentNotice.updateMany.mock.calls[0]![0]
    expect(upd.where).toEqual({ id: 'rn-9', organizationId: 'org-1' })
    expect(Number(upd.data.paidAmount)).toBe(5_000)
    expect(upd.data.status).toBeUndefined()
    expect(upd.data.paidAt).toBeUndefined()
    expect(reverseJournalEntryForPayment).toHaveBeenCalledWith(
      'tx-part-2',
      'org-1',
      'user-1',
      tx,
      'rent-notice-bank-payment:rnp-1', // #326 D — allokeringens nyckel
    )
  })

  it('avmatchar SLUTbetalningen (avi PAID, prior delbetalning kvar) → reopen SENT + paidAmount = Σ kvarvarande', async () => {
    const { service, tx } = makeService({
      transaction: {
        id: 'tx-final',
        status: 'MATCHED',
        invoice: null,
        matchedRentNotice: { id: 'rn-10', status: 'PAID' },
      },
      allocationNoticeId: 'rn-10',
      remainingAllocations: [{ amount: 3_000 }],
      noticeRow: {
        type: 'RENT',
        status: 'PAID',
        totalAmount: 8_000,
        consumptionAmount: 0,
        miscChargeAmount: 0,
        reminderFeeAmount: 0,
        interestAccruedAmount: 0,
      },
    })

    await service.unmatchTransaction('tx-final', 'org-1', 'user-1')

    const upd = tx.rentNotice.updateMany.mock.calls[0]![0]
    // ocrOutstanding = 8 000 − 3 000 = 5 000 > 0 → PAID flippas tillbaka till SENT.
    expect(upd.data).toMatchObject({ status: 'SENT', paidAt: null })
    expect(Number(upd.data.paidAmount)).toBe(3_000)
  })
})

// ── H3 PR A: avmatchningen är N-MEDVETEN ─────────────────────────────────────
//
// Var `findFirst` — `RentNoticePayment.bankTransactionId` var @unique, så det
// kunde bara finnas 0 eller 1 allokering per banktransaktion. Vattenfallet
// (PR B) låter EN klumpbetalning fördelas över FLERA avier.
//
// Defekten som stängs här är osynlig så länge N är 1: `deleteMany` raderade
// redan ALLA allokeringar, medan bara den FÖRSTA reverserades. Med N > 1 hade
// avmatchningen lämnat N−1 motverifikat oskrivna — 1510 krediterad för
// betalningar vars allokeringar var borta.
//
// Testerna körs mot syntetisk data, eftersom N > 1 ännu inte kan uppstå.
describe('H3 PR A — avmatchning av flera allokeringar', () => {
  const flera = [
    {
      id: 'rnp-1',
      rentNoticeId: 'rn-1',
      amount: new Decimal(10_000),
      paidAt: new Date('2026-07-20T00:00:00.000Z'),
      source: 'BANK_RECONCILIATION',
    },
    {
      id: 'rnp-2',
      rentNoticeId: 'rn-2',
      amount: new Decimal(10_000),
      paidAt: new Date('2026-07-20T00:00:00.000Z'),
      source: 'BANK_RECONCILIATION',
    },
    {
      id: 'rnp-3',
      rentNoticeId: 'rn-3',
      amount: new Decimal(5_000),
      paidAt: new Date('2026-07-20T00:00:00.000Z'),
      source: 'BANK_RECONCILIATION',
    },
  ]

  it('KÄRNAN: ETT motverifikat per allokering — inte bara för den första', async () => {
    const { service, reverseJournalEntryForPayment } = makeService({
      transaction: MATCHED_RENT_TX,
      removedAllocations: flera,
    })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(3)
    const nycklar = (reverseJournalEntryForPayment.mock.calls as unknown[][]).map((c) => c[4])
    expect(nycklar).toEqual([
      'rent-notice-bank-payment:rnp-1',
      'rent-notice-bank-payment:rnp-2',
      'rent-notice-bank-payment:rnp-3',
    ])
  })

  it('paidAmount räknas om på VARJE berörd avi, inte bara spegelfältets', async () => {
    const { service, tx } = makeService({ transaction: MATCHED_RENT_TX, removedAllocations: flera })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    const uppdaterade = tx.rentNotice.updateMany.mock.calls
      .map((c) => (c[0] as { where: { id?: string } }).where.id)
      .filter((id): id is string => typeof id === 'string')
    for (const id of ['rn-1', 'rn-2', 'rn-3']) expect(uppdaterade).toContain(id)
  })

  it('N=1 är OFÖRÄNDRAT — en allokering, en reversering, en händelse', async () => {
    // Regressionsskyddet: dagens enda verkliga fall får inte bete sig annorlunda.
    const { service, reverseJournalEntryForPayment } = makeService({ transaction: MATCHED_RENT_TX })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    // Spåret ägs av unmatch-notice-event.spec.ts — här bevakas reverseringen.
    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
  })

  it('noll allokeringar → EN reversering utan nyckel (legacy-fallbacken bevaras)', async () => {
    // Poster skrivna före #326 D saknar allokeringsnyckel och reverseras på
    // transaktions-id. Den vägen får inte falla bort när listan är tom.
    const { service, reverseJournalEntryForPayment } = makeService({
      transaction: MATCHED_RENT_TX,
      removedAllocations: [],
    })
    await service.unmatchTransaction('tx-1', 'org-1', 'user-1')

    expect(reverseJournalEntryForPayment).toHaveBeenCalledTimes(1)
    expect((reverseJournalEntryForPayment.mock.calls as unknown[][])[0]![4]).toBeUndefined()
  })
})
