/**
 * #301 — VOID-grenen reverserar depositionsfakturans accrual, och tar radlåset först.
 *
 * En DEPOSIT-faktura går aldrig genom InvoicesService.create(), så den befintliga
 * reverseJournalEntryForInvoice (som söker sourceId=<invoiceId>) är alltid en
 * no-op för den. Accrualen ligger under `deposit-invoice:<depositId>` och nås bara
 * via ett uppslag på depositionen.
 *
 * DISKRIMINERANDE TESTDATA: fakturans id ('inv-1') och depositionens id ('dep-9')
 * är OLIKA strängar, och depositionen har ett belopp som skiljer sig från fakturans
 * total. Sammanföll de kunde ett test inte se skillnad på vilken nyckel som användes
 * — samma klass av blindhet som #290:s `create → {}`.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { InvoicesService } from './invoices.service'

function makeService(
  opts: { deposit?: { id: string; status: string } | null; status?: string } = {},
) {
  const ordning: string[] = []
  const invoiceRow = { id: 'inv-1', status: opts.status ?? 'DRAFT', invoiceNumber: 'F-2026-0001' }

  const tx = {
    $queryRaw: jest.fn((..._a: unknown[]) => {
      ordning.push('lås-faktura')
      return Promise.resolve([])
    }),
    invoice: {
      findFirst: jest.fn().mockResolvedValue(invoiceRow),
      update: jest.fn().mockResolvedValue(invoiceRow),
    },
    invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
    deposit: {
      findFirst: jest.fn((..._a: unknown[]) => {
        ordning.push('läs-deposition')
        return Promise.resolve(
          opts.deposit === undefined ? { id: 'dep-9', status: 'PENDING' } : opts.deposit,
        )
      }),
    },
  }
  const prisma = { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)) }

  const reverseJournalEntryForInvoice = jest.fn((..._a: unknown[]) => {
    ordning.push('reversera-faktura')
    return Promise.resolve(undefined)
  })
  const reverseJournalEntryForDepositAccrual = jest.fn((..._a: unknown[]) => {
    ordning.push('reversera-deposition')
    return Promise.resolve(undefined)
  })

  const service = new InvoicesService(
    prisma as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    { reverseJournalEntryForInvoice, reverseJournalEntryForDepositAccrual } as never,
    { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
  )
  return {
    service,
    tx,
    ordning,
    reverseJournalEntryForInvoice,
    reverseJournalEntryForDepositAccrual,
  }
}

describe('#301 — transitionStatus(VOID) reverserar depositionens accrual', () => {
  it('reverserar BÅDA namnrymderna: fakturans intäkt och depositionens accrual', async () => {
    const { service, tx, reverseJournalEntryForInvoice, reverseJournalEntryForDepositAccrual } =
      makeService()

    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')

    // Den befintliga vägen rörs inte — den anropas precis som förut.
    expect(reverseJournalEntryForInvoice).toHaveBeenCalledTimes(1)
    // …och den nya tar depositionens namnrymd.
    expect(reverseJournalEntryForDepositAccrual).toHaveBeenCalledTimes(1)
    const args = reverseJournalEntryForDepositAccrual.mock.calls[0] as unknown[]
    // DEPOSITIONENS id, inte fakturans. Hela poängen med #301.
    expect(args[0]).toBe('dep-9')
    expect(args[0]).not.toBe('inv-1')
    expect(args[1]).toBe('org-1')
    expect(args[2]).toBe('Makulerad faktura')
    expect(args[3]).toBe('user-1')
    // Atomiskt: transaktionsklienten skickas med som sista argument, så en
    // misslyckad reversering rullar tillbaka statusflippen (läxan från #288 —
    // attrappens tx är ETT EGET objekt, skilt från prisma).
    expect(args[4]).toBe(tx)
  })

  it('#302 LÅSORDNING: fakturan låses FÖRST, före varje läsning beslutet vilar på', async () => {
    // Låset kom i #302, inte #301 — det stänger ett TILLSTÅNDSFEL (faktura VOID
    // trots registrerad betalning), inte en spökkredit. Riktningen är
    // Invoice → Deposit, samma som markPaid och applyMatchToInvoice. Ingen väg
    // tar Deposit → Invoice; den ABBA:n togs bort i #293.
    const { service, ordning, tx } = makeService()

    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(ordning[0]).toBe('lås-faktura')
    expect(ordning.indexOf('lås-faktura')).toBeLessThan(ordning.indexOf('läs-deposition'))
  })

  it('SPÄRR: deposition som inte är PENDING → INGEN reversering', async () => {
    // 1930 D / 1510 K är redan bokfört; en reversering skulle kreditera 1510 en
    // andra gång. Grindar på depositionens EGEN status, inte på en spegel.
    // PENDING är en allow-list, inte en deny-list — PARTIALLY_REFUNDED är därför
    // blockerad by construction, men listas explicit så matrisen syns i testet.
    for (const status of [
      'PAID',
      'REFUNDED',
      'REFUND_PENDING',
      'PARTIALLY_REFUNDED',
      'FORFEITED',
    ]) {
      const { service, reverseJournalEntryForDepositAccrual } = makeService({
        deposit: { id: 'dep-9', status },
      })

      await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')

      expect(reverseJournalEntryForDepositAccrual).not.toHaveBeenCalled()
    }
  })

  it('vanlig faktura utan deposition → bara den befintliga reverseringen', async () => {
    const { service, reverseJournalEntryForInvoice, reverseJournalEntryForDepositAccrual } =
      makeService({ deposit: null })

    await service.transitionStatus('inv-1', 'org-1', 'VOID', 'user-1', 'USER')

    expect(reverseJournalEntryForInvoice).toHaveBeenCalledTimes(1)
    expect(reverseJournalEntryForDepositAccrual).not.toHaveBeenCalled()
  })

  it('icke-VOID-övergång rör ingen reversering alls', async () => {
    const { service, reverseJournalEntryForInvoice, reverseJournalEntryForDepositAccrual } =
      makeService({ status: 'DRAFT' })

    await service.transitionStatus('inv-1', 'org-1', 'SENT', 'user-1', 'USER')

    expect(reverseJournalEntryForInvoice).not.toHaveBeenCalled()
    expect(reverseJournalEntryForDepositAccrual).not.toHaveBeenCalled()
  })
})
