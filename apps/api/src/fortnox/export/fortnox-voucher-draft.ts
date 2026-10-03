/** Pure, disabled export preparation. No I/O, delivery, claim or exactly-once guarantee. */
export interface LocalJournalEntrySnapshot {
  readonly inputOrigin: 'PERSISTED_JOURNAL_ENTRY'
  readonly id: string
  readonly organizationId: string
  /** Prisma @db.Date: ISO civil date, or its UTC-midnight Date representation. */
  readonly date: string | Date
  readonly eventDate: string | Date | null
  readonly description: string
  readonly reference: string | null
  readonly source: string
  readonly sourceId: string | null
  readonly aiToolExecutionId: string | null
  readonly fiscalYear: number
  readonly series: string
  readonly verNumber: number
  readonly reversalOfEntryId: string | null
  readonly lines: readonly {
    readonly id: string
    readonly journalEntryId: string
    readonly accountId: string
    /** Decimal.toString(), never Number(decimal). No amount supplied by an AI draft. */
    readonly debit: string | null
    readonly credit: string | null
    readonly description: string | null
    readonly account: {
      readonly id: string
      readonly organizationId: string
      readonly number: number
    }
  }[]
}

export interface VerifiedBinding {
  readonly organizationId: string
  readonly externalDatabaseNumber: number
  readonly evidenceRef: string
}

export interface FortnoxVoucherDraftConfig {
  readonly organizationId: string
  readonly externalCompany: {
    readonly organizationNumber: string
    readonly databaseNumber: number
    readonly evidenceRef: string
  }
  readonly financialYear: VerifiedBinding & {
    readonly localFiscalYear: number
    /** Query financialyear id; deliberately separate from the required payload Year field. */
    readonly id: number
    readonly voucherYear: number
    readonly fromDate: string
    readonly toDate: string
  }
  readonly voucherSeries: VerifiedBinding & {
    readonly code: string
    readonly financialYearId: number
  }
  readonly accounts: readonly (VerifiedBinding & {
    readonly localAccountId: string
    readonly localAccountNumber: number
    readonly externalAccountNumber: number
  })[]
  /** No dimension exists on JournalEntryLine. Never infer one from text/account/source. */
  readonly dimensions:
    | (VerifiedBinding & { readonly mode: 'OMIT'; readonly reason: string })
    | {
        readonly mode: 'PER_LINE'
        readonly lines: readonly (VerifiedBinding & {
          readonly journalEntryLineId: string
          readonly costCenter: string | null
          readonly project: string | null
        })[]
      }
}

export interface FortnoxVoucherPayload {
  Voucher: {
    Description: string
    TransactionDate: string
    VoucherSeries: string
    Comments: string
    VoucherRows: {
      Account: number
      Debit?: number
      Credit?: number
      /** Radtext. Guidens POST-exempel (vouchers.html) bär radtext här, ≤100 tecken (OpenAPI). */
      TransactionInformation?: string
      CostCenter?: string
      Project?: string
    }[]
  }
}

export interface FortnoxVoucherProvenance {
  organizationId: string
  journalEntryId: string
  localFiscalYear: number
  localSeries: string
  localVerNumber: number
  source: string
  sourceId: string | null
  reference: string | null
  reversalOfEntryId: string | null
  bookingDate: string
  eventDate: string
  externalCompany: { organizationNumber: string; databaseNumber: number; evidenceRef: string }
  financialYearEvidenceRef: string
  voucherSeriesEvidenceRef: string
  totalDebitOre: string
  totalCreditOre: string
  lines: {
    journalEntryLineId: string
    localAccountId: string
    localAccountNumber: number
    externalAccountNumber: number
    debit: string | null
    credit: string | null
    amountOre: string
    side: 'Debit' | 'Credit'
    accountEvidenceRef: string
    dimensionEvidenceRef: string
    dimensionDecision: {
      costCenter: string | null
      project: string | null
      omissionReason: string | null
    }
  }[]
}

