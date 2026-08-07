/**
 * #301 — cancelNotice reverserar depositionsavins accrual, och tar Deposit-låset först.
 *
 * DEN HÄR FILEN FINNS FÖR ATT FAR-GRANSKNINGEN HITTADE ETT HÅL: den befintliga
 * cancelNotice-sviten (avisering.markaspaid.spec.ts) attrapperar `$queryRaw` med
 * `mockResolvedValue([])`. Eftersom #301-grenen gatar på `depositForNotice.length > 0`
 * kördes hela den nya logiken ALDRIG där — testerna passerade tyst förbi den.
 *
 * Just den grenen är den mest kostsamma att tappa: avi-låset är BEVISAT
 * load-bearing (utan det gav 22 av 30 parallella körningar 1510 debet 20 000 /
 * kredit 40 000, TROTS CANCELLED-spärren i markPaid). Utan ett test i den
 * ordinarie sviten kunde en framtida ändring bryta den och lämna `pnpm test` grön
 * medan penningfelet återuppstår.
 *
 * Låsets EFFEKT (serialisering) kan inte modelleras med attrapper — den bevisas i
 * bevisriggen mot riktig Postgres. Här bevakas det som GÅR att bevaka: att låset
 * tas, att det tas FÖRST, att uppslaget sker i rätt namnrymd, och att grinden
 * släpper igenom exakt de depositionsstatusar den ska.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

const NOTICE_ID = 'rn-1'
const DEPOSIT_ID = 'dep-7'

function makeService(opts: { depositStatus?: string | null; noticeStatus?: string } = {}) {
  const ordning: string[] = []

  const notice = {
    id: NOTICE_ID,
    noticeNumber: 'A-2026-0001',
    status: opts.noticeStatus ?? 'SENT',
    collectionStage: 'NONE',
    paidAmount: null,
    type: 'DEPOSIT',
  }

  const tx = {
    // Deposit-radlåset. Returnerar en rad → #301-grenen aktiveras.
    $queryRaw: jest.fn((..._a: unknown[]) => {
      ordning.push('lås-deposition')
      return Promise.resolve(opts.depositStatus === null ? [] : [{ id: DEPOSIT_ID }])
    }),
    rentNotice: {
      updateMany: jest.fn((..._a: unknown[]) => {
        ordning.push('annullera-avi')
        return Promise.resolve({ count: 1 })
      }),
    },
    deposit: {
      findFirst: jest.fn((..._a: unknown[]) => {
        ordning.push('läs-deposition')
        return Promise.resolve(
          opts.depositStatus === null
            ? null
            : { id: DEPOSIT_ID, status: opts.depositStatus ?? 'PENDING' },
        )
      }),
    },
  }

  const prisma = {
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(notice),
    },
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const reverseJournalEntryForRentNotice = jest.fn((..._a: unknown[]) => {
    ordning.push('reversera-avi-intäkt')
    return Promise.resolve(undefined)
  })
  const reverseJournalEntryForDepositAccrual = jest.fn((..._a: unknown[]) => {
    ordning.push('reversera-deposition')
    return Promise.resolve(undefined)
  })

  const service = Object.create(AviseringService.prototype) as AviseringService
  const anyService = service as unknown as Record<string, unknown>
  anyService['prisma'] = prisma
  anyService['accounting'] = {
    reverseJournalEntryForRentNotice,
    reverseJournalEntryForDepositAccrual,
    // A+B: avgiftens och räntans motverifikat. Stubbade här — deras
    // beteende bevisas i accounting.fee-interest-reversal.spec.ts och i
    // bevisriggen, inte av att den här attrappen råkar finnas.
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForInterest: jest.fn().mockResolvedValue(undefined),
  }
  anyService['logger'] = { error: jest.fn(), log: jest.fn(), warn: jest.fn() }

  return {
    service,
    tx,
    prisma,
    ordning,
    reverseJournalEntryForRentNotice,
    reverseJournalEntryForDepositAccrual,
  }
}

describe('#301 — cancelNotice reverserar depositionsavins accrual', () => {
  it('reverserar BÅDA namnrymderna: avins intäkt (no-op) och depositionens accrual', async () => {
    const { service, reverseJournalEntryForRentNotice, reverseJournalEntryForDepositAccrual } =
      makeService()

    await service.cancelNotice(NOTICE_ID, 'org-1', 'user-1')

    // Den befintliga vägen anropas som förut — för en DEPOSIT-avi är den en no-op,
    // eftersom avin aldrig intäktsbokförts under `rent-notice:<id>`.
    expect(reverseJournalEntryForRentNotice).toHaveBeenCalledTimes(1)
    // …och den nya tar depositionens namnrymd.
    expect(reverseJournalEntryForDepositAccrual).toHaveBeenCalledTimes(1)
    const args = reverseJournalEntryForDepositAccrual.mock.calls[0] as unknown[]
    // DEPOSITIONENS id, inte avins. Hela poängen med #301.
    expect(args[0]).toBe(DEPOSIT_ID)
    expect(args[0]).not.toBe(NOTICE_ID)
    expect(args[1]).toBe('org-1')
    expect(args[2]).toBe('Annullerad hyresavi')
    expect(args[3]).toBe('user-1')
  })

  it('LÅSORDNING: depositionen låses FÖRST, före avin rörs (Deposit → RentNotice)', async () => {
    // Samma riktning som markPaids avi-gren, medvetet MOTSATT bankvägen (#299).
    // Lade vi låset efter rentNotice-uppdateringen fick vi en ABBA mot markPaid
    // utan att stänga racet — deadlock i stället för spärr.
    const { service, tx, ordning } = makeService()

    await service.cancelNotice(NOTICE_ID, 'org-1', 'user-1')

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(ordning[0]).toBe('lås-deposition')
    expect(ordning.indexOf('lås-deposition')).toBeLessThan(ordning.indexOf('annullera-avi'))
    expect(ordning.indexOf('lås-deposition')).toBeLessThan(ordning.indexOf('läs-deposition'))
    // Reverseringen sker EFTER att avin annullerats, i samma transaktion.
    expect(ordning.indexOf('annullera-avi')).toBeLessThan(ordning.indexOf('reversera-deposition'))
  })

  it('atomiskt: reverseringen får transaktionsklienten, inte prisma bredvid den', async () => {
    // Läxan från #288 — attrappens tx är ETT EGET objekt, skilt från prisma.
    const { service, tx, reverseJournalEntryForDepositAccrual } = makeService()

    await service.cancelNotice(NOTICE_ID, 'org-1', 'user-1')

    const args = reverseJournalEntryForDepositAccrual.mock.calls[0] as unknown[]
    expect(args[4]).toBe(tx)
  })

  it('SPÄRR: deposition som inte är PENDING → INGEN reversering', async () => {
    // 1930 D / 1510 K är redan bokfört; en reversering skulle kreditera 1510 en
    // andra gång. PENDING är en allow-list, inte en deny-list — allt annat blockas.
    for (const status of [
      'PAID',
      'REFUNDED',
      'REFUND_PENDING',
      'PARTIALLY_REFUNDED',
      'FORFEITED',
    ]) {
      const { service, reverseJournalEntryForDepositAccrual } = makeService({
        depositStatus: status,
      })

      await service.cancelNotice(NOTICE_ID, 'org-1', 'user-1')

      expect(reverseJournalEntryForDepositAccrual).not.toHaveBeenCalled()
    }
  })

  it('vanlig hyresavi utan deposition → bara den befintliga reverseringen', async () => {
    const { service, reverseJournalEntryForRentNotice, reverseJournalEntryForDepositAccrual } =
      makeService({ depositStatus: null })

    await service.cancelNotice(NOTICE_ID, 'org-1', 'user-1')

    expect(reverseJournalEntryForRentNotice).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForDepositAccrual).not.toHaveBeenCalled()
  })
})
