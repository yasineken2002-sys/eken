/**
 * P0-refaktor (PSD2-förberedelse): den delade ingest-kärnan `ingestFromFile`.
 * Bevisar att den EXAKT återger filimportens pipeline — fält-dedup → create →
 * matchTransaction — och att organizationId injiceras här (aldrig från raw).
 * Den härdade matchTransaction (#161-166) mockas bort; detta test rör bara vägen in.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

function makeService(bankTransaction: { findFirst: jest.Mock; create: jest.Mock }) {
  const prisma = { bankTransaction }
  const service = new ReconciliationService(
    prisma as never,
    {} as never, // invoices
    {} as never, // events
    {} as never, // accounting
    {} as never, // freshness
  )
  return service
}

const INPUT = {
  dedup: { date: new Date('2026-05-01'), description: 'Hyra', amount: new Decimal('8500.00') },
  data: { date: new Date('2026-05-01'), description: 'Hyra', amount: new Decimal('8500.00') },
}

describe('ReconciliationService.ingestFromFile — delad ingest-kärna', () => {
  it('dubblett: fält-dedup träffar → {duplicate:true}, ingen create, ingen matchning', async () => {
    const bankTransaction = {
      findFirst: jest.fn().mockResolvedValue({ id: 'befintlig' }),
      create: jest.fn(),
    }
    const service = makeService(bankTransaction)
    const matchSpy = jest.spyOn(service, 'matchTransaction')

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result).toEqual({ duplicate: true })
    expect(bankTransaction.create).not.toHaveBeenCalled()
    expect(matchSpy).not.toHaveBeenCalled()
  })

  it('ny + matchad: create → matchTransaction=true → {duplicate:false, matched:true}', async () => {
    const bankTransaction = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(true)

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result).toEqual({ duplicate: false, transactionId: 'tx-1', matched: true })
  })

  it('ny + omatchad: matchTransaction=false → matched:false, ingen matchError', async () => {
    const bankTransaction = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'tx-2' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(false)

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result).toEqual({ duplicate: false, transactionId: 'tx-2', matched: false })
  })

  it('matchfel: matchTransaction kastar → raden skapad, matchError returneras (kastar EJ)', async () => {
    const bankTransaction = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'tx-3' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockRejectedValue(new Error('korrupt journal'))

    const result = await service.ingestFromFile('org-1', INPUT)

    expect(result.duplicate).toBe(false)
    if (result.duplicate === false) {
      expect(result.transactionId).toBe('tx-3')
      expect(result.matched).toBe(false)
      expect(result.matchError?.message).toBe('korrupt journal')
    }
  })

  it('injicerar organizationId i BÅDE dedup och create (aldrig från raw)', async () => {
    const bankTransaction = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'tx-4' }),
    }
    const service = makeService(bankTransaction)
    jest.spyOn(service, 'matchTransaction').mockResolvedValue(true)

    await service.ingestFromFile('org-42', INPUT)

    expect(bankTransaction.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-42', ...INPUT.dedup },
    })
    expect(bankTransaction.create).toHaveBeenCalledWith({
      data: { organizationId: 'org-42', ...INPUT.data },
    })
  })
})
