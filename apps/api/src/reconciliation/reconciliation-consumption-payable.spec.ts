/**
 * IMD · PR 4 — bankavstämning matchar mot BETALBAR total (hyra + förbrukning).
 *
 * När förbrukning ligger som rad på hyresavin betalar hyresgästen EN summa med
 * ETT OCR = totalAmount (hyra) + consumptionAmount. matchTransaction måste
 * jämföra och reglera mot den summan — annars landar betalningen som UNMATCHED
 * och 1510-fordran (hyresverifikat + förbrukningsverifikat) blir aldrig reglerad.
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

describe('matchTransaction — betalbar total (OCR-match)', () => {
  it('matchar när betalningen = hyra + förbrukning (8240) och reglerar hela summan', async () => {
    const { service, apply } = makeService(notice())

    const result = await service.matchTransaction(tx(8240) as never, 'org-1')

    expect(result).toBe(true)
    // applyMatchToRentNotice anropas med betalbar total (8240), inte bara hyran.
    const passedAmount = apply.mock.calls[0][2] as Decimal
    expect(Number(passedAmount)).toBe(8240)
  })

  it('matchar INTE när betalningen bara täcker hyran (8000) — förbrukning saknas', async () => {
    const { service, apply } = makeService(notice())

    const result = await service.matchTransaction(tx(8000) as never, 'org-1')

    expect(result).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('utan förbrukning (consumptionAmount 0) matchar ren hyra som vanligt', async () => {
    const { service, apply } = makeService(notice({ consumptionAmount: new Decimal(0) }))

    const result = await service.matchTransaction(tx(8000) as never, 'org-1')

    expect(result).toBe(true)
    expect(Number(apply.mock.calls[0][2] as Decimal)).toBe(8000)
  })

  // Inkasso PR 2: en påmind avi (reminderFeeAmount 60) har en 1510-fordran på
  // hyra + förbrukning + avgift. Bankavstämningen måste matcha och reglera HELA
  // summan (8300), annars blir avgiften kvar som ett glapp på 1510.
  it('påmind avi: betalbar total inkluderar påminnelseavgiften (8300)', async () => {
    const { service, apply } = makeService(notice({ reminderFeeAmount: new Decimal(60) }))

    const result = await service.matchTransaction(tx(8300) as never, 'org-1')

    expect(result).toBe(true)
    expect(Number(apply.mock.calls[0][2] as Decimal)).toBe(8300)
  })

  it('påmind avi: betalning som bara täcker hyra+förbrukning (8240) matchar INTE', async () => {
    const { service, apply } = makeService(notice({ reminderFeeAmount: new Decimal(60) }))

    const result = await service.matchTransaction(tx(8240) as never, 'org-1')

    expect(result).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })
})
