/**
 * PR1 batch-kontraktsskanning — tjänstelogik.
 *
 * Fokus: batch-taket (antal + estimerad kostnad + daglig backstop) stoppar en
 * körning INNAN något enqueueas; rå PDF lämnar aldrig servern via GET; avbryt
 * purgar filerna; worker-callbacks är idempotenta och återuppväcker aldrig en
 * avbruten batch. Ingen väg skapar avtal (det kommer i PR3).
 */

import { BadRequestException } from '@nestjs/common'
import { ContractScanBatchService } from './contract-scan-batch.service'
import type { ScannedContract } from './contract-scanner.service'

function pdf(bytes = 'fake hyreskontrakt'): Buffer {
  return Buffer.from(`%PDF-1.4\n${bytes}`)
}

interface Mocks {
  prisma: {
    organization: { findUnique: jest.Mock }
    contractImportBatch: {
      create: jest.Mock
      findFirst: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
    }
    contractImportRow: {
      findUnique: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      count: jest.Mock
    }
    $transaction: jest.Mock
  }
  quota: { checkOrgDailyCostCap: jest.Mock }
  queue: { enqueueRow: jest.Mock }
}

function make(overrides?: { maxFiles?: number; maxCostSek?: number; capThrows?: boolean }) {
  const mocks: Mocks = {
    prisma: {
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          maxContractBatchFiles: overrides?.maxFiles ?? 50,
          maxContractBatchCostSek: overrides?.maxCostSek ?? 50,
        }),
      },
      contractImportBatch: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      contractImportRow: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    },
    quota: {
      checkOrgDailyCostCap: overrides?.capThrows
        ? jest.fn().mockRejectedValue(new BadRequestException('daglig budget slut'))
        : jest.fn().mockResolvedValue(undefined),
    },
    queue: { enqueueRow: jest.fn().mockResolvedValue('job-1') },
  }
  const service = new ContractScanBatchService(
    mocks.prisma as never,
    mocks.quota as never,
    mocks.queue as never,
  )
  return { service, mocks }
}

describe('ContractScanBatchService.createBatch — batch-tak', () => {
  it('avvisar en tom uppladdning', async () => {
    const { service, mocks } = make()
    await expect(service.createBatch([], 'org-1', 'user-1')).rejects.toThrow(BadRequestException)
    expect(mocks.prisma.contractImportBatch.create).not.toHaveBeenCalled()
    expect(mocks.queue.enqueueRow).not.toHaveBeenCalled()
  })

  it('avvisar fler filer än per-org-filtaket — inget skapas/enqueueas', async () => {
    const { service, mocks } = make({ maxFiles: 2 })
    const files = [pdf('a'), pdf('b'), pdf('c')].map((b, i) => ({
      fileName: `k${i}.pdf`,
      buffer: b,
    }))
    await expect(service.createBatch(files, 'org-1', 'user-1')).rejects.toThrow(/För många filer/)
    expect(mocks.prisma.contractImportBatch.create).not.toHaveBeenCalled()
    expect(mocks.queue.enqueueRow).not.toHaveBeenCalled()
  })

  it('avvisar en icke-PDF (magic-byte) innan något skapas', async () => {
    const { service, mocks } = make()
    const files = [
      { fileName: 'ok.pdf', buffer: pdf() },
      { fileName: 'evil.pdf', buffer: Buffer.from('<html>not a pdf</html>') },
    ]
    await expect(service.createBatch(files, 'org-1', 'user-1')).rejects.toThrow(/Fil 2/)
    expect(mocks.prisma.contractImportBatch.create).not.toHaveBeenCalled()
  })

  it('avvisar när estimerad kostnad överstiger kostnadstaket', async () => {
    const { service, mocks } = make({ maxCostSek: 0.0001 })
    const files = [{ fileName: 'k.pdf', buffer: pdf() }]
    await expect(service.createBatch(files, 'org-1', 'user-1')).rejects.toThrow(/överstiger taket/)
    expect(mocks.prisma.contractImportBatch.create).not.toHaveBeenCalled()
  })

  it('avvisar när den dagliga org-kostnadsbromsen redan slagit till', async () => {
    const { service, mocks } = make({ capThrows: true })
    const files = [{ fileName: 'k.pdf', buffer: pdf() }]
    await expect(service.createBatch(files, 'org-1', 'user-1')).rejects.toThrow(BadRequestException)
    expect(mocks.prisma.contractImportBatch.create).not.toHaveBeenCalled()
    expect(mocks.queue.enqueueRow).not.toHaveBeenCalled()
  })

  it('happy path: skapar batch och enqueuear en rad per fil', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportBatch.create.mockResolvedValue({
      id: 'batch-1',
      status: 'PENDING',
      totalRows: 2,
      rows: [{ id: 'row-1' }, { id: 'row-2' }],
    })
    const files = [
      { fileName: 'a.pdf', buffer: pdf('a') },
      { fileName: 'b.pdf', buffer: pdf('b') },
    ]
    const result = await service.createBatch(files, 'org-1', 'user-1')

    expect(result.id).toBe('batch-1')
    expect(result.totalRows).toBe(2)
    expect(result.estimatedCostSek).toBeGreaterThan(0)
    expect(mocks.queue.enqueueRow).toHaveBeenCalledTimes(2)
    expect(mocks.queue.enqueueRow).toHaveBeenCalledWith({ rowId: 'row-1', organizationId: 'org-1' })

    // Den råa PDF:en lagras på raden (transient) men taket gällde innan.
    const created = mocks.prisma.contractImportBatch.create.mock.calls[0][0]
    expect(created.data.rows.create[0].fileData).toBeInstanceOf(Buffer)
    expect(created.data.fileCapApplied).toBe(50)
  })
})

