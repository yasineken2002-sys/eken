import type {
  FortnoxBoundCredential,
  FortnoxConnectionService,
  FortnoxCredentialBinding,
} from './fortnox-connection.service'
import { isDate, voucherKey } from './fortnox-ledger-validation'
import {
  ResumeBindingError,
  type ResumeReadPort,
  type ResumeReadSession,
} from './fortnox-read-resume-driver'
import type { SourceResumeScope } from './fortnox-read-source-run.service'
import { FortnoxReadError, type FortnoxLedgerReader, type FortnoxVoucher } from './fortnox.types'

function snapshotScope(expected: SourceResumeScope): SourceResumeScope {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new ResumeBindingError()
  }
  const year = expected.financialYear
  if (!year || typeof year !== 'object' || Array.isArray(year)) throw new ResumeBindingError()
  const scope = Object.freeze({
    organizationId: expected.organizationId,
    runId: expected.runId,
    sourceCaptureId: expected.sourceCaptureId,
    requestHash: expected.requestHash,
    connectionId: expected.connectionId,
    connectionGeneration: expected.connectionGeneration,
    fortnoxDatabaseNumber: expected.fortnoxDatabaseNumber,
    fortnoxOrgNumber: expected.fortnoxOrgNumber,
    financialYear: Object.freeze({
      id: year.id,
      fromDate: year.fromDate,
      toDate: year.toDate,
    }),
  })
  if (
    [scope.runId, scope.sourceCaptureId, scope.requestHash].some(
      (value) => typeof value !== 'string' || value.length === 0,
    ) ||
    !Number.isSafeInteger(scope.financialYear.id) ||
    scope.financialYear.id <= 0 ||
    !isDate(scope.financialYear.fromDate) ||
    !isDate(scope.financialYear.toDate) ||
    scope.financialYear.fromDate > scope.financialYear.toDate
  ) {
    throw new ResumeBindingError()
  }
  return scope
}

function snapshotBinding(binding: FortnoxCredentialBinding): FortnoxCredentialBinding {
  return Object.freeze({
    organizationId: binding.organizationId,
    connectionId: binding.connectionId,
    connectionGeneration: binding.connectionGeneration,
    fortnoxDatabaseNumber: binding.fortnoxDatabaseNumber,
    fortnoxOrgNumber: binding.fortnoxOrgNumber,
  })
}

function checkedCredential(
  credential: FortnoxBoundCredential,
  expected: FortnoxCredentialBinding,
): FortnoxBoundCredential {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new ResumeBindingError()
  }
  const actual = credential.binding
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new ResumeBindingError()
  const snapshot = Object.freeze({
    token: credential.token,
    tokenVersion: credential.tokenVersion,
    binding: snapshotBinding(actual),
  })
  if (
    snapshot.binding.organizationId !== expected.organizationId ||
    snapshot.binding.connectionId !== expected.connectionId ||
    snapshot.binding.connectionGeneration !== expected.connectionGeneration ||
    snapshot.binding.fortnoxDatabaseNumber !== expected.fortnoxDatabaseNumber ||
    snapshot.binding.fortnoxOrgNumber !== expected.fortnoxOrgNumber
  ) {
    throw new ResumeBindingError()
  }
  return snapshot
}

function detailPath(key: string, financialYearId: number): string {
  const match = typeof key === 'string' ? /^(\d+)\|([A-Za-z0-9]{1,10})\|(\d+)$/.exec(key) : null
  if (!match || match[0] !== key) throw new FortnoxReadError('invalid')
  const [, year, series, number] = match
  if (
    year === undefined ||
    series === undefined ||
    number === undefined ||
    Number(year) !== financialYearId ||
    voucherKey({
      Year: Number(year),
      VoucherSeries: series,
      VoucherNumber: Number(number),
    }) !== key
  ) {
    throw new FortnoxReadError('invalid')
  }
  // Befintlig nummerpolicy: 0 och stora kanoniska heltal tillåts, exponent-URL gör det inte.
  return `/3/vouchers/${series}/${number}`
}

/** Inert GET-adapter. Inga klienter, konsumenter eller workers skapas här. */
export class FortnoxResumeReadAdapter implements ResumeReadPort {
  constructor(
    private readonly connections: Pick<FortnoxConnectionService, 'boundAccessToken'>,
    private readonly reader: FortnoxLedgerReader,
  ) {}

  async open(expectedScope: SourceResumeScope): Promise<ResumeReadSession> {
    const scope = snapshotScope(expectedScope)
    const expected = snapshotBinding(scope)
    const initial = checkedCredential(await this.connections.boundAccessToken(expected), expected)
    // Driver gör en läsning per open. Återanvänd session kan prova initialtoken igen;
    // inget sent 401 får ersätta credential/version för en annan pågående operation.
    return Object.freeze({
      binding: scope,
      readManifestPage: async (page: number): Promise<unknown> => {
        if (!Number.isSafeInteger(page) || page < 1) throw new FortnoxReadError('invalid')
        const query = Object.freeze({ financialyear: scope.financialYear.id, page, limit: 100 })
        return this.get(initial, expected, '/3/vouchers/sublist', query)
      },
      readVoucher: async (key: string): Promise<FortnoxVoucher | undefined> => {
        const path = detailPath(key, scope.financialYear.id)
        const query = Object.freeze({ financialyear: scope.financialYear.id })
        const body = await this.get<{ Voucher?: FortnoxVoucher }>(initial, expected, path, query)
        return body?.Voucher
      },
    })
  }

  private async get<T>(
    initial: FortnoxBoundCredential,
    expected: FortnoxCredentialBinding,
    path: string,
    query: Readonly<Record<string, string | number>>,
  ): Promise<T> {
    try {
      return await this.reader.get<T>(initial.token, path, query)
    } catch (error) {
      if (!(error instanceof FortnoxReadError) || error.kind !== 'auth') throw error
    }
    const next = checkedCredential(
      await this.connections.boundAccessToken(expected, {
        afterUnauthorizedVersion: initial.tokenVersion,
      }),
      expected,
    )
    // Bara ett adapteromförsök. Transporten äger sina begränsade 429/5xx-försök;
    // source-run måste fortfarande kontrollera aktuell lease/bindning efter GET.
    return this.reader.get<T>(next.token, path, query)
  }
}
