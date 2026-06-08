/**
 * IMD · PR 4 + bank-härdning PR 3b — bankavstämningens RENT-gren delegerar till
 * applyMatchToRentNotice med det FAKTISKA transaktionsbeloppet.
 *
 * Tidigare gjorde matchTransaction en ±1 kr-grind mot betalbar total (hyra +
 * förbrukning + avgift) och avvisade allt annat. Med PR 3b flyttas klassificeringen
 * (full / partiell / överbetalning mot avins AKTUELLA ocrOutstanding — som inkluderar
 * förbrukning och påminnelseavgift) ATOMISKT in i applyMatchToRentNotice. Här verifieras
 * bara DELEGERINGEN: att den deterministiska OCR-grenen anropar applyMatchToRentNotice
 * med (org, transaction.amount, allowPartial=true). Själva belopps­klassificeringen
 * (inkl. att förbrukning/avgift ingår i restskulden) testas mot den RIKTIGA
 * applyMatchToRentNotice i reconciliation-payment-allocation.spec.ts.
 */
// reconciliation.service drar transitivt in StorageService (→ @aws-sdk, ESM som
// jest inte transformerar) via InvoicesService/PdfService. Mocka bort dem.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

function notice(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    noticeNumber: 'AVI-2026-07-0001',
    organizationId: 'org-1',
    status: 'SENT',
    totalAmount: new Decimal(8000), // hyra
    consumptionAmount: new Decimal(240), // förbrukning (IMD)
    reminderFeeAmount: new Decimal(0), // påminnelseavgift (inkasso PR 2), default 0
    ...over,
  }
}

function makeService(noticeRow: Record<string, unknown> | null) {
  const db = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(noticeRow),
      findMany: jest.fn().mockResolvedValue([]),
    },
  }
  const service = new ReconciliationService(db as never, {} as never, {} as never, {} as never)
  const apply = jest.fn().mockResolvedValue(true)
  // Isolera matchningslogiken: ersätt den privata appliceringen med en spion.
  ;(service as unknown as { applyMatchToRentNotice: unknown }).applyMatchToRentNotice = apply
  return { service, db, apply }
}

function tx(amount: number) {
  return {
    id: 't1',
    rawOcr: '1234567890',
    amount: new Decimal(amount),
    date: new Date('2026-07-15'),
    description: '',
    reference: '',
  }
}

describe('matchTransaction — RENT-gren delegerar med faktiskt belopp (PR 3b)', () => {
  it('OCR-kandidat funnen → applyMatchToRentNotice anropas med (org, transaction.amount, allowPartial=true)', async () => {
    const { service, apply } = makeService(notice())

    const result = await service.matchTransaction(tx(8240) as never, 'org-1')

    expect(result).toBe(true)
    const [txId, noticeId, orgId, amount, , userId, allowPartial] = apply.mock.calls[0]
    expect(txId).toBe('t1')
    expect(noticeId).toBe('n1')
    expect(orgId).toBe('org-1')
    // FAKTISKT transaktionsbelopp skickas vidare — INTE en förberäknad payable.
    expect(Number(amount as Decimal)).toBe(8240)
    expect(userId).toBeNull()
    expect(allowPartial).toBe(true)
  })

  it('DELbelopp (8000 < restskuld) delegeras nu också — klassas partiellt INNE i applyMatchToRentNotice', async () => {
    // Tidigare grind avvisade detta i matchTransaction; nu delegeras det och den
    // riktiga applyMatchToRentNotice avgör (partiell allokering).
    const { service, apply } = makeService(notice())

    const result = await service.matchTransaction(tx(8000) as never, 'org-1')

    expect(result).toBe(true)
    expect(Number(apply.mock.calls[0][3] as Decimal)).toBe(8000)
  })

  it('ren hyra utan förbrukning delegeras med rätt belopp', async () => {
    const { service, apply } = makeService(notice({ consumptionAmount: new Decimal(0) }))

    const result = await service.matchTransaction(tx(8000) as never, 'org-1')

    expect(result).toBe(true)
    expect(Number(apply.mock.calls[0][3] as Decimal)).toBe(8000)
  })

  it('ingen OCR-kandidat → ingen RENT-delegering (faller vidare till fuzzy/UNMATCHED)', async () => {
    const { service, apply } = makeService(null)

    await service.matchTransaction(tx(8240) as never, 'org-1')

    expect(apply).not.toHaveBeenCalled()
  })
})
