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
      findFirst: jest.Mock
      findMany: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      count: jest.Mock
    }
    unit: { findMany: jest.Mock }
    $transaction: jest.Mock
  }
  quota: { checkOrgDailyCostCap: jest.Mock }
  queue: { enqueueRow: jest.Mock }
  leases: { createWithTenant: jest.Mock }
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
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        // Default: atomiska claim-låset lyckas (count=1).
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      unit: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockResolvedValue([]),
    },
    quota: {
      checkOrgDailyCostCap: overrides?.capThrows
        ? jest.fn().mockRejectedValue(new BadRequestException('daglig budget slut'))
        : jest.fn().mockResolvedValue(undefined),
    },
    queue: { enqueueRow: jest.fn().mockResolvedValue('job-1') },
    leases: { createWithTenant: jest.fn().mockResolvedValue({ id: 'lease-1' }) },
  }
  const service = new ContractScanBatchService(
    mocks.prisma as never,
    mocks.quota as never,
    mocks.queue as never,
    mocks.leases as never,
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
          matchStatus: 'AUTO_MATCHED',
          matchedUnitId: 'u1',
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
    // matchningsförslaget exponeras (PR2)
    expect(view.rows[0]!.matchStatus).toBe('AUTO_MATCHED')
    expect(view.rows[0]!.matchedUnitId).toBe('u1')
  })

  it('lazy-backfillar SCANNED-rader utan matchStatus vid hämtning', async () => {
    const { service, mocks } = make()
    // En orörd PR1-rad utan matchStatus.
    mocks.prisma.contractImportRow.findMany.mockResolvedValueOnce([{ id: 'row-1' }])
    // matchRow läser raden:
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      rowStatus: 'SCANNED',
      reviewedData: { propertyAddress: 'X', unitDescription: '1', confidence: 0.9 },
      confidence: 0.9,
    })
    mocks.prisma.unit.findMany.mockResolvedValue([]) // → NO_MATCH
    mocks.prisma.contractImportBatch.findFirst.mockResolvedValue({
      id: 'batch-1',
      status: 'SCANNED',
      totalRows: 1,
      scannedRows: 1,
      failedRows: 0,
      estimatedCostSek: 0.2,
      createdAt: new Date('2026-06-04'),
      rows: [],
    })

    await service.getBatch('batch-1', 'org-1')

    // backfill körde matchRow → raden uppdaterades med ett matchStatus
    expect(mocks.prisma.contractImportRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-1' } }),
    )
    // unmatched-frågan org-scopas
    expect(mocks.prisma.contractImportRow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          batchId: 'batch-1',
          organizationId: 'org-1',
          rowStatus: 'SCANNED',
          matchStatus: null,
        },
      }),
    )
  })
})

describe('ContractScanBatchService.matchRow — deterministiskt förslag', () => {
  it('org-scopar kandidat-Units och skriver AUTO_MATCHED + matchedUnitId', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      rowStatus: 'SCANNED',
      reviewedData: {
        propertyAddress: 'Storgatan 1, 114 51 Stockholm',
        unitDescription: '1201',
      },
      confidence: 0.9,
    })
    mocks.prisma.unit.findMany.mockResolvedValue([
      {
        id: 'u1',
        unitNumber: '1201',
        property: { street: 'Storgatan 1', postalCode: '11451', city: 'Stockholm' },
      },
    ])

    await service.matchRow('row-1')

    // matchningen får ALDRIG korsa org — kandidaterna scopas via Property.
    expect(mocks.prisma.unit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { property: { organizationId: 'org-1' } } }),
    )
    expect(mocks.prisma.contractImportRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { matchStatus: 'AUTO_MATCHED', matchedUnitId: 'u1' },
    })
  })

  it('är no-op för en rad som inte är SCANNED (matchar aldrig en failad/pending rad)', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      rowStatus: 'FAILED',
      reviewedData: null,
      confidence: null,
    })

    await service.matchRow('row-1')

    expect(mocks.prisma.unit.findMany).not.toHaveBeenCalled()
    expect(mocks.prisma.contractImportRow.update).not.toHaveBeenCalled()
  })

  it('skriver NO_MATCH när inga kandidat-Units finns i org', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      rowStatus: 'SCANNED',
      reviewedData: { propertyAddress: 'Storgatan 1, Stockholm', unitDescription: '1201' },
      confidence: 0.9,
    })
    mocks.prisma.unit.findMany.mockResolvedValue([])

    await service.matchRow('row-1')

    expect(mocks.prisma.contractImportRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { matchStatus: 'NO_MATCH', matchedUnitId: null },
    })
  })
})

