/**
 * BFL 5 kap 7 § (#35) — betalningsverifikatets beskrivning ska ange motparten
 * direkt, inte bara faktura-/avinumret. BFN:s allmänna råd till 5 kap 7 § anger
 * att motparten bör framgå om det kan ske utan svårigheter.
 *
 * Täcker bankmatchnings-vägarna:
 *   • createJournalEntryForPayment              (faktura, auto-match)
 *   • createJournalEntryForRentNoticePayment    (hyresavi, auto-match)
 *
 * Den manuella avi-betalningen testas i accounting.rentnotice-payment.spec.ts.
 */

import { AccountingService } from './accounting.service'

type Tenant = { companyName: string | null; firstName: string | null; lastName: string | null }

type Created = { data: { description?: string; lines: { create: Array<Record<string, unknown>> } } }

function makeService(opts: { kind: 'invoice' | 'rentNotice'; tenant?: Tenant | null }) {
  const accounts = [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-1930', number: 1930 },
  ]
  let created: Created | null = null
  const findUnique = jest
    .fn()
    .mockResolvedValue(opts.tenant !== undefined ? { tenant: opts.tenant } : null)
  const prisma = {
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((arg: Created) => {
        created = arg
        return Promise.resolve({ id: 'je-1', ...arg })
      }),
    },
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    invoice: { findFirst: opts.kind === 'invoice' ? findUnique : jest.fn() },
    rentNotice: { findFirst: opts.kind === 'rentNotice' ? findUnique : jest.fn() },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, getCreated: () => created }
}

const txn = { id: 'tx-1', date: new Date('2026-06-01T00:00:00.000Z'), amount: 8500 as never }

describe('BFL 5 kap 7 § (#35) — motpart i betalningsverifikat', () => {
  describe('createJournalEntryForPayment (faktura)', () => {
    const invoice = { id: 'inv-1', invoiceNumber: 'F-2026-0042', total: 8500 as never }

    it('företag: skriver companyName i beskrivningen', async () => {
      const { service, getCreated } = makeService({
        kind: 'invoice',
        tenant: { companyName: 'Tenant AB', firstName: null, lastName: null },
      })
      await service.createJournalEntryForPayment(invoice, txn, 'org-1', null)
      expect(getCreated()!.data.description).toBe('Inbetalning faktura F-2026-0042 (Tenant AB)')
    })

    it('privatperson: faller tillbaka till för- och efternamn', async () => {
      const { service, getCreated } = makeService({
        kind: 'invoice',
        tenant: { companyName: null, firstName: 'Erik', lastName: 'Svensson' },
      })
      await service.createJournalEntryForPayment(invoice, txn, 'org-1', null)
      expect(getCreated()!.data.description).toBe('Inbetalning faktura F-2026-0042 (Erik Svensson)')
    })

    it('faktura utan tenant → ingen parentes', async () => {
      const { service, getCreated } = makeService({ kind: 'invoice', tenant: null })
      await service.createJournalEntryForPayment(invoice, txn, 'org-1', null)
      expect(getCreated()!.data.description).toBe('Inbetalning faktura F-2026-0042')
    })

    it('motpartsuppslaget är org-scopat (FIX 2 — multi-tenant-isolering)', async () => {
      const { service, prisma } = makeService({
        kind: 'invoice',
        tenant: { companyName: 'Tenant AB', firstName: null, lastName: null },
      })
      await service.createJournalEntryForPayment(invoice, txn, 'org-1', null)
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv-1', organizationId: 'org-1' } }),
      )
    })
  })

  describe('createJournalEntryForRentNoticePayment (hyresavi auto-match)', () => {
    const notice = { id: 'rn-1', noticeNumber: 'AVI-2026-06-0001', totalAmount: 8500 as never }

    it('skriver motpartsnamnet i beskrivningen', async () => {
      const { service, getCreated } = makeService({
        kind: 'rentNotice',
        tenant: { companyName: 'Hyresgäst AB', firstName: null, lastName: null },
      })
      await service.createJournalEntryForRentNoticePayment(notice, txn, 'org-1', null)
      expect(getCreated()!.data.description).toBe(
        'Inbetalning hyresavi AVI-2026-06-0001 (Hyresgäst AB)',
      )
    })

    it('namn saknas → ingen tom parentes', async () => {
      const { service, getCreated } = makeService({
        kind: 'rentNotice',
        tenant: { companyName: null, firstName: null, lastName: null },
      })
      await service.createJournalEntryForRentNoticePayment(notice, txn, 'org-1', null)
      expect(getCreated()!.data.description).toBe('Inbetalning hyresavi AVI-2026-06-0001')
    })
  })
})