export type FortnoxVoucherDraftResult =
  | {
      status: 'READY_DRY_RUN'
      liveExportAllowed: false
      payload: FortnoxVoucherPayload
      query: { financialyear: number }
      provenance: FortnoxVoucherProvenance
    }
  | {
      status: 'BLOCKED'
      liveExportAllowed: false
      reason: { code: string; path: string; message: string }
    }

class DraftBlocked extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message)
  }
}

function requireDraft(
  condition: unknown,
  code: string,
  path: string,
  message: string,
): asserts condition {
  if (!condition) throw new DraftBlocked(code, path, message)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function civilDate(value: unknown, path: string): string {
  const raw =
    value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value
  const iso =
    value instanceof Date &&
    typeof raw === 'string' &&
    /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(raw)
      ? raw.slice(0, 10)
      : raw
  requireDraft(
    typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso),
    'INVALID_DATE',
    path,
    'Expected a calendar date or Prisma UTC-midnight @db.Date; no timezone truncation is allowed.',
  )
  const parsed = new Date(`${iso}T00:00:00.000Z`)
  requireDraft(
    Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === iso &&
      iso >= '0001-01-01',
    'INVALID_DATE',
    path,
    'The calendar date does not exist.',
  )
  return iso
}

function ore(value: unknown, path: string): bigint {
  requireDraft(
    typeof value === 'string' && /^-?\d{1,8}(?:\.\d{1,2})?$/.test(value),
    'INVALID_DECIMAL',
    path,
    'Expected a Decimal(10,2) string; no float input, rounding or exponent conversion.',
  )
  const negative = value.startsWith('-')
  const [whole = '', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  requireDraft(
    !negative && amount > 0n,
    'BLOCKED_UNVERIFIED_AMOUNT_SEMANTICS',
    path,
    'Zero or negative journal sides require verified external semantics; no normalization is performed.',
  )
  return amount
}

function wireAmount(amount: bigint, path: string): number {
  const exact = `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`
  const value = Number(exact)
  requireDraft(
    ore(JSON.stringify(value), path) === amount,
    'WIRE_AMOUNT_PRECISION',
    path,
    'The JSON numeric token would not preserve the original number of ore.',
  )
  return value
}

function binding(value: VerifiedBinding, cfg: FortnoxVoucherDraftConfig, path: string): void {
  requireDraft(
    value?.organizationId === cfg.organizationId &&
      value?.externalDatabaseNumber === cfg.externalCompany.databaseNumber,
    'MAPPING_SCOPE_MISMATCH',
    path,
    'The verified mapping belongs to a different organization or external company.',
  )
  requireDraft(
    text(value.evidenceRef),
    'UNVERIFIED_MAPPING',
    `${path}.evidenceRef`,
    'An explicit verification evidence reference is required.',
  )
}

/** Caller must load an authorized persisted snapshot and verify evidence references outside this pure function. */
export function buildFortnoxVoucherDraft(
  entry: LocalJournalEntrySnapshot,
  config: FortnoxVoucherDraftConfig,
): FortnoxVoucherDraftResult {
  try {
    requireDraft(
      entry?.inputOrigin === 'PERSISTED_JOURNAL_ENTRY',
      'UNTRUSTED_SOURCE',
      'entry.inputOrigin',
      'Only a persisted journal snapshot is accepted.',
    )
    requireDraft(
      text(config?.organizationId) && entry.organizationId === config.organizationId,
      'ORGANIZATION_MISMATCH',
      'entry.organizationId',
      'Journal and export configuration must belong to the same organization.',
    )
    requireDraft(
      text(entry.id) &&
        positiveInt(entry.fiscalYear) &&
        text(entry.series) &&
        positiveInt(entry.verNumber),
      'INVALID_JOURNAL_IDENTITY',
      'entry',
      'A persisted journal identity and local year/series/number are required.',
    )
    requireDraft(
      entry.source !== 'AI' && entry.aiToolExecutionId === null,
      'AI_SOURCE_BLOCKED',
      'entry.source',
      'AI-origin amounts are outside this export preparation contract.',
    )
    requireDraft(
      [
        'MANUAL',
        'INVOICE',
        'PAYMENT',
        'LEASE',
        'RENT_NOTICE',
        'MISC_CHARGE',
        'SUPPLIER_INVOICE',
      ].includes(entry.source),
      'UNVERIFIED_SOURCE',
      'entry.source',
      'The local journal source is not recognized in the source schema.',
    )
    requireDraft(
      text(config.externalCompany?.organizationNumber) &&
        positiveInt(config.externalCompany?.databaseNumber) &&
        text(config.externalCompany?.evidenceRef),
      'UNVERIFIED_COMPANY',
      'config.externalCompany',
      'A verified external organization number and database number are required.',
    )
    binding(config.financialYear, config, 'config.financialYear')
    binding(config.voucherSeries, config, 'config.voucherSeries')
    const bookingDate = civilDate(entry.date, 'entry.date')
    const eventDate =
      entry.eventDate === null ? bookingDate : civilDate(entry.eventDate, 'entry.eventDate')
    const from = civilDate(config.financialYear.fromDate, 'config.financialYear.fromDate')
    const to = civilDate(config.financialYear.toDate, 'config.financialYear.toDate')
    requireDraft(
      from <= bookingDate &&
        bookingDate <= to &&
        config.financialYear.localFiscalYear === entry.fiscalYear &&
        positiveInt(config.financialYear.id) &&
        config.financialYear.id <= 2147483647 &&
        positiveInt(config.financialYear.voucherYear) &&
        config.financialYear.voucherYear <= 2147483647,
      'FINANCIAL_YEAR_MISMATCH',
      'config.financialYear',
      'Booking date and local year must match the explicitly verified external year.',
    )
    requireDraft(
      text(config.voucherSeries.code) &&
        config.voucherSeries.code.length <= 10 &&
        config.voucherSeries.financialYearId === config.financialYear.id,
      'INVALID_SERIES',
      'config.voucherSeries',
      'A verified series in this external year is required.',
    )
    requireDraft(
      text(entry.description) && entry.description.length <= 200,
      'DESCRIPTION_UNREPRESENTABLE',
      'entry.description',
      'Fortnox requires 1–200 characters; no silent truncation is allowed.',
    )
    requireDraft(
      Array.isArray(entry.lines) && entry.lines.length >= 2,
      'NO_EXPORTABLE_LINES',
      'entry.lines',
      'At least two persisted journal lines are required; empty input is not a successful export.',
    )
    requireDraft(
      Array.isArray(config.accounts),
      'MISSING_ACCOUNT_MAPPING',
      'config.accounts',
      'Explicit verified account mappings are required.',
    )
    const accounts = new Map<string, FortnoxVoucherDraftConfig['accounts'][number]>()
    for (const mapping of config.accounts) {
      binding(mapping, config, 'config.accounts')
      requireDraft(
        text(mapping.localAccountId) && !accounts.has(mapping.localAccountId),
        'AMBIGUOUS_ACCOUNT_MAPPING',
        'config.accounts',
        'Each local account may have only one explicit mapping.',
      )
      requireDraft(
        Number.isInteger(mapping.externalAccountNumber) &&
          mapping.externalAccountNumber >= 1000 &&
          mapping.externalAccountNumber <= 9999,
        'INVALID_EXTERNAL_ACCOUNT',
        'config.accounts',
        'Fortnox Account must be an integer from 1000 to 9999.',
      )
      accounts.set(mapping.localAccountId, mapping)
    }
    const dimensionLines = new Map<
      string,
      Extract<FortnoxVoucherDraftConfig['dimensions'], { mode: 'PER_LINE' }>['lines'][number]
    >()
    if (config.dimensions?.mode === 'OMIT') {
      binding(config.dimensions, config, 'config.dimensions')
      requireDraft(
        text(config.dimensions.reason),
        'UNVERIFIED_DIMENSIONS',
        'config.dimensions.reason',
        'Omitting dimensions requires an explicit verified decision and reason.',
      )
    } else {
      requireDraft(
        config.dimensions?.mode === 'PER_LINE' && Array.isArray(config.dimensions.lines),
        'UNVERIFIED_DIMENSIONS',
        'config.dimensions',
        'Choose verified omission or an explicit verified mapping for every journal line.',
      )
      for (const mapping of config.dimensions.lines) {
        binding(mapping, config, 'config.dimensions.lines')
        requireDraft(
          text(mapping.journalEntryLineId) && !dimensionLines.has(mapping.journalEntryLineId),
          'AMBIGUOUS_DIMENSIONS',
          'config.dimensions.lines',
          'Duplicate or missing line identity in dimension decisions.',
        )
        requireDraft(
          (mapping.costCenter === null || text(mapping.costCenter)) &&
            (mapping.project === null || text(mapping.project)),
          'INVALID_DIMENSIONS',
          'config.dimensions.lines',
          'Both dimension decisions must be explicit codes or null.',
        )
        dimensionLines.set(mapping.journalEntryLineId, mapping)
      }
    }
    let debitTotal = 0n,
      creditTotal = 0n
    const rows: FortnoxVoucherPayload['Voucher']['VoucherRows'] = []
    const provenanceLines: FortnoxVoucherProvenance['lines'] = []
    const lineIds = new Set<string>()
    for (const line of entry.lines) {
      const path = `entry.lines[${rows.length}]`
      requireDraft(
        text(line.id) && !lineIds.has(line.id) && line.journalEntryId === entry.id,
        'INVALID_LINE_IDENTITY',
        path,
        'Lines must have unique persisted identities belonging to this journal.',
      )
      lineIds.add(line.id)
      requireDraft(
        line.account?.id === line.accountId && line.account.organizationId === entry.organizationId,
        'ACCOUNT_SCOPE_MISMATCH',
        path,
        'The source account must belong to the journal organization and match accountId.',
      )
      const account = accounts.get(line.accountId)
      requireDraft(
        account &&
          account.localAccountNumber === line.account.number &&
          Number.isInteger(line.account.number),
        'MISSING_ACCOUNT_MAPPING',
        path,
        'No verified mapping matches this exact local account identity and number.',
      )
      requireDraft(
        (line.debit === null) !== (line.credit === null),
        'AMBIGUOUS_JOURNAL_SIDE',
        path,
        'Exactly one debit/credit side must be non-null; no netting is performed.',
      )
      const side = line.debit !== null ? 'Debit' : 'Credit'
      const amount = ore(side === 'Debit' ? line.debit : line.credit, path)
      if (side === 'Debit') debitTotal += amount
      else creditTotal += amount
      const row: FortnoxVoucherPayload['Voucher']['VoucherRows'][number] = {
        Account: account.externalAccountNumber,
        [side]: wireAmount(amount, path),
      }
      requireDraft(
        line.description === null || typeof line.description === 'string',
        'INVALID_LINE_DESCRIPTION',
        path,
        'The persisted line description must be text or null.',
      )
      // FINAL-003 EX-2b: radens Description i Fortnox är KONTOTS benämning (guidens svarsexempel);
      // lokal radtext skickas i TransactionInformation. Över 100 tecken spärras — aldrig tyst
      // avkortning. Tom text = ingen radtext.
      if (line.description !== null && line.description !== '') {
        requireDraft(
          line.description.length <= 100,
          'LINE_TEXT_TOO_LONG',
          path,
          'Radtexten är längre än 100 tecken (Fortnox TransactionInformation); korta texten i Eveno före export.',
        )
        row.TransactionInformation = line.description
      }
      const dimension = dimensionLines.get(line.id)
      let dimensionEvidenceRef: string, omissionReason: string | null
      if (config.dimensions.mode === 'OMIT') {
        dimensionEvidenceRef = config.dimensions.evidenceRef
        omissionReason = config.dimensions.reason
      } else {
        requireDraft(
          dimension,
          'MISSING_DIMENSION_MAPPING',
          path,
          'This line has no verified dimension decision.',
        )
        dimensionEvidenceRef = dimension.evidenceRef
        omissionReason = null
        if (dimension.costCenter !== null) row.CostCenter = dimension.costCenter
        if (dimension.project !== null) row.Project = dimension.project
      }
      rows.push(row)
      provenanceLines.push({
        journalEntryLineId: line.id,
        localAccountId: line.accountId,
        localAccountNumber: line.account.number,
        externalAccountNumber: account.externalAccountNumber,
        debit: line.debit,
        credit: line.credit,
        amountOre: amount.toString(),
        side,
        accountEvidenceRef: account.evidenceRef,
        dimensionEvidenceRef,
        dimensionDecision: {
          costCenter: dimension?.costCenter ?? null,
          project: dimension?.project ?? null,
          omissionReason,
        },
      })
    }
    requireDraft(
      config.dimensions.mode === 'OMIT' || dimensionLines.size === lineIds.size,
      'EXTRANEOUS_DIMENSION_MAPPING',
      'config.dimensions.lines',
      'Dimension mapping contains lines outside this journal.',
    )
    requireDraft(
      debitTotal === creditTotal,
      'UNBALANCED_JOURNAL',
      'entry.lines',
      'Exact debit and credit totals differ; no rounding tolerance or balancing line is allowed.',
    )
    const comments = `Eveno JournalEntry ${entry.id}; local ${entry.series}/${entry.fiscalYear}/${entry.verNumber}; eventDate ${eventDate}`
    requireDraft(
      comments.length <= 1000,
      'PROVENANCE_UNREPRESENTABLE',
      'entry.id',
      'The provenance exceeds the Fortnox Comments limit.',
    )
    return {
      status: 'READY_DRY_RUN',
      liveExportAllowed: false,
      query: { financialyear: config.financialYear.id },
      // EX-1 (mätt 2026-10-03T01:20:44Z, testföretag 1868238, execute-001 svar-0069 sha 3f7e5ec1):
      // POST med Voucher.Year avvisas 400/2000321 "Fältet Year är endast läsbart." trots att
      // OpenAPI-payloadschemat anger Year som obligatoriskt; guidens POST-exempel saknar Year.
      // Året bärs ENDAST av ?financialyear=<id> (query), och kvittot måste bära Year === id.
      payload: {
        Voucher: {
          Description: entry.description,
          TransactionDate: bookingDate,
          VoucherSeries: config.voucherSeries.code,
          Comments: comments,
          VoucherRows: rows,
        },
      },
      provenance: {
        organizationId: entry.organizationId,
        journalEntryId: entry.id,
        localFiscalYear: entry.fiscalYear,
        localSeries: entry.series,
        localVerNumber: entry.verNumber,
        source: entry.source,
        sourceId: entry.sourceId,
        reference: entry.reference,
        reversalOfEntryId: entry.reversalOfEntryId,
        bookingDate,
        eventDate,
        externalCompany: { ...config.externalCompany },
        financialYearEvidenceRef: config.financialYear.evidenceRef,
        voucherSeriesEvidenceRef: config.voucherSeries.evidenceRef,
        totalDebitOre: debitTotal.toString(),
        totalCreditOre: creditTotal.toString(),
        lines: provenanceLines,
      },
    }
  } catch (error) {
    if (error instanceof DraftBlocked)
      return {
        status: 'BLOCKED',
        liveExportAllowed: false,
        reason: { code: error.code, path: error.path, message: error.message },
      }
    // Malformed runtime snapshots also fail closed, without echoing arbitrary data or throwing.
    return {
      status: 'BLOCKED',
      liveExportAllowed: false,
      reason: {
        code: 'INVALID_INPUT_SHAPE',
        path: 'input',
        message: 'The snapshot or configuration does not match the explicit export contract.',
      },
    }
  }
}
