/**
 * T5 A2 (fail-closed, BFL 5:6) — en betalning får ALDRIG kreditera 1510 om
 * fordrans-debeten (accrual-verifikatet) aldrig bokförts (spökkredit). Bevisar
 * mot de RIKTIGA funktionerna (ingen mock av AccountingService):
 *   • frisk avi/faktura MED accrual → betalning bokförs balanserat (Σd=Σk),
 *   • orphan-avi/faktura UTAN accrual → NEKAS (kastar), ingen journalEntry.create,
 *   • DEPOSITIONSFAKTURA (accrual nycklad 'deposit-invoice:<id>') → bokförs UTAN
 *     falsk-nekan (regressionsskydd — FAR CRITICAL),
 *   • DEPOSIT-avi hoppar guarden (gatas av caller).
 */

import { UnprocessableEntityException } from '@nestjs/common'
import { AccountingService } from './accounting.service'

const ACCOUNTS = [
  { id: 'acc-1930', number: 1930 },
  { id: 'acc-1910', number: 1910 },
  { id: 'acc-1510', number: 1510 },
]

// opts.accruals = de sourceId:n som HAR ett accrual-verifikat (source='INVOICE').
// opts.deposit = länkad Deposit för fakturan (null = vanlig faktura).
function makeService(opts: { accruals?: string[]; deposit?: { id: string } | null }) {
  const accruals = new Set(opts.accruals ?? [])
  const created: Array<{ data: { lines: { create: Array<Record<string, unknown>> } } }> = []
  const prisma = {
    account: { findMany: jest.fn().mockResolvedValue(ACCOUNTS) },
    journalEntry: {
      findFirst: jest
        .fn()
        .mockImplementation((args: { where?: { source?: string; sourceId?: string } }) => {
          // Accrual-guarden slår upp source='INVOICE' + sourceId. PAYMENT-idempotens → null.
          if (args?.where?.source === 'INVOICE' && accruals.has(String(args.where.sourceId))) {
            return Promise.resolve({ id: 'accrual' })
          }
          return Promise.resolve(null)
        }),
      create: jest.fn().mockImplementation((arg: (typeof created)[number]) => {
        created.push(arg)
        return Promise.resolve({ id: 'je-pay', ...arg })
      }),
    },
    deposit: { findFirst: jest.fn().mockResolvedValue(opts.deposit ?? null) },
    rentNotice: { findFirst: jest.fn().mockResolvedValue(null) }, // counterparty → ingen
    invoice: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: (cb: (t: unknown) => unknown) => cb(prisma),
  }
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, created }
}

const NOTICE = { id: 'rn-1', noticeNumber: 'AVI-2026-06-0001' }
const INVOICE = { id: 'inv-1', invoiceNumber: 'F-2026-0001' }
const TXN = { id: 'bt-1', date: new Date('2026-06-10'), amount: 5000 } as never

function sumLines(lines: Array<Record<string, unknown>>) {
  let d = 0
  let c = 0
  for (const l of lines) {
    d += Number(l['debit'] ?? 0)
    c += Number(l['credit'] ?? 0)
  }
  return { d, c }
}

