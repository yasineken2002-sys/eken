/**
 * A + B (avi-sidan) — cancelNotice vänder kapital, avgift OCH ränta.
 *
 * Avins krav är fem komponenter (computeRentDebt: kapital + förbrukning + övrig
 * debitering + avgift + ränta) utspridda på fem nyckelrymder i huvudboken.
 * Annulleringen vände tidigare EN av dem. Reskontran släppte samtidigt hela avin
 * — `OverdueDebtService` läser bara `status = 'OVERDUE'` — så 3593 och 8131 blev
 * kvar med intäkter vars fordran ingen längre kräver in.
 *
 * Det här specet bevakar KOPPLINGEN (att båda anropen sker, i rätt namnrymd, i
 * samma transaktion). Vad anropen gör med kontosaldona bevisas i
 * accounting.fee-interest-reversal.spec.ts och i bevisriggen mot riktig Postgres.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

const NOTICE_ID = 'rn-9'
const ORG_ID = 'org-1'

function makeService() {
  const ordning: string[] = []
  const notice = {
    id: NOTICE_ID,
    noticeNumber: 'A-2026-0009',
    status: 'OVERDUE',
    collectionStage: 'REMINDED',
    paidAmount: null,
    type: 'RENT',
    probableLossAt: null,
    writtenOffAt: null,
  }

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: {
      updateMany: jest.fn(() => {
        ordning.push('annullera-avi')
        return Promise.resolve({ count: 1 })
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
    // F+E: charges lossas vid annullering. Ingen charge i de här fallen.
    rentNoticeLine: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    consumptionCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    miscCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  }
  const prisma = {
    rentNotice: { findFirst: jest.fn().mockResolvedValue(notice) },
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
    // #518 — cancelNotice läser krediteringarna före annulleringen.
    rentNoticeCredit: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const spår = (namn: string) =>
    jest.fn((..._a: unknown[]) => {
      ordning.push(namn)
      return Promise.resolve(undefined)
    })
  const reverseJournalEntryForRentNotice = spår('kapital')
  const reverseJournalEntryForReminderFee = spår('avgift')
  const reverseJournalEntryForInterest = spår('ränta')

  const service = Object.create(AviseringService.prototype) as AviseringService
  const anyService = service as unknown as Record<string, unknown>
  anyService['prisma'] = prisma
  anyService['accounting'] = {
    reverseJournalEntryForRentNotice,
    reverseJournalEntryForReminderFee,
    reverseJournalEntryForInterest,
    reverseJournalEntryForDepositAccrual: jest.fn().mockResolvedValue(undefined),
  }
  anyService['logger'] = { error: jest.fn(), log: jest.fn(), warn: jest.fn() }

  return {
    service,
    tx,
    ordning,
    reverseJournalEntryForRentNotice,
    reverseJournalEntryForReminderFee,
    reverseJournalEntryForInterest,
  }
}

describe('A+B (avi) — cancelNotice vänder alla tre nyckelrymderna', () => {
  it('anropar kapital, avgift och ränta — inte bara kapitalet', async () => {
    const {
      service,
      reverseJournalEntryForRentNotice,
      reverseJournalEntryForReminderFee,
      reverseJournalEntryForInterest,
    } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(reverseJournalEntryForRentNotice).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForReminderFee).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForInterest).toHaveBeenCalledTimes(1)
  })

  it('avgiften slås upp med source RENT_NOTICE — inte INVOICE som på fakturasidan', async () => {
    // Nyckeln skiljer sig på TVÅ axlar mellan dokumenttyperna. Skickas fel source
    // blir uppslaget en tyst no-op mot det unika indexet (org, source, sourceId).
    const { service, reverseJournalEntryForReminderFee } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    const args = reverseJournalEntryForReminderFee.mock.calls[0] as unknown[]
    expect(args[0]).toBe('RENT_NOTICE')
    expect(args[0]).not.toBe('INVOICE')
    expect(args[1]).toBe(NOTICE_ID)
    expect(args[2]).toBe(ORG_ID)
    expect(args[3]).toBe('Annullerad hyresavi')
    expect(args[4]).toBe('user-1')
  })

  it('räntan tar AVINS id och inget source-argument (den finns bara här)', async () => {
    const { service, reverseJournalEntryForInterest } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    const args = reverseJournalEntryForInterest.mock.calls[0] as unknown[]
    expect(args[0]).toBe(NOTICE_ID)
    expect(args[1]).toBe(ORG_ID)
    expect(args[2]).toBe('Annullerad hyresavi')
  })

  it('ATOMISKT: båda får transaktionsklienten, inte prisma bredvid den', async () => {
    // Läxan från #288 — faller någon av reverseringarna ska statusflippen rullas
    // tillbaka. Attrappens tx är ETT EGET objekt, skilt från prisma.
    const { service, tx, reverseJournalEntryForReminderFee, reverseJournalEntryForInterest } =
      makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect((reverseJournalEntryForReminderFee.mock.calls[0] as unknown[])[5]).toBe(tx)
    expect((reverseJournalEntryForInterest.mock.calls[0] as unknown[])[4]).toBe(tx)
  })

  it('ordningen är kapital → avgift → ränta, efter att avin annullerats', async () => {
    const { service, ordning } = makeService()

    await service.cancelNotice(NOTICE_ID, ORG_ID, 'user-1')

    expect(ordning).toEqual(['annullera-avi', 'kapital', 'avgift', 'ränta'])
  })
})