describe('ContractScanBatchService.getBatch — ingen rå PDF läcker', () => {
  it('org-scopar och returnerar aldrig fileData', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportBatch.findFirst.mockResolvedValue({
      id: 'batch-1',
      status: 'SCANNED',
      totalRows: 1,
      scannedRows: 1,
      failedRows: 0,
      estimatedCostSek: 0.5,
      createdAt: new Date('2026-06-04'),
      rows: [
        {
          id: 'row-1',
          fileName: 'a.pdf',
          fileSize: 1234,
          rowStatus: 'SCANNED',
          confidence: 0.9,
          reviewedData: { tenantName: 'Anna' },
          errorMessage: null,
        },
      ],
    })

    const view = await service.getBatch('batch-1', 'org-1')

    // org-scoping
    expect(mocks.prisma.contractImportBatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'batch-1', organizationId: 'org-1' } }),
    )
    // det valda select-objektet får aldrig innehålla fileData
    const arg = mocks.prisma.contractImportBatch.findFirst.mock.calls[0][0]
    expect(arg.select.rows.select.fileData).toBeUndefined()
    // resultatet exponerar ingen fileData-nyckel
    expect(view.rows[0]).not.toHaveProperty('fileData')
    expect(view.rows[0]!.confidence).toBe(0.9)
  })
})

describe('ContractScanBatchService.cancelBatch — purgar rå PDF', () => {
  it('sätter CANCELLED och nollar fileData på alla rader', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportBatch.findFirst.mockResolvedValue({
      id: 'batch-1',
      status: 'SCANNED',
    })

    const result = await service.cancelBatch('batch-1', 'org-1')

    expect(result.status).toBe('CANCELLED')
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mocks.prisma.contractImportRow.updateMany).toHaveBeenCalledWith({
      where: { batchId: 'batch-1' },
      data: { fileData: null },
    })
  })

  it('är idempotent om batchen redan är CANCELLED', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportBatch.findFirst.mockResolvedValue({
      id: 'batch-1',
      status: 'CANCELLED',
    })
    const result = await service.cancelBatch('batch-1', 'org-1')
    expect(result.status).toBe('CANCELLED')
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('ContractScanBatchService — worker-callbacks (idempotens)', () => {
  it('claimRowForScan returnerar null för en redan SCANNAD rad', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({
      rowStatus: 'SCANNED',
      fileData: Buffer.from('x'),
      batch: { status: 'SCANNING', uploadedById: 'u1' },
    })
    expect(await service.claimRowForScan('row-1')).toBeNull()
    expect(mocks.prisma.contractImportRow.update).not.toHaveBeenCalled()
  })

  it('claimRowForScan returnerar null när batchen är avbruten', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({
      rowStatus: 'PENDING',
      fileData: Buffer.from('x'),
      batch: { status: 'CANCELLED', uploadedById: 'u1' },
    })
    expect(await service.claimRowForScan('row-1')).toBeNull()
    expect(mocks.prisma.contractImportRow.update).not.toHaveBeenCalled()
  })

  it('recordScanResult lagrar oföränderlig originalScanData + redigerbar reviewedData', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({ batchId: 'batch-1' })
    mocks.prisma.contractImportBatch.findUnique.mockResolvedValue({
      totalRows: 1,
      status: 'SCANNING',
    })
    mocks.prisma.contractImportRow.count.mockResolvedValue(1) // 1 scanned

    const scan = { tenantName: 'Anna', confidence: 0.8 } as ScannedContract
    await service.recordScanResult('row-1', scan)

    const update = mocks.prisma.contractImportRow.update.mock.calls[0][0]
    expect(update.data.rowStatus).toBe('SCANNED')
    expect(update.data.originalScanData).toEqual(scan)
    expect(update.data.reviewedData).toEqual(scan)
    expect(update.data.confidence).toBe(0.8)
    // GDPR: råa PDF:en purgas direkt vid lyckad skanning.
    expect(update.data.fileData).toBeNull()
  })

  it('recomputeBatch återuppväcker aldrig en CANCELLED batch', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({ batchId: 'batch-1' })
    mocks.prisma.contractImportBatch.findUnique.mockResolvedValue({
      totalRows: 2,
      status: 'CANCELLED',
    })
    mocks.prisma.contractImportRow.count.mockResolvedValue(1)

    await service.recordScanFailure('row-1', 'fel')

    // raden markeras FAILED, men batch-statusen rörs inte (ingen update mot batch).
    expect(mocks.prisma.contractImportRow.update).toHaveBeenCalled()
    expect(mocks.prisma.contractImportBatch.update).not.toHaveBeenCalled()
  })
})
