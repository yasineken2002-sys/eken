import { ConflictException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type {
  Coverage,
  LedgerReadConfig,
  LedgerReadResult,
  LedgerRowProvenance,
  LedgerSummary,
} from './fortnox-ledger'
import { createLedgerAccumulator, selectVerifiedLedgerMappings } from './fortnox-ledger-reducer'
import { stable, type ValidatedLedgerVoucher } from './fortnox-ledger-validation'
import { checkpointCatalogMatches } from './fortnox-read-catalog-contract'
import type {
  CheckpointCatalog,
  CheckpointContextSchema,
  StartCheckpointInput,
} from './fortnox-read-checkpoint-context'
import { enrichEvenoLedgerResult, type Egen } from './fortnox-read-provenance'
import type { VoucherManifestPage } from './fortnox-read-voucher-checkpoint'

/** Internt beräkningsbevis. Ger ingen rätt att senare publicera utan en ny fence. */
export type ReductionProof = {
  version: 1
  organizationId: string
  runId: string
  sourceCaptureId: string
  snapshotId: string
  snapshotDigest: string
  sourceDigest: string
  catalogDigest: string
  manifestDigest: string
  detailDigest: string
  manifestPageCount: number
  manifestItemsSeen: number
  voucherCount: number
  claimVersion: number
}

export type ReducedLedgerResult = LedgerReadResult & {
  status: 'COMPLETE' | 'COMPLETE_WITH_UNCERTAINTY'
  reason: null
  summary: LedgerSummary
  rows: LedgerRowProvenance[]
  financialYear: NonNullable<LedgerReadResult['financialYear']>
}

export type ReadyLedgerReduction =
  | { kind: 'REDUCED'; proof: ReductionProof; result: ReducedLedgerResult }
  | { kind: 'FAILED'; code: 'AMOUNT_OVERFLOW'; proof: ReductionProof }

type Context = z.infer<typeof CheckpointContextSchema>
export type FrozenReductionMaps = {
  mappings: Map<string, { propertyId: string; propertyName: string }>
  ownExports: Map<string, Egen>
  hasProjectMapping: boolean
}

export function createFrozenReductionMaps(): FrozenReductionMaps {
  return { mappings: new Map(), ownExports: new Map(), hasProjectMapping: false }
}

export function appendReductionMappings(
  maps: FrozenReductionMaps,
  items: Context['mappings'],
): void {
  for (const item of items) {
    maps.mappings.set(`${item.type}:${item.code}`, {
      propertyId: item.propertyId,
      propertyName: item.propertyName,
    })
    if (item.type === 'PROJECT') maps.hasProjectMapping = true
  }
}

export function appendReductionOwnExports(
  maps: FrozenReductionMaps,
  items: Context['ownExports'],
): void {
  for (const item of items) {
    maps.ownExports.set(item.voucher, {
      journalEntryId: item.journalEntryId,
      revision: item.revision,
      perMal: new Map(item.perMal.map((entry) => [entry.account, [...entry.sources]])),
    })
  }
}

function proofConflict(): ConflictException {
  return new ConflictException('Det frysta reduceringsunderlaget stämmer inte')
}

/** Fulla sidor är redan validerade av den scoped läsaren; här binds deras ordning. */
export class ManifestReductionProof {
  private readonly hash = createHash('sha256').update('{"pages":[')
  private readonly keys = new Map<string, string>()
  private readonly duplicateWarnings: string[] = []
  private pageCount = 0
  private itemsSeen = 0
  private closed = false

  constructor(
    private readonly expected: {
      pageCount: number
      totalPages: number
      totalResources: number
    },
  ) {
    if (
      ![expected.pageCount, expected.totalPages, expected.totalResources].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      expected.pageCount !== Math.max(1, expected.totalPages)
    )
      throw proofConflict()
  }

  append(page: VoucherManifestPage): void {
    if (this.closed) throw proofConflict()
    // Ett misslyckat append får aldrig följas av ett lyckat finish på ett prefix.
    this.closed = true
    if (
      page.page !== this.pageCount + 1 ||
      page.page > this.expected.pageCount ||
      page.totalPages !== this.expected.totalPages ||
      page.totalResources !== this.expected.totalResources ||
      page.itemCount !== page.entries.length ||
      !Number.isSafeInteger(this.itemsSeen + page.itemCount)
    )
      throw proofConflict()
    for (const entry of page.entries) {
      const previous = this.keys.get(entry.key)
      if (previous !== undefined) {
        if (previous !== entry.digest) throw proofConflict()
        this.duplicateWarnings.push(
          `Verifikat ${entry.key} förekom flera gånger i listan och räknades en gång.`,
        )
      }
      this.keys.set(entry.key, entry.digest)
    }
    if (this.keys.size > this.expected.totalResources) throw proofConflict()
    if (this.pageCount) this.hash.update(',')
    this.hash.update(stable(page))
    this.pageCount += 1
    this.itemsSeen += page.itemCount
    this.closed = false
  }

  finish(): {
    digest: string
    pageCount: number
    itemsSeen: number
    keys: ReadonlyMap<string, string>
    duplicateWarnings: string[]
  } {
    if (this.closed) throw proofConflict()
    this.closed = true
    if (
      this.pageCount !== this.expected.pageCount ||
      this.keys.size !== this.expected.totalResources
    )
      throw proofConflict()
    return {
      digest: this.hash.update('],"version":1}').digest('hex'),
      pageCount: this.pageCount,
      itemsSeen: this.itemsSeen,
      keys: this.keys,
      duplicateWarnings: this.duplicateWarnings,
    }
  }
}

/** Strömmar normalformer utan att behålla hela detaljlistan eller en hashlista. */
export class DetailReductionProof {
  private readonly hash = createHash('sha256').update('{"items":[')
  private count = 0
  private firstKey: string | null = null
  private lastKey: string | null = null
  private closed = false

  constructor(private readonly keys: ReadonlyMap<string, string>) {}

  append(items: readonly ValidatedLedgerVoucher[]): void {
    if (this.closed) throw proofConflict()
    this.closed = true
    for (const item of items) {
      if (
        !this.keys.has(item.key) ||
        (this.lastKey !== null && item.key <= this.lastKey) ||
        this.count >= this.keys.size
      )
        throw proofConflict()
      if (this.count) this.hash.update(',')
      this.hash.update(stable(item))
      this.firstKey ??= item.key
      this.lastKey = item.key
      this.count += 1
    }
    this.closed = false
  }

  finish(): { digest: string; count: number; firstKey: string | null; lastKey: string | null } {
    if (this.closed) throw proofConflict()
    this.closed = true
    if (this.count !== this.keys.size) throw proofConflict()
    return {
      digest: this.hash.update('],"version":1}').digest('hex'),
      count: this.count,
      firstKey: this.firstKey,
      lastKey: this.lastKey,
    }
  }
}

export function buildReductionConfig(
  input: StartCheckpointInput,
  catalog: CheckpointCatalog,
  maps: FrozenReductionMaps,
  manifest: Coverage,
  duplicateWarnings: readonly string[],
): { config: LedgerReadConfig; base: Parameters<typeof createLedgerAccumulator>[1] } {
  if (
    !checkpointCatalogMatches(input, catalog.companyDatabaseNumber, maps.hasProjectMapping, catalog)
  )
    throw proofConflict()
  const uncertainties: string[] = []
  const mappings = selectVerifiedLedgerMappings(
    maps.mappings,
    new Set(catalog.dimensions.map((dimension) => `${dimension.type}:${dimension.code}`)),
    uncertainties,
  )
  for (const warning of duplicateWarnings) uncertainties.push(warning)
  const coverage: LedgerReadResult['coverage'] = {
    '/3/costcenters': { ...catalog.coverage.costCenters },
  }
  if (maps.hasProjectMapping) coverage['/3/projects'] = { ...catalog.coverage.projects! }
  coverage['/3/vouchers/sublist'] = { ...manifest }
  return {
    config: {
      expectedDatabaseNumber: catalog.companyDatabaseNumber,
      financialYearId: input.financialYearId,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      costAccounts: [...input.costAccounts],
      mappings,
      evenoExported: new Set(maps.ownExports.keys()),
    },
    base: {
      coverage,
      uncertainties,
      references: [],
      financialYear: {
        id: catalog.financialYear.id,
        fromDate: catalog.financialYear.fromDate,
        toDate: catalog.financialYear.toDate,
      },
    },
  }
}

export function finishReducedLedger(
  result: LedgerReadResult,
  catalog: CheckpointCatalog,
  ownExports: ReadonlyMap<string, Egen>,
): ReducedLedgerResult {
  const enriched = enrichEvenoLedgerResult(result, ownExports)
  if (
    (enriched.status !== 'COMPLETE' && enriched.status !== 'COMPLETE_WITH_UNCERTAINTY') ||
    enriched.reason !== null ||
    !enriched.summary ||
    !enriched.rows ||
    !enriched.financialYear
  )
    throw proofConflict()
  // Kontonas ingående saldon är separata värden, aldrig en del av periodens rörelse.
  enriched.summary.balanceBroughtForwardOre = Object.fromEntries(
    catalog.accounts.map((account) => [String(account.number), account.balanceBroughtForwardOre]),
  )
  enriched.summary.financialYearAccountingMethod = catalog.financialYear.accountingMethod || null
  return {
    ...enriched,
    status: enriched.status,
    reason: null,
    summary: enriched.summary,
    rows: enriched.rows,
    financialYear: enriched.financialYear,
  }
}