describe('ContractScanBatchService — PR3 commit (avtal skapas via /leases/with-tenant)', () => {
  const fullScan = {
    tenantName: 'Anna Andersson',
    tenantType: 'INDIVIDUAL',
    tenantEmail: 'anna@example.se',
    monthlyRent: 12000,
    startDate: '2026-07-01',
    confidence: 0.95,
  }

  function scannedRow(over: Record<string, unknown> = {}) {
    return {
      rowStatus: 'SCANNED',
      matchStatus: 'AUTO_MATCHED',
      matchedUnitId: 'unit-1',
      reviewedData: { ...fullScan },
      createdLeaseId: null,
      ...over,
    }
  }

  it('per-rad commit: AUTO_MATCHED → skapar avtal + markerar COMMITTED', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(scannedRow())
    mocks.leases.createWithTenant.mockResolvedValue({ id: 'lease-9' })
    mocks.prisma.contractImportBatch.findUnique.mockResolvedValue({ status: 'SCANNED' })

    const res = await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')

    expect(res).toEqual({ rowId: 'row-1', leaseId: 'lease-9', alreadyCommitted: false })
    // avtalet skapas org-scopat med den matchade enheten
    const [dto, orgId] = mocks.leases.createWithTenant.mock.calls[0]
    expect(orgId).toBe('org-1')
    expect(dto.unitId).toBe('unit-1')
    expect(dto.activate).toBe(false) // utkast, ingen massaktivering
    // raden fryses som COMMITTED + idempotensnyckel
    expect(mocks.prisma.contractImportRow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-1' },
        data: expect.objectContaining({ rowStatus: 'COMMITTED', createdLeaseId: 'lease-9' }),
      }),
    )
  })

  it('IDEMPOTENS: en redan committad rad skapar aldrig ett nytt avtal', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(
      scannedRow({ rowStatus: 'COMMITTED', createdLeaseId: 'lease-existing' }),
    )

    const res = await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')

    expect(res).toEqual({ rowId: 'row-1', leaseId: 'lease-existing', alreadyCommitted: true })
    expect(mocks.leases.createWithTenant).not.toHaveBeenCalled()
  })

  it('RACE: förlorar det atomiska låset (count=0) → skapar inget andra avtal', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst
      .mockResolvedValueOnce(scannedRow()) // initial läsning: SCANNED, ej committad
      .mockResolvedValueOnce({ createdLeaseId: 'lease-from-winner' }) // re-läsning efter förlorat lås
    mocks.prisma.contractImportRow.updateMany.mockResolvedValueOnce({ count: 0 }) // någon annan vann

    const res = await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')

    expect(res).toEqual({
      rowId: 'row-1',
      leaseId: 'lease-from-winner',
      alreadyCommitted: true,
    })
    expect(mocks.leases.createWithTenant).not.toHaveBeenCalled()
  })

  it('DUBBLETTSKYDD: createWithTenant kastar (uthyrd enhet) → raden committas inte', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(scannedRow())
    mocks.leases.createWithTenant.mockRejectedValue(
      new BadRequestException('Lägenheten har redan ett aktivt kontrakt med Bo Bengtsson.'),
    )

    await expect(service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')).rejects.toThrow(
      /aktivt kontrakt/,
    )
    // raden får ALDRIG markeras COMMITTED när avtalsskapandet kastade
    const committedCall = mocks.prisma.contractImportRow.update.mock.calls.find(
      (c) => c[0]?.data?.rowStatus === 'COMMITTED',
    )
    expect(committedCall).toBeUndefined()
  })

  it('AMBIGUOUS utan valt unitId → kan inte committas', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(
      scannedRow({ matchStatus: 'AMBIGUOUS', matchedUnitId: null }),
    )

    await expect(service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')).rejects.toThrow(
      /[Vv]älj en enhet/,
    )
    expect(mocks.leases.createWithTenant).not.toHaveBeenCalled()
  })

  it('AMBIGUOUS MED operatörsvalt unitId → committas mot vald enhet', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(
      scannedRow({ matchStatus: 'AMBIGUOUS', matchedUnitId: null }),
    )
    mocks.leases.createWithTenant.mockResolvedValue({ id: 'lease-7' })
    mocks.prisma.contractImportBatch.findUnique.mockResolvedValue({ status: 'SCANNED' })

    const res = await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1', {
      unitId: 'chosen-unit',
    })

    expect(res.leaseId).toBe('lease-7')
    expect(mocks.leases.createWithTenant.mock.calls[0][0].unitId).toBe('chosen-unit')
  })

  it('redigerad data om-valideras: ogiltig e-post i edit → committas inte', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(scannedRow())

    await expect(
      service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1', {
        reviewedData: { tenantEmail: 'inte-en-epost' },
      }),
    ).rejects.toThrow(/e-post/i)
    expect(mocks.leases.createWithTenant).not.toHaveBeenCalled()
  })

  it('en icke-SCANNED rad kan inte committas', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(scannedRow({ rowStatus: 'PENDING' }))
    await expect(service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')).rejects.toThrow(
      /status PENDING/,
    )
    expect(mocks.leases.createWithTenant).not.toHaveBeenCalled()
  })

  it('bulk "Godkänn alla säkra": committar bara AUTO_MATCHED, per-rad-isolering', async () => {
    const { service, mocks } = make()
    // bulk väljer bara SCANNED + AUTO_MATCHED + ej redan committade rader
    mocks.prisma.contractImportRow.findMany.mockResolvedValueOnce([
      { id: 'r1' },
      { id: 'r2' },
      { id: 'r3' },
    ])
    // varje confirmRow läser raden:
    mocks.prisma.contractImportRow.findFirst.mockResolvedValue(scannedRow())
    mocks.prisma.contractImportBatch.findUnique.mockResolvedValue({ status: 'SCANNED' })
    // r1 ok, r2 failar (t.ex. uthyrd enhet), r3 ok — r2 stoppar inte de andra
    mocks.leases.createWithTenant
      .mockResolvedValueOnce({ id: 'lease-r1' })
      .mockRejectedValueOnce(new BadRequestException('Lägenheten har redan ett aktivt kontrakt.'))
      .mockResolvedValueOnce({ id: 'lease-r3' })

    const res = await service.bulkConfirmSafe('batch-1', 'org-1', 'user-1')

    expect(res.committed).toHaveLength(2)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]!.rowId).toBe('r2')
    // urvalet får bara plocka AUTO_MATCHED + ännu icke-committade (idempotens vid dubbeltryck)
    expect(mocks.prisma.contractImportRow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          matchStatus: 'AUTO_MATCHED',
          rowStatus: 'SCANNED',
          createdLeaseId: null,
        }),
      }),
    )
  })

  it('skipRow: SCANNED → SKIPPED + purgar PDF; redan committad kan inte hoppas över', async () => {
    const { service, mocks } = make()
    mocks.prisma.contractImportRow.findFirst.mockResolvedValueOnce({
      rowStatus: 'SCANNED',
      createdLeaseId: null,
    })
    mocks.prisma.contractImportBatch.findUnique.mockResolvedValue({ status: 'SCANNED' })
    await service.skipRow('batch-1', 'row-1', 'org-1')
    expect(mocks.prisma.contractImportRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { rowStatus: 'SKIPPED', fileData: null },
    })

    mocks.prisma.contractImportRow.findFirst.mockResolvedValueOnce({
      rowStatus: 'COMMITTED',
      createdLeaseId: 'lease-1',
    })
    await expect(service.skipRow('batch-1', 'row-1', 'org-1')).rejects.toThrow(/redan skapat/)
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
    expect(mocks.prisma.contractImportRow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { batchId: 'batch-1' },
        data: expect.objectContaining({ fileData: null }),
      }),
    )
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
