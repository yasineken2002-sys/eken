/**
 * #36 — per-org konfigurerbar beloppsrimlighetsgräns (Organization.maxBankTxAmount).
 *
 * Verifierar:
 *   • resolveMaxTxAmount läser org-värdet, clampar till absolut tak (MAX_TX_AMOUNT,
 *     50 MSEK) och faller tillbaka till default (5 MSEK) vid saknad org / orimligt värde.
 *   • sanitizeEdited (confirm-vägen) respekterar den injicerade per-org-gränsen.
 */

// Mocka tunga moduler för att bryta den transitiva import-kedjan till AWS-SDK
// (reconciliation.service → invoices → pdf → storage → @aws-sdk/client-s3),
// samma mönster som övriga import-specs. Konstanterna speglar de riktiga.
jest.mock('./pdf-statement-parser.service', () => ({
  PdfStatementParserService: class {},
  MAX_TX_AMOUNT: 50_000_000,
  DEFAULT_MAX_BANK_TX_AMOUNT: 5_000_000,
}))
jest.mock('./reconciliation.service', () => ({ ReconciliationService: class {} }))

import { BankStatementImportService } from './bank-statement-import.service'
import { MAX_TX_AMOUNT, DEFAULT_MAX_BANK_TX_AMOUNT } from './pdf-statement-parser.service'

interface ServiceAccess {
  resolveMaxTxAmount(organizationId: string): Promise<number>
  sanitizeEdited(edited: unknown[], maxTxAmount?: number): Array<{ amount: number }>
}

function makeService(orgRow?: { maxBankTxAmount: number } | null) {
  const prisma = {
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue(orgRow === undefined ? { maxBankTxAmount: 5_000_000 } : orgRow),
    },
  }
  const service = new BankStatementImportService(prisma as never, {} as never, {} as never)
  return { service: service as unknown as ServiceAccess, prisma }
}

describe('#36 — resolveMaxTxAmount (per-org gräns med clamp/fallback)', () => {
  it('returnerar det konfigurerade org-värdet', async () => {
    const { service } = makeService({ maxBankTxAmount: 2_000_000 })
    expect(await service.resolveMaxTxAmount('org-1')).toBe(2_000_000)
  })

  it('clampar till absolut tak (MAX_TX_AMOUNT) om org-värdet är högre', async () => {
    const { service } = makeService({ maxBankTxAmount: 99_000_000 })
    expect(await service.resolveMaxTxAmount('org-1')).toBe(MAX_TX_AMOUNT)
  })

  it('faller tillbaka till default när orgen inte hittas', async () => {
    const { service } = makeService(null)
    expect(await service.resolveMaxTxAmount('org-saknas')).toBe(DEFAULT_MAX_BANK_TX_AMOUNT)
  })

  it('faller tillbaka till default vid orimligt värde (<= 0)', async () => {
    const { service } = makeService({ maxBankTxAmount: 0 })
    expect(await service.resolveMaxTxAmount('org-1')).toBe(DEFAULT_MAX_BANK_TX_AMOUNT)
  })

  it('scopar uppslaget på organisationen', async () => {
    const { service, prisma } = makeService({ maxBankTxAmount: 3_000_000 })
    await service.resolveMaxTxAmount('org-42')
    expect(prisma.organization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-42' } }),
    )
  })
})

describe('#36 — sanitizeEdited respekterar per-org-gräns', () => {
  it('avvisar belopp över den injicerade gränsen, behåller under', () => {
    const { service } = makeService()
    const out = service.sanitizeEdited(
      [
        { date: '2026-05-01', description: 'Stor', ocr: null, amount: 3_000_000 },
        { date: '2026-05-02', description: 'Liten', ocr: null, amount: 1500 },
      ],
      2_000_000,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.amount).toBe(1500)
  })

  it('en högre gräns släpper igenom större legitima belopp', () => {
    const { service } = makeService()
    const out = service.sanitizeEdited(
      [{ date: '2026-05-01', description: 'Kommersiell', ocr: null, amount: 8_000_000 }],
      20_000_000,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.amount).toBe(8_000_000)
  })
})
