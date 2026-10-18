import type {
  FortnoxReadSourceRunService,
  PublicationReceipt,
  SourceResumeScope,
  VoucherDetailReceipt,
  VoucherManifestReceipt,
} from './fortnox-read-source-run.service'
import type { FortnoxVoucher } from './fortnox.types'

export type ResumeRunService = Pick<
  FortnoxReadSourceRunService,
  | 'readPublicationReceipt'
  | 'claim'
  | 'getResumeStep'
  | 'commitVoucherPage'
  | 'commitVoucherDetail'
  | 'publishReadyLedger'
  | 'release'
>

export type ResumeReadSession = {
  readonly binding: SourceResumeScope
  readManifestPage(page: number): Promise<unknown>
  readVoucher(key: string): Promise<FortnoxVoucher | undefined>
}

/** Serverägd läsport. En verklig credential-/refreshadapter ingår inte här. */
export type ResumeReadPort = {
  open(expectedScope: SourceResumeScope): Promise<ResumeReadSession>
}

export type ResumeStepResult =
  | { kind: 'PUBLICATION'; receipt: PublicationReceipt }
  | { kind: 'MANIFEST_SAVED'; receipt: VoucherManifestReceipt }
  | { kind: 'DETAIL_SAVED'; receipt: VoucherDetailReceipt }
  | { kind: 'PREPARATION_REQUIRED' }
  | { kind: 'NOT_ACQUIRED' }

export class ResumeBindingError extends Error {
  constructor() {
    super('Läsaren matchar inte det frysta Fortnox-underlaget')
    this.name = 'ResumeBindingError'
  }
}

function frozenScope(scope: SourceResumeScope): SourceResumeScope {
  return Object.freeze({
    organizationId: scope.organizationId,
    runId: scope.runId,
    sourceCaptureId: scope.sourceCaptureId,
    requestHash: scope.requestHash,
    connectionId: scope.connectionId,
    connectionGeneration: scope.connectionGeneration,
    fortnoxDatabaseNumber: scope.fortnoxDatabaseNumber,
    fortnoxOrgNumber: scope.fortnoxOrgNumber,
    financialYear: Object.freeze({
      id: scope.financialYear.id,
      fromDate: scope.financialYear.fromDate,
      toDate: scope.financialYear.toDate,
    }),
  })
}

function assertBinding(expected: SourceResumeScope, actual: SourceResumeScope): void {
  if (
    !actual ||
    !actual.financialYear ||
    actual.organizationId !== expected.organizationId ||
    actual.runId !== expected.runId ||
    actual.sourceCaptureId !== expected.sourceCaptureId ||
    actual.requestHash !== expected.requestHash ||
    actual.connectionId !== expected.connectionId ||
    actual.connectionGeneration !== expected.connectionGeneration ||
    actual.fortnoxDatabaseNumber !== expected.fortnoxDatabaseNumber ||
    actual.fortnoxOrgNumber !== expected.fortnoxOrgNumber ||
    actual.financialYear.id !== expected.financialYear.id ||
    actual.financialYear.fromDate !== expected.financialYear.fromDate ||
    actual.financialYear.toDate !== expected.financialYear.toDate
  ) {
    throw new ResumeBindingError()
  }
}

/** Ett explicit steg för ett befintligt run. Ingen start, loop, kö eller DI-registrering. */
export class FortnoxReadResumeDriver {
  constructor(
    private readonly runs: ResumeRunService,
    private readonly reader: ResumeReadPort,
  ) {}

  async advance(organizationId: string, runId: string): Promise<ResumeStepResult> {
    const published = await this.runs.readPublicationReceipt(organizationId, runId)
    if (published) return { kind: 'PUBLICATION', receipt: published }

    const lease = await this.runs.claim(organizationId, runId)
    if (!lease) {
      const observed = await this.runs.readPublicationReceipt(organizationId, runId)
      return observed ? { kind: 'PUBLICATION', receipt: observed } : { kind: 'NOT_ACQUIRED' }
    }

    const step = await this.runs.getResumeStep(lease)
    if (step.phase === 'SOURCE_CAPTURED') {
      await this.runs.release(lease)
      return { kind: 'PREPARATION_REQUIRED' }
    }
    if (step.phase === 'READY_TO_REDUCE') {
      // Publiceringen äger renew, terminalen och eftercommit-kvittot.
      return { kind: 'PUBLICATION', receipt: await this.runs.publishReadyLedger(lease) }
    }

    const scope = frozenScope(step.scope)
    const position =
      step.phase === 'MANIFEST'
        ? { phase: 'MANIFEST' as const, page: step.page }
        : { phase: 'DETAILS' as const, key: step.key }
    const session = await this.reader.open(scope)
    assertBinding(scope, session.binding)

    // GET ligger utanför lagringens TX. Commit återprövar aktuell lease/bindning.
    // Fel propagerar; ingen finally-release får maskera felet eller föregripa pågående I/O.
    if (position.phase === 'MANIFEST') {
      const envelope = await session.readManifestPage(position.page)
      const receipt = await this.runs.commitVoucherPage(lease, envelope)
      await this.runs.release(lease)
      return { kind: 'MANIFEST_SAVED', receipt }
    }
    const voucher = await session.readVoucher(position.key)
    const receipt = await this.runs.commitVoucherDetail(lease, position.key, voucher)
    await this.runs.release(lease)
    return { kind: 'DETAIL_SAVED', receipt }
  }
}
