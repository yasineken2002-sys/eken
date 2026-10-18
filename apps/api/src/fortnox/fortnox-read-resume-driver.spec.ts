import {
  FortnoxReadResumeDriver,
  ResumeBindingError,
  type ResumeReadPort,
  type ResumeReadSession,
  type ResumeRunService,
} from './fortnox-read-resume-driver'
import type {
  BoundResumeStep,
  PublicationReceipt,
  SourceResumeScope,
  SourceRunLease,
  VoucherDetailReceipt,
  VoucherManifestReceipt,
} from './fortnox-read-source-run.service'
import type { FortnoxVoucher } from './fortnox.types'

function scope() {
  return {
    organizationId: 'synthetic-org',
    runId: 'synthetic-run',
    sourceCaptureId: 'synthetic-source',
    requestHash: 'a'.repeat(64),
    connectionId: 'synthetic-connection',
    connectionGeneration: 3,
    fortnoxDatabaseNumber: 900001,
    fortnoxOrgNumber: null as string | null,
    financialYear: { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' },
  } satisfies SourceResumeScope
}

const LEASE: SourceRunLease = {
  organizationId: 'synthetic-org',
  runId: 'synthetic-run',
  claimVersion: 4,
  claimToken: '11111111-1111-4111-8111-111111111111',
  leaseUntil: new Date('2026-10-18T12:01:00Z'),
}
const MANIFEST: VoucherManifestReceipt = {
  runId: LEASE.runId,
  pageId: 'saved-page',
  page: 2,
  digest: 'b'.repeat(64),
}
const DETAIL: VoucherDetailReceipt = {
  runId: LEASE.runId,
  checkpointId: 'saved-detail',
  key: '1|A|9',
  detailDigest: 'c'.repeat(64),
}
const PUBLICATION: PublicationReceipt = {
  id: 'saved-publication',
  organizationId: LEASE.organizationId,
  runId: LEASE.runId,
  formatVersion: 1,
  status: 'COMPLETE',
  failureCode: null,
  reason: null,
  publishedAt: new Date('2026-10-18T12:00:00Z'),
  claimVersion: 4,
  resultDigest: 'd'.repeat(64),
  canonicalBytes: 123,
  publicationDigest: 'e'.repeat(64),
  proof: {
    version: 1,
    organizationId: LEASE.organizationId,
    runId: LEASE.runId,
    sourceCaptureId: 'synthetic-source',
    snapshotId: 'synthetic-snapshot',
    snapshotDigest: 'f'.repeat(64),
    sourceDigest: '0'.repeat(64),
    catalogDigest: '1'.repeat(64),
    manifestDigest: '2'.repeat(64),
    detailDigest: '3'.repeat(64),
    manifestPageCount: 1,
    manifestItemsSeen: 1,
    voucherCount: 1,
    claimVersion: 4,
  },
}

function setup(step: BoundResumeStep = { phase: 'MANIFEST', page: 2, scope: scope() }) {
  const runs: jest.Mocked<ResumeRunService> = {
    readPublicationReceipt: jest.fn().mockResolvedValue(null),
    claim: jest.fn().mockResolvedValue(LEASE),
    getResumeStep: jest.fn().mockResolvedValue(step),
    commitVoucherPage: jest.fn().mockResolvedValue(MANIFEST),
    commitVoucherDetail: jest.fn().mockResolvedValue(DETAIL),
    publishReadyLedger: jest.fn().mockResolvedValue(PUBLICATION),
    release: jest.fn().mockResolvedValue(undefined),
  }
  const session: jest.Mocked<ResumeReadSession> = {
    binding: scope(),
    readManifestPage: jest.fn().mockResolvedValue({ providerEnvelope: true }),
    readVoucher: jest.fn().mockResolvedValue({ Year: 1, VoucherSeries: 'A', VoucherNumber: 9 }),
  }
  const port: jest.Mocked<ResumeReadPort> = { open: jest.fn().mockResolvedValue(session) }
  return { runs, session, port, driver: new FortnoxReadResumeDriver(runs, port) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const advance = (driver: FortnoxReadResumeDriver) =>
  driver.advance(LEASE.organizationId, LEASE.runId)

/** Ren dispatch med typade beroenden. Inga mockade DB-påståenden eller provideranrop. */
describe('Fortnox v2 ett återupptaget steg', () => {
  it.each(['COMPLETE', 'FAILED'] as const)(
    'historiskt %s-kvitto returneras före claim och port',
    async (status) => {
      const { runs, port, driver } = setup()
      const receipt: PublicationReceipt =
        status === 'COMPLETE'
          ? PUBLICATION
          : {
              ...PUBLICATION,
              status: 'FAILED',
              failureCode: 'AMOUNT_OVERFLOW',
              reason: 'Beloppssumman ligger utanför säkert talområde',
              resultDigest: null,
              canonicalBytes: null,
            }
      runs.readPublicationReceipt.mockResolvedValue(receipt)
      const result = await advance(driver)
      expect(result).toEqual({ kind: 'PUBLICATION', receipt })
      if (result.kind === 'PUBLICATION') expect(result.receipt).toBe(receipt)
      expect(runs.readPublicationReceipt).toHaveBeenCalledWith(LEASE.organizationId, LEASE.runId)
      expect(runs.claim).not.toHaveBeenCalled()
      expect(port.open).not.toHaveBeenCalled()
      expect(runs.publishReadyLedger).not.toHaveBeenCalled()
      expect(runs.release).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'nullclaim gör exakt en andra kvittoläsning, kvitto=%s',
    async (published) => {
      const { runs, port, driver } = setup()
      const events: string[] = []
      runs.readPublicationReceipt
        .mockImplementationOnce(async () => {
          events.push('receipt1')
          return null
        })
        .mockImplementationOnce(async () => {
          events.push('receipt2')
          return published ? PUBLICATION : null
        })
      runs.claim.mockImplementationOnce(async () => {
        events.push('claim')
        return null
      })
      await expect(advance(driver)).resolves.toEqual(
        published ? { kind: 'PUBLICATION', receipt: PUBLICATION } : { kind: 'NOT_ACQUIRED' },
      )
      expect(events).toEqual(['receipt1', 'claim', 'receipt2'])
      expect(runs.claim).toHaveBeenCalledTimes(1)
      expect(runs.claim).toHaveBeenCalledWith(LEASE.organizationId, LEASE.runId)
      expect(runs.readPublicationReceipt).toHaveBeenCalledTimes(2)
      expect(runs.getResumeStep).not.toHaveBeenCalled()
      expect(port.open).not.toHaveBeenCalled()
      expect(runs.release).not.toHaveBeenCalled()
    },
  )

  it('SOURCE_CAPTURED släpper leasen och kräver separat förberedelse', async () => {
    const { runs, port, driver } = setup({ phase: 'SOURCE_CAPTURED' })
    await expect(advance(driver)).resolves.toEqual({ kind: 'PREPARATION_REQUIRED' })
    expect(runs.getResumeStep).toHaveBeenCalledWith(LEASE)
    expect(runs.release).toHaveBeenCalledTimes(1)
    expect(runs.release).toHaveBeenCalledWith(LEASE)
    expect(port.open).not.toHaveBeenCalled()
    expect(runs.commitVoucherPage).not.toHaveBeenCalled()
    expect(runs.commitVoucherDetail).not.toHaveBeenCalled()
  })

  it('väntar på en GET, commit och release utan nästa sida eller parallell läsning', async () => {
    const { runs, session, port, driver } = setup()
    const read = deferred<unknown>()
    const readEntered = deferred<void>()
    const release = deferred<void>()
    const releaseEntered = deferred<void>()
    const envelope = { Vouchers: [], MetaInformation: { '@CurrentPage': 2 } }
    session.readManifestPage.mockImplementation(async () => {
      readEntered.resolve()
      return read.promise
    })
    runs.release.mockImplementation(async () => {
      releaseEntered.resolve()
      return release.promise
    })
    const operation = advance(driver)
    let settled = false
    void operation.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    try {
      await Promise.race([
        readEntered.promise,
        operation.then(() => {
          throw new Error('Driver avslutades före readEntered')
        }),
      ])
      expect(port.open).toHaveBeenCalledTimes(1)
      expect(session.readManifestPage).toHaveBeenCalledTimes(1)
      expect(session.readManifestPage).toHaveBeenCalledWith(2)
      expect(session.readVoucher).not.toHaveBeenCalled()
      expect(runs.commitVoucherPage).not.toHaveBeenCalled()
      expect(runs.release).not.toHaveBeenCalled()
      read.resolve(envelope)
      await Promise.race([
        releaseEntered.promise,
        operation.then(() => {
          throw new Error('Driver avslutades före releaseEntered')
        }),
      ])
      expect(runs.commitVoucherPage).toHaveBeenCalledTimes(1)
      expect(runs.commitVoucherPage).toHaveBeenCalledWith(LEASE, envelope)
      expect(runs.commitVoucherPage.mock.calls[0]![1]).toBe(envelope)
      expect(settled).toBe(false)
      release.resolve()
      await expect(operation).resolves.toEqual({ kind: 'MANIFEST_SAVED', receipt: MANIFEST })
      expect(runs.getResumeStep).toHaveBeenCalledTimes(1)
      expect(runs.release).toHaveBeenCalledWith(LEASE)
      expect(runs.publishReadyLedger).not.toHaveBeenCalled()
    } finally {
      read.resolve(envelope)
      release.resolve()
      await Promise.allSettled([operation])
    }
  })

  it.each([undefined, { Year: 1, VoucherSeries: 'A', VoucherNumber: 9 }] satisfies Array<
    FortnoxVoucher | undefined
  >)(
    'en detalj lämnas oförändrad till befintlig parser även om svaret saknas: %p',
    async (voucher) => {
      const { runs, session, driver } = setup({ phase: 'DETAILS', key: DETAIL.key, scope: scope() })
      session.readVoucher.mockResolvedValue(voucher)
      await expect(advance(driver)).resolves.toEqual({ kind: 'DETAIL_SAVED', receipt: DETAIL })
      expect(session.readVoucher).toHaveBeenCalledTimes(1)
      expect(session.readVoucher).toHaveBeenCalledWith(DETAIL.key)
      expect(session.readManifestPage).not.toHaveBeenCalled()
      expect(runs.commitVoucherDetail).toHaveBeenCalledWith(LEASE, DETAIL.key, voucher)
      expect(runs.commitVoucherDetail.mock.calls[0]![2]).toBe(voucher)
      expect(runs.release).toHaveBeenCalledWith(LEASE)
      expect(runs.commitVoucherPage).not.toHaveBeenCalled()
    },
  )

  it('READY anropar befintlig publicering direkt, utan port eller terminal release', async () => {
    const { runs, port, driver } = setup({ phase: 'READY_TO_REDUCE', scope: scope() })
    await expect(advance(driver)).resolves.toEqual({ kind: 'PUBLICATION', receipt: PUBLICATION })
    expect(runs.publishReadyLedger).toHaveBeenCalledTimes(1)
    expect(runs.publishReadyLedger).toHaveBeenCalledWith(LEASE)
    expect(port.open).not.toHaveBeenCalled()
    expect(runs.release).not.toHaveBeenCalled()
    expect(runs.commitVoucherPage).not.toHaveBeenCalled()
    expect(runs.commitVoucherDetail).not.toHaveBeenCalled()
  })

  const mismatches: Array<[string, (value: ReturnType<typeof scope>) => void]> = [
    [
      'organizationId',
      (s) => {
        s.organizationId = 'foreign-org'
      },
    ],
    [
      'runId',
      (s) => {
        s.runId = 'foreign-run'
      },
    ],
    [
      'sourceCaptureId',
      (s) => {
        s.sourceCaptureId = 'foreign-source'
      },
    ],
    [
      'requestHash',
      (s) => {
        s.requestHash = 'other-request'
      },
    ],
    [
      'connectionId',
      (s) => {
        s.connectionId = 'other-connection'
      },
    ],
    [
      'connectionGeneration',
      (s) => {
        s.connectionGeneration += 1
      },
    ],
    [
      'fortnoxDatabaseNumber',
      (s) => {
        s.fortnoxDatabaseNumber += 1
      },
    ],
    [
      'fortnoxOrgNumber',
      (s) => {
        s.fortnoxOrgNumber = '556000-0000'
      },
    ],
    [
      'year.id',
      (s) => {
        s.financialYear.id = 2
      },
    ],
    [
      'year.fromDate',
      (s) => {
        s.financialYear.fromDate = '2026-02-01'
      },
    ],
    [
      'year.toDate',
      (s) => {
        s.financialYear.toDate = '2026-11-30'
      },
    ],
  ]
  it.each(mismatches)('avvikande %s nekas före GET och lagring', async (_field, change) => {
    const { runs, session, port, driver } = setup()
    const binding = scope()
    change(binding)
    port.open.mockResolvedValue({ ...session, binding })
    await expect(advance(driver)).rejects.toEqual(new ResumeBindingError())
    expect(session.readManifestPage).not.toHaveBeenCalled()
    expect(session.readVoucher).not.toHaveBeenCalled()
    expect(runs.commitVoucherPage).not.toHaveBeenCalled()
    expect(runs.commitVoucherDetail).not.toHaveBeenCalled()
    expect(runs.release).not.toHaveBeenCalled()
  })

  it('kopierar/fryser både scope och år innan porten kan ändra underlaget', async () => {
    const original = scope()
    const { session, port, driver } = setup({ phase: 'MANIFEST', page: 2, scope: original })
    port.open.mockImplementation(async (expected) => {
      expect(expected).toEqual(scope())
      expect(expected).not.toBe(original)
      expect(expected.financialYear).not.toBe(original.financialYear)
      expect(Object.isFrozen(expected)).toBe(true)
      expect(Object.isFrozen(expected.financialYear)).toBe(true)
      expect(Reflect.set(expected, 'connectionGeneration', 99)).toBe(false)
      expect(Reflect.set(expected.financialYear, 'id', 99)).toBe(false)
      original.financialYear.id = 99
      original.connectionGeneration = 99
      return { ...session, binding: original }
    })
    await expect(advance(driver)).rejects.toBeInstanceOf(ResumeBindingError)
    expect(session.readManifestPage).not.toHaveBeenCalled()
  })

  it.each(['receipt', 'claim', 'step', 'open', 'read', 'commit', 'release'] as const)(
    'bevarar originalfel från %s utan retry eller extra release',
    async (stage) => {
      const { runs, session, port, driver } = setup()
      const failure = new Error('synthetic original failure')
      if (stage === 'receipt') runs.readPublicationReceipt.mockRejectedValue(failure)
      if (stage === 'claim') runs.claim.mockRejectedValue(failure)
      if (stage === 'step') runs.getResumeStep.mockRejectedValue(failure)
      if (stage === 'open') port.open.mockRejectedValue(failure)
      if (stage === 'read') session.readManifestPage.mockRejectedValue(failure)
      if (stage === 'commit') runs.commitVoucherPage.mockRejectedValue(failure)
      if (stage === 'release') runs.release.mockRejectedValue(failure)
      await expect(advance(driver)).rejects.toBe(failure)
      expect(runs.readPublicationReceipt).toHaveBeenCalledTimes(1)
      expect(runs.claim).toHaveBeenCalledTimes(stage === 'receipt' ? 0 : 1)
      expect(runs.getResumeStep).toHaveBeenCalledTimes(['receipt', 'claim'].includes(stage) ? 0 : 1)
      expect(session.readManifestPage).toHaveBeenCalledTimes(
        ['read', 'commit', 'release'].includes(stage) ? 1 : 0,
      )
      expect(runs.commitVoucherPage).toHaveBeenCalledTimes(
        ['commit', 'release'].includes(stage) ? 1 : 0,
      )
      expect(runs.release).toHaveBeenCalledTimes(stage === 'release' ? 1 : 0)
      expect(runs.publishReadyLedger).not.toHaveBeenCalled()
    },
  )
})
