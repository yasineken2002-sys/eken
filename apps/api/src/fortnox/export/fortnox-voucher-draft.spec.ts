import {
  buildFortnoxVoucherDraft,
  type FortnoxVoucherDraftConfig,
  type LocalJournalEntrySnapshot,
} from './fortnox-voucher-draft'

function fixture() {
  const proof = { organizationId: 'org-1', externalDatabaseNumber: 900001, evidenceRef: 'verified:test-only' }
  const entry: LocalJournalEntrySnapshot = {
    inputOrigin: 'PERSISTED_JOURNAL_ENTRY', id: 'entry-1', organizationId: 'org-1',
    date: '2026-10-01', eventDate: null, description: 'Supplier invoice booking', reference: 'local-reference',
    source: 'SUPPLIER_INVOICE', sourceId: 'supplier-invoice:inv-1', aiToolExecutionId: null,
    fiscalYear: 2026, series: 'A', verNumber: 7, reversalOfEntryId: null,
    lines: [
      { id: 'line-1', journalEntryId: 'entry-1', accountId: 'acc-5170', debit: '100.10', credit: null,
        description: 'Repair', account: { id: 'acc-5170', organizationId: 'org-1', number: 5170 } },
      { id: 'line-2', journalEntryId: 'entry-1', accountId: 'acc-2440', debit: null, credit: '100.10',
        description: null, account: { id: 'acc-2440', organizationId: 'org-1', number: 2440 } },
    ],
  }
  const config: FortnoxVoucherDraftConfig = {
    organizationId: 'org-1', externalCompany: { organizationNumber: '556000-0001', databaseNumber: 900001, evidenceRef: 'verified:company' },
    financialYear: { ...proof, localFiscalYear: 2026, id: 17, voucherYear: 17, fromDate: '2026-07-01', toDate: '2027-06-30' },
    voucherSeries: { ...proof, code: 'L', financialYearId: 17 },
    accounts: [
      { ...proof, localAccountId: 'acc-5170', localAccountNumber: 5170, externalAccountNumber: 5180 },
      { ...proof, localAccountId: 'acc-2440', localAccountNumber: 2440, externalAccountNumber: 2440 },
    ],
    dimensions: { ...proof, mode: 'OMIT', reason: 'Verified whole-company export without dimensions.' },
  }
  return { entry, config, proof }
}

function blocked(entry: LocalJournalEntrySnapshot, config: FortnoxVoucherDraftConfig, code: string) {
  const result = buildFortnoxVoucherDraft(entry, config)
  expect(result.status).toBe('BLOCKED')
  expect(result.liveExportAllowed).toBe(false)
  if (result.status !== 'BLOCKED') throw new Error('Expected blocked')
  expect(result.reason.code).toBe(code)
  expect(result.reason.path.length).toBeGreaterThan(0)
  expect(result.reason.message.length).toBeGreaterThan(0)
  expect('payload' in result).toBe(false)
}

