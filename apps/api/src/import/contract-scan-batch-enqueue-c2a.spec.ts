/**
 * T5 C2a — per-rad-isolering vid köandet i batch-kontraktsskanningen.
 *
 * Kommentaren i createBatch lovade sedan tidigare att ett Redis-fel fångas
 * "per rad", men koden hade ingen try/catch: rad N:s kö-fel kastade ur hela
 * metoden, raderna efter N köades aldrig, anroparen fick 500 och batchen låg
 * kvar halvköad utan larm. Nu gör koden det kommentaren lovar.
 *
 * Bevisar:
 *   A) En rads kö-fel isoleras — ALLA rader försöks, övriga köas.
 *   B) Batchen returneras (metoden kastar inte) och raderna står kvar PENDING,
 *      alltså re-enqueue-bara.
 *   C) Varje misslyckad rad larmas till Sentry med kö-/jobbtyp-/org-tagg.
 *   D) Normalfallet är opåverkat: inget larm.
 */

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

import * as Sentry from '@sentry/nestjs'
import { ContractScanBatchService } from './contract-scan-batch.service'

const captureException = Sentry.captureException as jest.MockedFunction<
  typeof Sentry.captureException
>

function pdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${tag}`)
}

function make(enqueueRow: jest.Mock) {
  const rows = [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }]
  const prisma = {
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ maxContractBatchFiles: 50, maxContractBatchCostSek: 50 }),
    },
    contractImportBatch: {
      create: jest.fn().mockResolvedValue({
        id: 'batch-1',
        status: 'PENDING',
        totalRows: rows.length,
        rows,
      }),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    contractImportRow: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    unit: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockResolvedValue([]),
  }
  const quota = { checkOrgDailyCostCap: jest.fn().mockResolvedValue(undefined) }
  const service = new ContractScanBatchService(
    prisma as never,
    quota as never,
    { enqueueRow } as never,
    { createWithTenant: jest.fn() } as never,
  )
  const files = rows.map((_, i) => ({ fileName: `k${i}.pdf`, buffer: pdf(String(i)) }))
  return { service, prisma, files }
}

describe('T5 C2a · contract-scan-batch köar rad för rad med isolering', () => {
  beforeEach(() => jest.clearAllMocks())

  it('A+B: rad 2:s kö-fel stoppar inte rad 3 — batchen returneras ändå', async () => {
    const enqueueRow = jest
      .fn()
      .mockResolvedValueOnce('job-1')
      .mockRejectedValueOnce(new Error('MaxRetriesPerRequestError'))
      .mockResolvedValueOnce('job-3')
    const { service, files } = make(enqueueRow)

    const batch = await service.createBatch(files, 'org-1', 'user-1')

    // Alla tre försöktes — loopen bröts inte av rad 2.
    expect(enqueueRow).toHaveBeenCalledTimes(3)
    expect(enqueueRow.mock.calls.map((c) => (c[0] as { rowId: string }).rowId)).toEqual([
      'row-1',
      'row-2',
      'row-3',
    ])
    // Metoden kastar inte: batchen finns, raderna står PENDING (re-enqueue-bara).
    expect(batch).toMatchObject({ id: 'batch-1', status: 'PENDING', totalRows: 3 })
  })

  it('C: den misslyckade raden larmas med kö-, jobbtyp- och org-tagg', async () => {
    const enqueueRow = jest
      .fn()
      .mockResolvedValueOnce('job-1')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:6379'))
      .mockResolvedValueOnce('job-3')
    const { service, files } = make(enqueueRow)

    await service.createBatch(files, 'org-1', 'user-1')

    expect(captureException).toHaveBeenCalledTimes(1)
    const [captured, ctx] = captureException.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ]
    expect(ctx.tags).toEqual({
      queue: 'contract-scan-batch',
      jobType: 'contract-scan-row',
      org: 'org-1',
    })
    expect(captured.message).not.toContain('ECONNREFUSED')
  })

  it('D: normalfallet — alla rader köas, inget larm', async () => {
    const enqueueRow = jest.fn().mockResolvedValue('job-x')
    const { service, files } = make(enqueueRow)

    await service.createBatch(files, 'org-1', 'user-1')

    expect(enqueueRow).toHaveBeenCalledTimes(3)
    expect(captureException).not.toHaveBeenCalled()
  })
})
