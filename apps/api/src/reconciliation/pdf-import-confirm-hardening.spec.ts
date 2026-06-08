/**
 * SECURITY (RISK 2, CRITICAL — fångat av bokforings-expert) — confirm-vägen
 * (sanitizeEdited) måste tillämpa SAMMA OCR-Luhn- och beloppsskydd som parserns
 * validate(). Annars kan en MANAGER+ kringgå parser-skyddet genom att skicka en
 * fabricerad OCR/belopp i confirm-bodyn → fabricerad betalning bokförs.
 */

jest.mock('./pdf-statement-parser.service', () => ({
  PdfStatementParserService: class {},
  MAX_TX_AMOUNT: 50_000_000,
  DEFAULT_MAX_BANK_TX_AMOUNT: 5_000_000,
}))
jest.mock('./reconciliation.service', () => ({ ReconciliationService: class {} }))

import { BankStatementImportService } from './bank-statement-import.service'

interface SanitizeAccess {
  sanitizeEdited(edited: unknown[]): Array<{
    date: string
    ocr: string | null
    amount: number
  }>
}

function makeService() {
  const service = new BankStatementImportService({} as never, {} as never, {} as never, {} as never)
  return service as unknown as SanitizeAccess
}

describe('BankStatementImportService.sanitizeEdited — confirm-vägens skydd (RISK 2)', () => {
  it('nollställer fabricerad/ogiltig OCR i confirm-bodyn', () => {
    const out = makeService().sanitizeEdited([
      { date: '2026-05-01', description: 'x', ocr: '12345', amount: 1000 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.ocr).toBeNull()
  })

  it('behåller en Luhn-giltig OCR', () => {
    const out = makeService().sanitizeEdited([
      { date: '2026-05-01', description: 'x', ocr: '00123459', amount: 1000 },
    ])
    expect(out[0]!.ocr).toBe('00123459')
  })

  it('avvisar orimligt belopp även vid confirm', () => {
    const out = makeService().sanitizeEdited([
      { date: '2026-05-01', description: 'x', ocr: null, amount: 99_000_000 },
      { date: '2026-05-02', description: 'ok', ocr: null, amount: 5000 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.amount).toBe(5000)
  })
})