describe('buildFortnoxVoucherDraft — pure disabled preparation', () => {
  it('uses only explicit external account/year/series mappings and carries exact provenance', () => {
    const { entry, config } = fixture()
    const result = buildFortnoxVoucherDraft(entry, config)
    expect(result.status).toBe('READY_DRY_RUN')
    if (result.status !== 'READY_DRY_RUN') throw new Error('Expected draft')
    expect(result.liveExportAllowed).toBe(false)
    expect(result.query).toEqual({ financialyear: 17 })
    expect(result.payload.Voucher).toMatchObject({ TransactionDate: '2026-10-01', VoucherSeries: 'L' })
    expect(result.payload.Voucher.VoucherRows).toEqual([
      { Account: 5180, Debit: 100.1, Description: 'Repair' }, { Account: 2440, Credit: 100.1 },
    ])
    expect(result.payload.Voucher).not.toHaveProperty('VoucherNumber')
    expect(result.payload.Voucher).not.toHaveProperty('ReferenceType')
    expect(result.provenance.totalDebitOre).toBe('10010')
    expect(result.provenance.totalCreditOre).toBe('10010')
    expect(result.provenance.lines[0]?.debit).toBe('100.10')
    expect(result.provenance.localVerNumber).toBe(7)
  })

  it('sums 0.1 + 0.2 exactly against 0.3', () => {
    const { entry, config } = fixture()
    const result = buildFortnoxVoucherDraft({ ...entry, lines: [
      { ...entry.lines[0]!, debit: '0.1' },
      { ...entry.lines[0]!, id: 'line-3', debit: '0.2' },
      { ...entry.lines[1]!, credit: '0.3' },
    ] }, config)
    expect(result.status).toBe('READY_DRY_RUN')
    if (result.status === 'READY_DRY_RUN') expect(result.provenance.totalDebitOre).toBe('30')
  })

  it('R-5: POST-kroppen har exakt nycklarna {Comments, Description, TransactionDate, VoucherRows, VoucherSeries}', () => {
    const { entry, config } = fixture()
    const result = buildFortnoxVoucherDraft(entry, config)
    if (result.status !== 'READY_DRY_RUN') throw new Error('Expected draft')
    expect(Object.keys(result.payload)).toEqual(['Voucher'])
    // Comments finns i guidens POST-exempel (vouchers.html); övriga fält är guidens kärnfält.
    expect(Object.keys(result.payload.Voucher).sort()).toEqual([
      'Comments', 'Description', 'TransactionDate', 'VoucherRows', 'VoucherSeries',
    ])
  })

  // R-6: ersätter 'never infers the required payload Year field…' (byggde på OpenAPI; motbevisat
  // live 2026-10-03T01:20:44Z: 400/2000321 "Fältet Year är endast läsbart.", svar-0069 sha 3f7e5ec1).
  it('EX-1: Year skickas ALDRIG i POST-kroppen; året bärs bara av query financialyear', () => {
    const { entry, config } = fixture()
    const result = buildFortnoxVoucherDraft(entry, { ...config, financialYear: { ...config.financialYear, voucherYear: 2026 } })
    if (result.status !== 'READY_DRY_RUN') throw new Error('Expected draft')
    expect(result.query.financialyear).toBe(17)
    expect(result.payload.Voucher).not.toHaveProperty('Year')
    blocked(entry, { ...config, financialYear: { ...config.financialYear, voucherYear: undefined as never } }, 'FINANCIAL_YEAR_MISMATCH')
  })

  it('preserves the largest source Decimal(10,2) in the actual JSON numeric token', () => {
    const { entry, config } = fixture()
    const result = buildFortnoxVoucherDraft({ ...entry, lines: [
      { ...entry.lines[0]!, debit: '99999999.99' }, { ...entry.lines[1]!, credit: '99999999.99' },
    ] }, config)
    expect(result.status).toBe('READY_DRY_RUN')
    if (result.status === 'READY_DRY_RUN') {
      expect(JSON.stringify(result.payload)).toContain('"Debit":99999999.99')
      expect(result.provenance.totalDebitOre).toBe('9999999999')
    }
  })

  it('rejects a one-ore imbalance without rounding tolerance', () => {
    const { entry, config } = fixture()
    blocked({ ...entry, lines: [entry.lines[0]!, { ...entry.lines[1]!, credit: '100.11' }] }, config, 'UNBALANCED_JOURNAL')
  })

  it.each(['0', '0.00', '-0.00', '-100.10'])('blocks unverified amount semantics %s without sign conversion', (amount) => {
    const { entry, config } = fixture()
    blocked({ ...entry, lines: [{ ...entry.lines[0]!, debit: amount }, { ...entry.lines[1]!, credit: amount }] },
      config, 'BLOCKED_UNVERIFIED_AMOUNT_SEMANTICS')
  })

  it.each(['1.001', '1e2', 'NaN', 'Infinity', '100000000.00', ' 100.10', '100,10', ''])('rejects decimal input %s without coercion', (amount) => {
    const { entry, config } = fixture()
    blocked({ ...entry, lines: [{ ...entry.lines[0]!, debit: amount }, entry.lines[1]!] }, config, 'INVALID_DECIMAL')
  })

  it('rejects runtime float input even when TypeScript is bypassed', () => {
    const { entry, config } = fixture()
    blocked({ ...entry, lines: [{ ...entry.lines[0]!, debit: 100.1 as unknown as string }, entry.lines[1]!] }, config, 'INVALID_DECIMAL')
  })

  it.each([{ debit: null, credit: null }, { debit: '100.10', credit: '0' }])('never nets both/empty sides %j', (amounts) => {
    const { entry, config } = fixture()
    blocked({ ...entry, lines: [{ ...entry.lines[0]!, ...amounts }, entry.lines[1]!] }, config, 'AMBIGUOUS_JOURNAL_SIDE')
  })

  it('does not call empty input a successful no-op or invent a balancing line', () => {
    const { entry, config } = fixture()
    blocked({ ...entry, lines: [] }, config, 'NO_EXPORTABLE_LINES')
    blocked({ ...entry, lines: [entry.lines[0]!] }, config, 'NO_EXPORTABLE_LINES')
  })

  it('preserves correction rows as stored without replacing or reversing another journal', () => {
    const { entry, config } = fixture()
    const result = buildFortnoxVoucherDraft({ ...entry, reversalOfEntryId: 'original-entry', lines: [
      { ...entry.lines[0]!, debit: null, credit: '100.10' }, { ...entry.lines[1]!, debit: '100.10', credit: null },
    ] }, config)
    expect(result.status).toBe('READY_DRY_RUN')
    if (result.status === 'READY_DRY_RUN') {
      expect(result.provenance.reversalOfEntryId).toBe('original-entry')
      expect(result.payload.Voucher.VoucherRows[0]).toHaveProperty('Credit', 100.1)
    }
  })

  it.each(['2026-07-01', '2027-06-30'])('includes external year boundary %s', (date) => {
    const { entry, config } = fixture()
    expect(buildFortnoxVoucherDraft({ ...entry, date }, config).status).toBe('READY_DRY_RUN')
  })

  it.each(['2026-06-30', '2027-07-01'])('blocks dates outside the explicitly mapped year %s', (date) => {
    const { entry, config } = fixture(); blocked({ ...entry, date }, config, 'FINANCIAL_YEAR_MISMATCH')
  })

  it.each(['2026-02-29', '2026-13-01', '2026-1-01', '2026-10-01T23:00:00Z', '0000-01-01'])('rejects invalid or ambiguous date %s', (date) => {
    const { entry, config } = fixture(); blocked({ ...entry, date }, config, 'INVALID_DATE')
  })

  it('accepts the actual Prisma UTC midnight representation without using local timezone', () => {
    const { entry, config } = fixture()
    expect(buildFortnoxVoucherDraft({ ...entry, date: new Date('2026-10-01T00:00:00Z') }, config).status).toBe('READY_DRY_RUN')
    blocked({ ...entry, date: new Date('2026-10-01T01:00:00Z') }, config, 'INVALID_DATE')
    blocked({ ...entry, date: new Date('invalid') }, config, 'INVALID_DATE')
  })

  it('keeps the actual event date while exporting the later booking date', () => {
    const { entry, config } = fixture()
    const result = buildFortnoxVoucherDraft({ ...entry, eventDate: '2026-06-30' }, config)
    expect(result.status).toBe('READY_DRY_RUN')
    if (result.status === 'READY_DRY_RUN') {
      expect(result.payload.Voucher.TransactionDate).toBe('2026-10-01')
      expect(result.payload.Voucher.Comments).toContain('eventDate 2026-06-30')
      expect(result.provenance.eventDate).toBe('2026-06-30')
    }
  })

  it('blocks AI origin, AI execution references and unknown sources', () => {
    const { entry, config } = fixture()
    blocked({ ...entry, source: 'AI' }, config, 'AI_SOURCE_BLOCKED')
    blocked({ ...entry, aiToolExecutionId: 'execution-1' }, config, 'AI_SOURCE_BLOCKED')
    blocked({ ...entry, source: 'NEW_UNKNOWN_SOURCE' }, config, 'UNVERIFIED_SOURCE')
    blocked({ ...entry, inputOrigin: 'AI_DRAFT' as never }, config, 'UNTRUSTED_SOURCE')
  })

  it('rejects foreign journal, line, account and mapping scopes', () => {
    const { entry, config } = fixture()
    blocked({ ...entry, organizationId: 'org-2' }, config, 'ORGANIZATION_MISMATCH')
    blocked({ ...entry, lines: [{ ...entry.lines[0]!, journalEntryId: 'entry-2' }, entry.lines[1]!] }, config, 'INVALID_LINE_IDENTITY')
    blocked({ ...entry, lines: [{ ...entry.lines[0]!, account: { ...entry.lines[0]!.account, organizationId: 'org-2' } }, entry.lines[1]!] }, config, 'ACCOUNT_SCOPE_MISMATCH')
    blocked(entry, { ...config, accounts: [{ ...config.accounts[0]!, organizationId: 'org-2' }, config.accounts[1]!] }, 'MAPPING_SCOPE_MISMATCH')
    blocked(entry, { ...config, financialYear: { ...config.financialYear, externalDatabaseNumber: 900002 } }, 'MAPPING_SCOPE_MISMATCH')
  })

  it('requires verified company/year/series/account bindings', () => {
    const { entry, config } = fixture()
    blocked(entry, { ...config, externalCompany: { ...config.externalCompany, evidenceRef: '' } }, 'UNVERIFIED_COMPANY')
    blocked(entry, { ...config, financialYear: { ...config.financialYear, evidenceRef: '' } }, 'UNVERIFIED_MAPPING')
    blocked(entry, { ...config, financialYear: { ...config.financialYear, localFiscalYear: 2025 } }, 'FINANCIAL_YEAR_MISMATCH')
    blocked(entry, { ...config, voucherSeries: { ...config.voucherSeries, financialYearId: 18 } }, 'INVALID_SERIES')
    blocked(entry, { ...config, accounts: [] }, 'MISSING_ACCOUNT_MAPPING')
    blocked(entry, { ...config, accounts: [...config.accounts, config.accounts[0]!] }, 'AMBIGUOUS_ACCOUNT_MAPPING')
    blocked(entry, { ...config, accounts: [{ ...config.accounts[0]!, externalAccountNumber: 999 }, config.accounts[1]!] }, 'INVALID_EXTERNAL_ACCOUNT')
  })

  it('requires a deliberate verified dimension omission and never guesses from description', () => {
    const { entry, config, proof } = fixture()
    blocked(entry, { ...config, dimensions: undefined as never }, 'UNVERIFIED_DIMENSIONS')
    blocked(entry, { ...config, dimensions: { ...proof, mode: 'OMIT', reason: '' } }, 'UNVERIFIED_DIMENSIONS')
    blocked(entry, { ...config, dimensions: { ...proof, mode: 'OMIT', reason: 'Approved', evidenceRef: '' } }, 'UNVERIFIED_MAPPING')
    const result = buildFortnoxVoucherDraft({ ...entry, description: 'HUSA project 123' }, config)
    if (result.status !== 'READY_DRY_RUN') throw new Error('Expected draft')
    expect(result.payload.Voucher.VoucherRows[0]).not.toHaveProperty('CostCenter')
    expect(result.payload.Voucher.VoucherRows[0]).not.toHaveProperty('Project')
  })

  it('uses independently verified dimensions on each exact line and blocks partial/stale/duplicate maps', () => {
    const { entry, config, proof } = fixture()
    const mappings = [
      { ...proof, journalEntryLineId: 'line-1', costCenter: 'HUSA', project: 'P-17' },
      { ...proof, journalEntryLineId: 'line-2', costCenter: null, project: null },
    ]
    const result = buildFortnoxVoucherDraft(entry, { ...config, dimensions: { mode: 'PER_LINE', lines: mappings } })
    expect(result.status).toBe('READY_DRY_RUN')
    if (result.status === 'READY_DRY_RUN') {
      expect(result.payload.Voucher.VoucherRows[0]).toMatchObject({ CostCenter: 'HUSA', Project: 'P-17' })
      expect(result.payload.Voucher.VoucherRows[1]).not.toHaveProperty('CostCenter')
    }
    blocked(entry, { ...config, dimensions: { mode: 'PER_LINE', lines: mappings.slice(0, 1) } }, 'MISSING_DIMENSION_MAPPING')
    blocked(entry, { ...config, dimensions: { mode: 'PER_LINE', lines: [...mappings, { ...mappings[0]!, journalEntryLineId: 'other-line' }] } }, 'EXTRANEOUS_DIMENSION_MAPPING')
    blocked(entry, { ...config, dimensions: { mode: 'PER_LINE', lines: [...mappings, mappings[0]!] } }, 'AMBIGUOUS_DIMENSIONS')
  })

  it('blocks too-long descriptions rather than silently truncating local 300-character text to 200', () => {
    const { entry, config } = fixture()
    blocked({ ...entry, description: 'A'.repeat(201) }, config, 'DESCRIPTION_UNREPRESENTABLE')
    expect(buildFortnoxVoucherDraft({ ...entry, description: 'A'.repeat(200) }, config).status).toBe('READY_DRY_RUN')
  })

  it('blocks duplicate line identities instead of deduplicating accounting rows', () => {
    const { entry, config } = fixture()
    blocked({ ...entry, lines: [entry.lines[0]!, { ...entry.lines[1]!, id: 'line-1' }] }, config, 'INVALID_LINE_IDENTITY')
  })

  it('is deterministic, does not mutate its inputs and does not alias external company provenance', () => {
    const { entry, config } = fixture(); const before = JSON.stringify({ entry, config })
    const first = buildFortnoxVoucherDraft(entry, config)
    expect(buildFortnoxVoucherDraft(entry, config)).toEqual(first)
    expect(JSON.stringify({ entry, config })).toBe(before)
    if (first.status === 'READY_DRY_RUN') {
      first.provenance.externalCompany.databaseNumber = 5
      expect(config.externalCompany.databaseNumber).toBe(900001)
    }
  })

  it('fails closed for malformed runtime objects', () => {
    expect(buildFortnoxVoucherDraft(null as never, null as never).status).toBe('BLOCKED')
    const { entry, config } = fixture()
    expect(buildFortnoxVoucherDraft({ ...entry, lines: [null] as never }, config).status).toBe('BLOCKED')
  })
})
