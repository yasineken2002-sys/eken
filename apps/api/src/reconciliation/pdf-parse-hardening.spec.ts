/**
 * SECURITY (RISK 2) — PDF-bankavstämningens AI-output valideras strikt så att
 * en prompt-injicerad/fabricerad transaktion inte når bokföringen.
 *
 * Verifierar validate():
 *   • OCR som inte är Luhn-mod10-giltig nollställs (kan inte auto-matcha avi)
 *   • giltig OCR behålls
 *   • orimligt stora belopp (> 50 MSEK) avvisas
 *   • rader med ogiltigt datum/belopp släpps
 *   • giltiga rader behålls
 */

import { PdfStatementParserService } from './pdf-statement-parser.service'

interface ValidateAccess {
  validate(
    input: unknown,
    maxTxAmount?: number,
  ): {
    transactions: Array<{ date: string; ocr: string | null; amount: number; description: string }>
  }
}

function makeService() {
  const service = new PdfStatementParserService(
    { get: jest.fn().mockReturnValue('') } as never,
    {} as never,
    {} as never,
  )
  return service as unknown as ValidateAccess
}

describe('PdfStatementParserService.validate — hardening (RISK 2)', () => {
  it('nollställer OCR med ogiltig Luhn-kontrollsiffra', () => {
    const out = makeService().validate({
      transactions: [
        { date: '2026-05-01', description: 'Hyra', ocr: '12345', amount: 1000, isIncoming: true },
      ],
    })
    expect(out.transactions).toHaveLength(1)
    expect(out.transactions[0]!.ocr).toBeNull()
  })

  it('behåller en giltig (Luhn-korrekt) OCR', () => {
    const out = makeService().validate({
      transactions: [
        {
          date: '2026-05-01',
          description: 'Hyra',
          ocr: '00123459',
          amount: 1000,
          isIncoming: true,
        },
      ],
    })
    expect(out.transactions[0]!.ocr).toBe('00123459')
  })

  it('avvisar orimligt stora belopp (default-gräns 5 MSEK)', () => {
    const out = makeService().validate({
      transactions: [
        {
          date: '2026-05-01',
          description: 'Injektion',
          ocr: null,
          amount: 99_000_000,
          isIncoming: true,
        },
        { date: '2026-05-02', description: 'Riktig', ocr: null, amount: 12000, isIncoming: true },
      ],
    })
    expect(out.transactions).toHaveLength(1)
    expect(out.transactions[0]!.amount).toBe(12000)
  })

  // #36 — per-org konfigurerbar gräns trådas in i validate().
  it('respekterar en lägre per-org-gräns (avvisar belopp över taket)', () => {
    const out = makeService().validate(
      {
        transactions: [
          {
            date: '2026-05-01',
            description: 'Stor',
            ocr: null,
            amount: 3_000_000,
            isIncoming: true,
          },
          { date: '2026-05-02', description: 'Liten', ocr: null, amount: 1500, isIncoming: true },
        ],
      },
      2_000_000, // org-gräns 2 MSEK → 3 MSEK avvisas
    )
    expect(out.transactions).toHaveLength(1)
    expect(out.transactions[0]!.amount).toBe(1500)
  })

  it('en högre per-org-gräns släpper igenom större legitima belopp', () => {
    const out = makeService().validate(
      {
        transactions: [
          {
            date: '2026-05-01',
            description: 'Kommersiell',
            ocr: null,
            amount: 8_000_000,
            isIncoming: true,
          },
        ],
      },
      20_000_000, // org-gräns 20 MSEK → 8 MSEK accepteras (default 5 MSEK hade avvisat)
    )
    expect(out.transactions).toHaveLength(1)
    expect(out.transactions[0]!.amount).toBe(8_000_000)
  })

  it('släpper rader med ogiltigt datum eller belopp', () => {
    const out = makeService().validate({
      transactions: [
        { date: 'inte-datum', description: 'x', amount: 100 },
        { date: '2026-05-01', description: 'y', amount: 'NaN' },
        { date: '2026-05-03', description: 'ok', ocr: null, amount: 500, isIncoming: true },
      ],
    })
    expect(out.transactions).toHaveLength(1)
    expect(out.transactions[0]!.date).toBe('2026-05-03')
  })
})
