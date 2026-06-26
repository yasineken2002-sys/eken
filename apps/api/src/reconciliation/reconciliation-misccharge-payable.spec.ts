/**
 * Teknisk förvaltning · Spår A PR 4b — bankavstämningens fuzzy-gren (matchTransaction
 * rad ~705) måste inkludera miscChargeAmount i kandidatens betalbara total.
 *
 * HÖGSTA RISKEN i PR 4b: en hyresgäst betalar hyra + förbrukning + skada i EN
 * klumpsumma. Om miscChargeAmount missas i auto-match-filtret matchar betalningen
 * inte → avin förblir öppen → kravtrappan/inkasso eskalerar mot någon som FAKTISKT
 * betalat. Detta test bevisar:
 *   • En betalning som täcker total + förbrukning + skada + avgift auto-matchar.
 *   • En betalning som SAKNAR skadedelen matchar INTE (bevisar att miscChargeAmount
 *     verkligen ingår i kandidatsumman, inte bara råkar passera).
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    noticeNumber: 'AVI-2026-07-0001',
    organizationId: 'org-1',
    status: 'SENT',
    dueDate: new Date('2026-07-01'),
    totalAmount: new Decimal(8000), // hyra
    consumptionAmount: new Decimal(240), // förbrukning (IMD)
    miscChargeAmount: new Decimal(1500), // skada/nyckel (teknisk förvaltning)
    reminderFeeAmount: new Decimal(0),
    ...over,
  }
}

function makeService(candidates: Array<Record<string, unknown>>) {
  const db = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rentNotice: {
      // OCR-grenen hittar inget (transaktionen saknar rawOcr ändå) → fuzzy.
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(candidates),
    },
  }
  const service = new ReconciliationService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  const apply = jest.fn().mockResolvedValue(true)
  ;(service as unknown as { applyMatchToRentNotice: unknown }).applyMatchToRentNotice = apply
  return { service, db, apply }
}

// Ingen rawOcr → hoppar OCR-grenen, går direkt till fuzzy belopp+datum-matchning.
function tx(amount: number) {
  return {
    id: 't1',
    amount: new Decimal(amount),
    date: new Date('2026-07-15'),
    description: '',
    reference: '',
  }
}

describe('matchTransaction fuzzy — miscChargeAmount ingår i betalbar total (705)', () => {
  it('klumpbetalning (hyra+förbrukning+skada) auto-matchar avin', async () => {
    const { service, apply } = makeService([candidate()])
    // 8000 + 240 + 1500 + 0 = 9740
    const result = await service.matchTransaction(tx(9740) as never, 'org-1')
    expect(result).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][1]).toBe('n1') // rätt avi
  })

  it('betalning UTAN skadedelen matchar INTE (miscChargeAmount ingår verkligen)', async () => {
    const { service, apply } = makeService([candidate()])
    // 8000 + 240 + 0 (skada saknas) = 8240 → |9740 − 8240| = 1500 > tolerans (1)
    const result = await service.matchTransaction(tx(8240) as never, 'org-1')
    expect(result).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('avi utan skada (miscChargeAmount 0) matchar fortfarande på hyra+förbrukning', async () => {
    const { service, apply } = makeService([candidate({ miscChargeAmount: new Decimal(0) })])
    const result = await service.matchTransaction(tx(8240) as never, 'org-1')
    expect(result).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
