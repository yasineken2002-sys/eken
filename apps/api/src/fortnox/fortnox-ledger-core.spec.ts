import {
  Incomplete as FacadeIncomplete,
  toOre as facadeToOre,
  type LedgerReadConfig,
  type LedgerReadResult,
} from './fortnox-ledger'
import { createLedgerAccumulator } from './fortnox-ledger-reducer'
import {
  Incomplete,
  stable,
  toOre,
  validateLedgerVoucher,
  type ValidatedLedgerVoucher,
} from './fortnox-ledger-validation'
import type { FortnoxVoucher } from './fortnox.types'

const YEAR = { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' }
const LIMITATION =
  'Läsningen är en genomgång sida för sida, inte en låst ögonblicksbild: ändringar under läsningen och raderingar upptäcks inte alltid.'
const EXPORTED_WARNING =
  'En del av beloppet kommer från verifikat som Eveno själv har exporterat; lägg inte ihop det med Evenos egna siffror.'
const INITIAL_WARNING = 'Konto 5170 är inaktivt i Fortnox.'

function voucher(
  number: number,
  date: string,
  rows: unknown[],
  extra: Record<string, unknown> = {},
): FortnoxVoucher {
  return {
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: number,
    TransactionDate: date,
    VoucherRows: rows,
    ...extra,
  }
}

const balanced = [
  { Account: 5170, Debit: 10.05 },
  { Account: 2440, Credit: 10.05 },
]
const cfg: LedgerReadConfig = {
  expectedDatabaseNumber: 900001,
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
  mappings: new Map([
    ['COST_CENTER:A', { propertyId: 'p-ost', propertyName: 'Öst' }],
    ['PROJECT:P', { propertyId: 'p-as', propertyName: 'Ås' }],
  ]),
  evenoExported: new Set(['1|L|2', '1|L|4']),
}

function base(): Pick<
  LedgerReadResult,
  'coverage' | 'uncertainties' | 'references' | 'financialYear'
> {
  return {
    financialYear: { ...YEAR },
    coverage: {
      '/3/vouchers/sublist': { pages: 3, totalPages: 3, totalResources: 6, itemsSeen: 6 },
    },
    uncertainties: [INITIAL_WARNING],
    references: [],
  }
}

describe('Fortnox-kärnans validerade normalform', () => {
  it('behåller fasadens Incomplete-klass och toOre för befintliga sändningscatchar', () => {
    expect(Incomplete).toBe(FacadeIncomplete)
    expect(new Incomplete('Syntetiskt fel')).toBeInstanceOf(FacadeIncomplete)
    expect(toOre).toBe(facadeToOre)
  })

  it('upptäcker ändrade okända JSON-fält oberoende av objektens nyckelordning', () => {
    const original = { Year: 1, VoucherSeries: 'L', VoucherNumber: 1, extra: { x: 1, y: 2 } }
    const reordered = { extra: { y: 2, x: 1 }, VoucherNumber: 1, VoucherSeries: 'L', Year: 1 }
    const changed = { ...original, extra: { x: 2, y: 2 } }
    expect(stable(original)).toBe(stable(reordered))
    expect(stable(original)).not.toBe(stable(changed))
  })

  it('överlever JSON-rundtur utan fritext, råfält eller förlorade ursprungliga radindex', () => {
    const raw = voucher(
      1,
      '2026-10-01',
      [
        {
          Account: 2440,
          Credit: 10.05,
          Debit: null,
          Description: 'RAW_ROW_DESCRIPTION',
          UnknownRow: { text: 'RAW_UNKNOWN_ROW' },
        },
        {
          Account: 5170,
          Debit: 10.05,
          Credit: undefined,
          CostCenter: '',
          Project: null,
          Removed: true,
          Comments: 'RAW_ROW_COMMENTS',
        },
      ],
      {
        Description: 'RAW_DESCRIPTION',
        Comments: 'RAW_COMMENTS',
        UnknownVoucher: { text: 'RAW_UNKNOWN_VOUCHER' },
        CostCenter: { text: 'RAW_HEADER_DIMENSION' },
        ReferenceType: { text: 'RAW_REFERENCE_TYPE' },
        ReferenceNumber: 'L123',
      },
    )
    const normalized = validateLedgerVoucher('1|L|1', raw, YEAR)
    const expected: ValidatedLedgerVoucher = {
      key: '1|L|1',
      date: '2026-10-01',
      headerDimensionPresent: true,
      reference: { type: null, number: 'L123' },
      rows: [
        {
          index1: 1,
          account: 2440,
          debitOre: 0,
          creditOre: 1005,
          costCenter: null,
          project: null,
          removed: false,
        },
        {
          index1: 2,
          account: 5170,
          debitOre: 1005,
          creditOre: 0,
          costCenter: null,
          project: null,
          removed: true,
        },
      ],
    }
    expect(normalized).toStrictEqual(expected)
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toMatch(/RAW_|Description|Comments|Unknown|VoucherRows/)
    const restored: ValidatedLedgerVoucher = JSON.parse(serialized)
    expect(restored).toStrictEqual(expected)
    const accumulator = createLedgerAccumulator(cfg, base())
    accumulator.add(restored)
    expect(accumulator.finish().rows).toEqual([
      {
        voucher: '1|L|1',
        row: 2,
        transactionDate: '2026-10-01',
        account: 5170,
        amountOre: 1005,
        bucket: 'UNCERTAIN_REMOVED',
        dimensionType: null,
        code: null,
        propertyId: null,
        evenoExport: false,
      },
    ])
  })

  it.each([
    [{}, null],
    [{ ReferenceType: '', ReferenceNumber: '' }, null],
    [
      { ReferenceType: '', ReferenceNumber: '17' },
      { type: '', number: '17' },
    ],
    [
      { ReferenceType: 7, ReferenceNumber: false },
      { type: null, number: null },
    ],
    [{ ReferenceType: 'MANUAL' }, { type: 'MANUAL', number: null }],
  ] as const)('bevarar tidigare referenssemantik för %p', (extra, expected) => {
    expect(
      validateLedgerVoucher('1|L|1', voucher(1, '2026-10-01', balanced, extra), YEAR).reference,
    ).toStrictEqual(expected)
  })

  it.each([
    { Debit: 10.05 },
    { Debit: 10.05, Credit: null },
    { Debit: 10.05, Credit: undefined },
    { Credit: 10.05 },
    { Credit: 10.05, Debit: null },
    { Credit: 10.05, Debit: undefined },
  ])('normaliserar bara den saknade inaktiva beloppssidan till noll: %p', (amounts) => {
    const result = validateLedgerVoucher(
      '1|L|1',
      voucher(1, '2026-10-01', [{ Account: 5170, ...amounts }, balanced[1]]),
      YEAR,
    )
    expect(result.rows[0]?.debitOre).toBe(amounts.Debit === 10.05 ? 1005 : 0)
    expect(result.rows[0]?.creditOre).toBe(amounts.Credit === 10.05 ? 1005 : 0)
  })

  it.each([
    ['nullrad', null, 'rad saknas'],
    ['konto som sträng', { Account: '5170', Debit: 1 }, 'ogiltigt konto'],
    ['konto utanför intervallet', { Account: 10000, Debit: 1 }, 'ogiltigt konto'],
    ['båda sidor utelämnade', { Account: 5170 }, 'belopp saknas på båda sidor'],
    [
      'båda sidor null',
      { Account: 5170, Debit: null, Credit: null },
      'belopp saknas på båda sidor',
    ],
    [
      'null och undefined',
      { Account: 5170, Debit: null, Credit: undefined },
      'belopp saknas på båda sidor',
    ],
    ['belopp som sträng', { Account: 5170, Debit: '1.00' }, 'ogiltigt belopp'],
    ['för många decimaler', { Account: 5170, Debit: 10.005 }, 'ogiltigt belopp'],
    ['icke-ändligt belopp', { Account: 5170, Debit: Infinity }, 'ogiltigt belopp'],
    ['negativ debet', { Account: 5170, Debit: -1 }, 'negativt belopp (semantik obelagd)'],
    ['Removed null', { Account: 5170, Debit: 1, Removed: null }, 'ogiltig borttagningsmarkering'],
    [
      'Removed sträng',
      { Account: 5170, Debit: 1, Removed: 'true' },
      'ogiltig borttagningsmarkering',
    ],
    ['dimension som tal', { Account: 5170, Debit: 1, CostCenter: 7 }, 'ogiltig dimension'],
    ['projekt som objekt', { Account: 5170, Debit: 1, Project: {} }, 'ogiltig dimension'],
    ['fel på annat konto', { Account: 2440, Credit: '1' }, 'ogiltigt belopp'],
  ] as const)(
    'avvisar %s även utanför vald period och anger ursprunglig rad',
    (_name, row, reason) => {
      const raw = voucher(1, '2026-03-01', [balanced[0], row])
      expect(() => validateLedgerVoucher('1|L|1', raw, YEAR)).toThrow(Incomplete)
      expect(() => validateLedgerVoucher('1|L|1', raw, YEAR)).toThrow(
        `Verifikat 1|L|1 rad 2: ${reason}`,
      )
    },
  )

  it.each([{ rows: undefined }, { rows: [] }, { rows: [balanced[0]] }])(
    'nekar saknade eller för få rader: $rows',
    ({ rows }) => {
      const raw = { ...voucher(1, '2026-03-01', balanced), VoucherRows: rows }
      expect(() => validateLedgerVoucher('1|L|1', raw, YEAR)).toThrow(
        'Verifikat 1|L|1 saknar rader',
      )
    },
  )

  it.each(['2026-02-30', '2025-12-31', '2027-01-01', '2026-10-01T00:00:00Z'])(
    'nekar ogiltigt eller årsfelaktigt datum %s före periodurval',
    (date) => {
      expect(() => validateLedgerVoucher('1|L|1', voucher(1, date, balanced), YEAR)).toThrow(
        'Verifikat 1|L|1 har saknat eller ogiltigt datum',
      )
    },
  )

  it('nekar saknad detalj, annan identitet och fel räkenskapsår utan att gissa', () => {
    expect(() => validateLedgerVoucher('1|L|1', undefined, YEAR)).toThrow(Incomplete)
    expect(() => validateLedgerVoucher('1|L|2', voucher(1, '2026-10-01', balanced), YEAR)).toThrow(
      'Detalj saknas eller avviker för verifikat 1|L|2',
    )
    expect(() =>
      validateLedgerVoucher('2|L|1', voucher(1, '2026-10-01', balanced, { Year: 2 }), YEAR),
    ).toThrow('Verifikat 2|L|1 hör till fel räkenskapsår')
  })
})

/** Förväntade belopp nedan är handräknade; ingen annan reducer används som facit. */
const orderedVouchers = [
  voucher(1, '2026-02-01', balanced, { ReferenceNumber: 'UTANFOR_FORE' }),
  voucher(
    10,
    '2026-10-01',
    [
      { Account: 2440, Credit: 100.05 },
      { Account: 5170, Debit: 100.05, CostCenter: 'A', Project: 'P' },
      { Account: 5170, Credit: 20.02, CostCenter: 'A' },
    ],
    { ReferenceType: 'MANUAL', ReferenceNumber: 'L1' },
  ),
  voucher(2, '2026-10-15', [
    { Account: 5170, Debit: 30.01, Project: 'P' },
    { Account: 5170, Debit: 5, CostCenter: 'Z' },
    { Account: 5170, Credit: 1.01, Project: 'X' },
    { Account: 2440, Credit: 34 },
  ]),
  voucher(
    3,
    '2026-10-20',
    [
      { Account: 5170, Debit: 7.77, CostCenter: null, Project: null },
      { Account: 5170, Credit: 2.22 },
      { Account: 2440, Credit: 5.55 },
    ],
    { CostCenter: 'HEADER' },
  ),
  voucher(
    4,
    '2026-10-31',
    [
      { Account: 5170, Debit: 9.99, CostCenter: 'A', Removed: true },
      { Account: 5170, Debit: 0, Removed: false },
      { Account: 2440, Credit: 9.99 },
    ],
    { ReferenceType: 42 },
  ),
  voucher(5, '2026-11-01', balanced, { ReferenceNumber: 'UTANFOR_EFTER' }),
].map((raw) => validateLedgerVoucher(`1|L|${String(raw.VoucherNumber)}`, raw, YEAR))

describe('Fortnox-kärnans inkrementella beräkning', () => {
  it.each([
    { sizes: [6] },
    { sizes: [1, 1, 1, 1, 1, 1] },
    { sizes: [2, 0, 3, 1] },
    { sizes: [0, 3, 0, 3, 0] },
  ])('ger samma manuella facit över batchgränser $sizes och JSON-rundturer', ({ sizes }) => {
    const inputBase = base()
    const accumulator = createLedgerAccumulator(cfg, inputBase)
    const intermediateResults: Array<{ actual: LedgerReadResult; frozen: LedgerReadResult }> = []
    let offset = 0
    for (const size of sizes) {
      const batch: ValidatedLedgerVoucher[] = JSON.parse(
        JSON.stringify(orderedVouchers.slice(offset, offset + size)),
      )
      for (const item of batch) accumulator.add(item)
      offset += size
      // Senare add får varken ändra tidigare resultat eller ärva dess slutvarningar.
      const actual = accumulator.finish()
      intermediateResults.push({ actual, frozen: JSON.parse(JSON.stringify(actual)) })
    }
    expect(offset).toBe(orderedVouchers.length)
    for (const { actual, frozen } of intermediateResults) expect(actual).toStrictEqual(frozen)
    const result = accumulator.finish()
    expect(result.status).toBe('COMPLETE_WITH_UNCERTAINTY')
    expect(result.reason).toBeNull()
    expect(result.financialYear).toEqual(YEAR)
    expect(result.coverage).toEqual(inputBase.coverage)
    expect(result.summary).toStrictEqual({
      currency: 'SEK',
      totalOre: 11958,
      byProperty: [
        { propertyId: 'p-as', propertyName: 'Ås', amountOre: 3001 },
        { propertyId: 'p-ost', propertyName: 'Öst', amountOre: 8003 },
      ],
      unmappedDimensions: [
        { dimensionType: 'PROJECT', code: 'X', amountOre: -101 },
        { dimensionType: 'COST_CENTER', code: 'Z', amountOre: 500 },
      ],
      unallocatedOre: 555,
      uncertainRemovedOre: 999,
      evenoExportOre: 3400,
    })
    expect(
      result.rows?.map((r) => [r.voucher, r.row, r.amountOre, r.bucket, r.code, r.evenoExport]),
    ).toEqual([
      ['1|L|10', 2, 10005, 'PROPERTY', 'A', false],
      ['1|L|10', 3, -2002, 'PROPERTY', 'A', false],
      ['1|L|2', 1, 3001, 'PROPERTY', 'P', true],
      ['1|L|2', 2, 500, 'UNMAPPED', 'Z', true],
      ['1|L|2', 3, -101, 'UNMAPPED', 'X', true],
      ['1|L|3', 1, 777, 'UNALLOCATED', null, false],
      ['1|L|3', 2, -222, 'UNALLOCATED', null, false],
      ['1|L|4', 1, 999, 'UNCERTAIN_REMOVED', 'A', true],
      ['1|L|4', 2, 0, 'UNALLOCATED', null, true],
    ])
    expect(result.references).toStrictEqual([
      { voucher: '1|L|10', referenceType: 'MANUAL', referenceNumber: 'L1' },
      { voucher: '1|L|4', referenceType: null, referenceNumber: null },
    ])
    const headerWarning =
      'Verifikat 1|L|3: dimension finns bara på verifikatets huvud och har inte förts över till raden.'
    expect(result.uncertainties).toStrictEqual([
      INITIAL_WARNING,
      headerWarning,
      headerWarning,
      'Verifikat 1|L|4 rad 1 är markerad som borttagen i Fortnox; innebörden är inte belagd och raden ingår inte i summan.',
      '2 Fortnox-dimension(er) saknar koppling till fastighet och redovisas som okopplade.',
      EXPORTED_WARNING,
      LIMITATION,
    ])
    const warningPrefix = [...inputBase.uncertainties]
    expect(accumulator.finish()).toStrictEqual(result)
    expect(accumulator.finish()).toStrictEqual(result)
    expect(inputBase.uncertainties).toStrictEqual(warningPrefix)
    expect(inputBase.uncertainties).not.toContain(LIMITATION)
    expect(inputBase.uncertainties).not.toContain(EXPORTED_WARNING)
  })

  it('giltiga rader utanför perioden ger noll utan referenser eller huvudvarningar', () => {
    const inputBase = base()
    inputBase.uncertainties = []
    const accumulator = createLedgerAccumulator(cfg, inputBase)
    accumulator.add(
      validateLedgerVoucher(
        '1|L|1',
        voucher(1, '2026-03-01', balanced, { CostCenter: 'HEADER', ReferenceNumber: 'outside' }),
        YEAR,
      ),
    )
    const result = accumulator.finish()
    expect(result.status).toBe('COMPLETE')
    expect(result.rows).toStrictEqual([])
    expect(result.references).toStrictEqual([])
    expect(result.uncertainties).toStrictEqual([LIMITATION])
    expect(result.summary).toStrictEqual({
      currency: 'SEK',
      totalOre: 0,
      byProperty: [],
      unmappedDimensions: [],
      unallocatedOre: 0,
      uncertainRemovedOre: 0,
      evenoExportOre: 0,
    })
  })

  it('okopplad dimension varnar men ändrar inte den befintliga COMPLETE-statusen', () => {
    const inputBase = base()
    inputBase.uncertainties = []
    const accumulator = createLedgerAccumulator(cfg, inputBase)
    accumulator.add(
      validateLedgerVoucher(
        '1|L|1',
        voucher(1, '2026-10-01', [
          { Account: 5170, Debit: 1, CostCenter: 'UNKNOWN' },
          { Account: 2440, Credit: 1 },
        ]),
        YEAR,
      ),
    )
    expect(accumulator.finish()).toMatchObject({
      status: 'COMPLETE',
      summary: { totalOre: 100, unmappedDimensions: [{ code: 'UNKNOWN', amountOre: 100 }] },
      uncertainties: [
        '1 Fortnox-dimension(er) saknar koppling till fastighet och redovisas som okopplade.',
        LIMITATION,
      ],
    })
  })

  it('overflow låser add och finish till samma fel utan att ändra det lästa prefixet igen', () => {
    const inputBase = base()
    const accumulator = createLedgerAccumulator(cfg, inputBase)
    accumulator.add(
      validateLedgerVoucher(
        '1|L|1',
        voucher(1, '2026-10-01', [
          { Account: 5170, Debit: 90071992547409.9 },
          { Account: 2440, Credit: 90071992547409.9 },
        ]),
        YEAR,
      ),
    )
    const overflows = validateLedgerVoucher(
      '1|L|2',
      voucher(
        2,
        '2026-10-02',
        [
          { Account: 5170, Debit: 0.02 },
          { Account: 2440, Credit: 0.02 },
        ],
        { ReferenceType: 'MANUAL', ReferenceNumber: 'L1' },
      ),
      YEAR,
    )
    let originalError: unknown
    try {
      accumulator.add(overflows)
    } catch (error) {
      originalError = error
    }
    expect(originalError).toBeInstanceOf(FacadeIncomplete)
    expect(inputBase.references).toStrictEqual([
      { voucher: '1|L|2', referenceType: 'MANUAL', referenceNumber: 'L1' },
    ])
    const observedPrefix = JSON.parse(JSON.stringify(inputBase))
    const next = validateLedgerVoucher(
      '1|L|3',
      voucher(3, '2026-10-03', balanced, { ReferenceNumber: 'FAR_INTE_LAGGAS_TILL' }),
      YEAR,
    )
    for (const attempt of [() => accumulator.add(next), () => accumulator.finish()]) {
      let laterError: unknown
      try {
        attempt()
      } catch (error) {
        laterError = error
      }
      expect(laterError).toBe(originalError)
      expect(inputBase).toStrictEqual(observedPrefix)
    }
  })
})