describe('T5 A2 · fail-closed accrual-guard på 1510-kreditering', () => {
  it('frisk hyresavi MED accrual → betalning bokförs balanserat (1930 D / 1510 K, Σd=Σk)', async () => {
    const { service, created } = makeService({ accruals: ['rent-notice:rn-1'] })
    const entry = await service.createJournalEntryForRentNoticePayment(NOTICE, TXN, 'org-1', null)

    expect(entry).not.toBeNull()
    expect(created).toHaveLength(1)
    const { d, c } = sumLines(created[0]!.data.lines.create)
    expect(d).toBe(5000)
    expect(c).toBe(5000)
  })

  it('orphan hyresavi UTAN accrual (bank) → NEKAS (kastar), ingen 1510-kredit', async () => {
    const { service, created } = makeService({ accruals: [] })
    await expect(
      service.createJournalEntryForRentNoticePayment(NOTICE, TXN, 'org-1', null),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
    expect(created).toHaveLength(0)
  })

  it('orphan hyresavi UTAN accrual (manuell) → NEKAS', async () => {
    const { service, created } = makeService({ accruals: [] })
    await expect(
      service.createJournalEntryForRentNoticeManualPayment(
        { ...NOTICE, type: 'RENT' as never },
        5000,
        new Date('2026-06-10'),
        'BANK' as never,
        'org-1',
        null,
        'alloc-1',
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
    expect(created).toHaveLength(0)
  })

  it('orphan faktura UTAN accrual (manuell) → NEKAS', async () => {
    const { service, created } = makeService({ accruals: [], deposit: null })
    await expect(
      service.createJournalEntryForInvoiceManualPayment(
        INVOICE,
        5000,
        new Date('2026-06-10'),
        'BANK' as never,
        'org-1',
        null,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
    expect(created).toHaveLength(0)
  })

  it('orphan faktura UTAN accrual (bankmatchning) → NEKAS', async () => {
    const { service, created } = makeService({ accruals: [], deposit: null })
    await expect(
      service.createJournalEntryForPayment(
        { ...INVOICE, total: 5000 as never },
        TXN,
        'org-1',
        null,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
    expect(created).toHaveLength(0)
  })

  it('frisk vanlig faktura MED accrual (invoice.id) → bokförs', async () => {
    const { service, created } = makeService({ accruals: ['inv-1'], deposit: null })
    const entry = await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      5000,
      new Date('2026-06-10'),
      'BANK' as never,
      'org-1',
      null,
    )
    expect(entry).not.toBeNull()
    expect(created).toHaveLength(1)
  })

  it('REGRESSIONSSKYDD: depositionsfaktura (accrual nycklad deposit-invoice:<id>) bokförs UTAN falsk-nekan', async () => {
    // invoice.id-accrual SAKNAS, men fakturan har en länkad Deposit vars
    // deposit-invoice-accrual finns → guarden ska ACCEPTERA (inte neka).
    const { service, created } = makeService({
      accruals: ['deposit-invoice:dep-1'],
      deposit: { id: 'dep-1' },
    })
    // manuell väg (deposits.markPaid)
    const m = await service.createJournalEntryForInvoiceManualPayment(
      INVOICE,
      5000,
      new Date('2026-06-10'),
      'BANK' as never,
      'org-1',
      null,
    )
    expect(m).not.toBeNull()
    // bankväg (applyMatchToInvoice fuzzy)
    const b = await service.createJournalEntryForPayment(
      { ...INVOICE, total: 5000 as never },
      { id: 'bt-2', date: new Date('2026-06-10'), amount: 5000 } as never,
      'org-1',
      null,
    )
    expect(b).not.toBeNull()
    expect(created).toHaveLength(2) // båda vägar bokförde depositionsbetalningen
  })

  it('deposit-manuell-betalning (avi-länkad) UTAN deposit-accrual → NEKAS (A2b sjätte vägen)', async () => {
    const { service, created } = makeService({ accruals: [] })
    await expect(
      service.createJournalEntryForDepositManualPayment(
        'dep-1',
        'org-1',
        5000,
        new Date('2026-06-10'),
        'BANK' as never,
        null,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException)
    expect(created).toHaveLength(0)
  })

  it('deposit-manuell-betalning MED deposit-accrual → bokförs (1930 D / 1510 K)', async () => {
    const { service, created } = makeService({ accruals: ['deposit-invoice:dep-1'] })
    const entry = await service.createJournalEntryForDepositManualPayment(
      'dep-1',
      'org-1',
      5000,
      new Date('2026-06-10'),
      'BANK' as never,
      null,
    )
    expect(entry).not.toBeNull()
    expect(created).toHaveLength(1)
  })

  it('DEPOSIT-avi hoppar guarden (gatas av caller) → bokförs även utan rent-accrual', async () => {
    const { service, created } = makeService({ accruals: [] })
    const entry = await service.createJournalEntryForRentNoticePayment(
      { ...NOTICE, type: 'DEPOSIT' as never },
      TXN,
      'org-1',
      null,
    )
    expect(entry).not.toBeNull()
    expect(created).toHaveLength(1)
  })
})
