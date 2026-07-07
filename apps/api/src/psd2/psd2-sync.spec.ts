/**
 * Psd2SyncService — synk-kedjan mot MockBankDataProvider (ingen DB/nätverk):
 *   • hämtar råa transaktioner och matar dem genom ReconciliationService.ingestFromApi
 *     (den härdade vägen in — här mockad, INTE rörd),
 *   • räknar imported/duplicates/rejected/matched korrekt,
 *   • skriver en BankStatementImport-audit-post (fileType 'api'),
 *   • uppdaterar cursor + lastSyncedAt,
 *   • pausar när samtycket inte längre är aktivt (påverkar bara inflödet),
 *   • synk-scoping = organizationId ur BankConsent (status ACTIVE), aldrig ur råsvar.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Psd2SyncService } from './psd2-sync.service'
import { MockBankDataProvider } from './providers/mock-bank-data.provider'
import type { ProviderRawTx } from './psd2.types'

const TX = (externalId: string): ProviderRawTx => ({
  externalId,
  bookingDate: new Date('2026-05-01'),
  booked: true,
  currency: 'SEK',
  amount: 8500,
  description: 'Hyra',
  ocr: '00123459',
})

function makeService(provider = new MockBankDataProvider()) {
  const prisma = {
    bankConsent: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'bc-1', consentId: 'c-1', accessTokenEnc: 'enc', syncCursor: null },
        ]),
      update: jest.fn().mockResolvedValue({}),
    },
    bankStatementImport: { create: jest.fn().mockResolvedValue({}) },
  }
  const reconciliation = { ingestFromApi: jest.fn() }
  const crypto = { decrypt: jest.fn().mockReturnValue('access-token') }
  const service = new Psd2SyncService(
    prisma as never,
    reconciliation as never,
    crypto as never,
    provider,
  )
  return { service, provider, prisma, reconciliation, crypto }
}

describe('Psd2SyncService.syncOrganization', () => {
  it('matar transaktioner genom ingestFromApi och räknar utfall + audit-post', async () => {
    const { service, provider, prisma, reconciliation } = makeService()
    provider.transactions = [TX('ext-1'), TX('ext-2')]
    reconciliation.ingestFromApi.mockImplementation((_org: string, extId: string) =>
      extId === 'ext-1'
        ? Promise.resolve({ outcome: 'imported', transactionId: 't1', matched: true })
        : Promise.resolve({ outcome: 'duplicate', transactionId: 't0', via: 'externalId' }),
    )

    const result = await service.syncOrganization('org-1')

    // Scoping: aktiva samtycken för DENNA org.
    expect(prisma.bankConsent.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'ACTIVE' },
    })
    expect(reconciliation.ingestFromApi).toHaveBeenCalledTimes(2)
    // externalId + org kommer från oss, aldrig ur råsvaret.
    expect(reconciliation.ingestFromApi).toHaveBeenCalledWith('org-1', 'ext-1', expect.any(Object))
    expect(result.fetched).toBe(2)
    expect(result.imported).toBe(1)
    expect(result.matched).toBe(1)
    expect(result.duplicates).toBe(1)

    // Audit-paritet: BankStatementImport med fileType 'api'.
    expect(prisma.bankStatementImport.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fileType: 'api' }) }),
    )
    // Cursor + lastSyncedAt uppdaterade.
    expect(prisma.bankConsent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bc-1' },
        data: expect.objectContaining({ syncCursor: 'mock-cursor-1' }),
      }),
    )
  })

  it('rejected (t.ex. icke-SEK/storno) räknas explicit, aldrig tyst', async () => {
    const { service, provider, reconciliation } = makeService()
    provider.transactions = [TX('ext-3')]
    reconciliation.ingestFromApi.mockResolvedValue({ outcome: 'rejected', reason: 'NON_SEK' })

    const result = await service.syncOrganization('org-1')
    expect(result.rejected).toBe(1)
    expect(result.imported).toBe(0)
  })

  it('pausar synk när samtycket inte längre är aktivt (inget inflöde)', async () => {
    const provider = new MockBankDataProvider()
    provider.consentStatus = 'EXPIRED'
    const { service, prisma, reconciliation } = makeService(provider)
    provider.transactions = [TX('ext-1')]

    await service.syncOrganization('org-1')

    expect(reconciliation.ingestFromApi).not.toHaveBeenCalled() // inget inflöde
    expect(prisma.bankConsent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'EXPIRED' }) }),
    )
  })
})
