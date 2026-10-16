/**
 * Referens före parser-/reducerrefaktor: oförändrad readLedger på HEAD 2b7d6817.
 * Root skapar snapshots med --updateSnapshot FÖRE produktionsinkopplingen.
 * Därefter får snapshots inte uppdateras för att få en ändrad reducer grön.
 * Hela LedgerReadResult och detaljanropens faktiska ordning sparas oförändrade:
 * inga serializers, avrundningar, sorteringar eller borttagna resultatfält.
 * Syntetisk injicerad GET-port; ingen databas, tokenförnyelse eller extern trafik.
 */
import { MockFortnoxLedgerReader } from './fortnox-providers'
import {
  readLedger,
  type LedgerReadConfig,
  type LedgerReadResult,
  type LedgerStatus,
} from './fortnox-ledger'
import { FortnoxReadError, type FortnoxLedgerReader, type FortnoxVoucher } from './fortnox.types'

const row = (Account: number, Debit = 0, Credit = 0, extra: Record<string, unknown> = {}) => ({
  Account,
  Debit,
  Credit,
  Removed: false,
  ...extra,
})

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

// Samma ekonomiska S1–S4-facit som fortnox-ledger.spec.ts; här låses HELA utfallet.
const K1 = voucher(1, '2026-10-02', [
  row(5170, 12000, 0, { CostCenter: 'HUSA' }),
  row(2440, 0, 12000),
])
const K2 = voucher(2, '2026-10-05', [
  row(5170, 4000, 0, { CostCenter: 'HUSA' }),
  row(5170, 2000, 0, { CostCenter: 'HUSB' }),
  row(2440, 0, 6000),
])
const K3 = voucher(3, '2026-10-07', [row(5170, 2000), row(2440, 0, 2000)])
const REV = voucher(
  4,
  '2026-10-20',
  [row(5170, 0, 12000, { CostCenter: 'HUSA' }), row(2440, 12000)],
  {
    ReferenceType: 'MANUAL',
    ReferenceNumber: 'L1',
  },
)
const NEW = voucher(5, '2026-10-20', [
  row(5170, 15000, 0, { CostCenter: 'HUSA' }),
  row(2440, 0, 15000),
])
const DIFF = voucher(4, '2026-10-20', [
  row(5170, 3000, 0, { CostCenter: 'HUSA' }),
  row(2440, 0, 3000),
])

const REMOVED = voucher(1, '2026-10-02', [row(5170, 5, 0, { Removed: true }), row(2440, 0, 5)], {
  ReferenceType: 'MANUAL',
  ReferenceNumber: 'tidigare-L1',
})
const HEADER_DIMENSION = voucher(2, '2026-10-05', [row(5170, 7), row(2440, 0, 7)], {
  CostCenter: 'HUSB',
  ReferenceType: 'MANUAL',
  ReferenceNumber: 'tidigare-L2',
})
const HUGE = voucher(
  3,
  '2026-10-06',
  [row(5170, 90071992547409.9, 0, { CostCenter: 'HUSA' }), row(2440, 0, 90071992547409.9)],
  {
    ReferenceType: 'MANUAL',
    ReferenceNumber: 'tidigare-L3',
  },
)
// Två rader och ett giltigt datum utanför vald period: felet ska verkligen
// komma från den andra radens parser, inte från datum-/minimiantalgrinden.
const LATE_INVALID = voucher(9, '2026-03-01', [
  row(5170, 1),
  { Account: '2440', Debit: 0, Credit: 1 },
])
const LATE_VALID = voucher(9, '2026-10-09', [row(5170, 1), row(2440, 0, 1)])

type Query = Readonly<Record<string, string | number>>
type Rewrite = (path: string, query: Query | undefined, body: unknown) => unknown

/**
 * Felen och den avsiktliga listdublettens svar injiceras vid portgränsen.
 * Varje faktisk detaljbegäran registreras före svaret, även den som kastar.
 * Den enda generiska typassertionen nedan är samma externa GET-gräns som porten.
 */
class RecordingReader implements FortnoxLedgerReader {
  readonly details: Array<{ path: string; query: Query | null }> = []
  readonly failures = new Map<string, FortnoxReadError>()
  rewrite: Rewrite | undefined

  constructor(readonly mock: MockFortnoxLedgerReader) {}

  async get<T>(token: string, path: string, query?: Query): Promise<T> {
    if (/^\/3\/vouchers\/[A-Za-z0-9]+\/\d+$/.test(path)) {
      this.details.push({ path, query: query ? { ...query } : null })
    }
    const failure = this.failures.get(path)
    if (failure) throw failure
    const body = await this.mock.get<unknown>(token, path, query)
    return (this.rewrite ? this.rewrite(path, query, body) : body) as T
  }
}

interface Rig {
  reader: RecordingReader
  config: LedgerReadConfig
}

function rig(vouchers: FortnoxVoucher[], config: Partial<LedgerReadConfig> = {}): Rig {
  const mock = new MockFortnoxLedgerReader()
  mock.vouchers = structuredClone(vouchers)
  return {
    reader: new RecordingReader(mock),
    config: {
      expectedDatabaseNumber: 900001,
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      costAccounts: [5170],
      mappings: new Map([
        ['COST_CENTER:HUSA', { propertyId: 'p-a', propertyName: 'HUS-A' }],
        ['COST_CENTER:HUSB', { propertyId: 'p-b', propertyName: 'HUS-B' }],
      ]),
      evenoExported: new Set(),
      ...config,
    },
  }
}

function withCatalogWarning(vouchers: FortnoxVoucher[]): Rig {
  const test = rig(vouchers, { periodFrom: '2026-10-01', periodTo: '2026-10-31' })
  test.config.mappings = new Map([
    ...test.config.mappings,
    ['COST_CENTER:GHOST', { propertyId: 'p-missing', propertyName: 'Saknad dimension' }],
  ])
  return test
}

function duplicateOnSecondPage(test: Rig, duplicate: FortnoxVoucher): void {
  test.reader.rewrite = (path, query, body) => {
    if (path !== '/3/vouchers/sublist' || query?.page !== 2) return body
    if (
      !body ||
      typeof body !== 'object' ||
      !('Vouchers' in body) ||
      !Array.isArray(body.Vouchers)
    ) {
      throw new Error('Listdublettens syntetiska sida saknar Vouchers')
    }
    // Samma totalResources (unika verifikat), men en extra observerad listpost.
    return { ...body, Vouchers: [...body.Vouchers, structuredClone(duplicate)] }
  }
}

interface Scenario {
  name: string
  create: () => Rig
  status: LedgerStatus
  detailNumbers: number[]
  check?: (result: LedgerReadResult) => void
}

const scenarios: Scenario[] = [
  { name: 'S1 ett verifikat', create: () => rig([K1]), status: 'COMPLETE', detailNumbers: [1] },
  {
    name: 'S2 två fastigheter',
    create: () => rig([K1, K2]),
    status: 'COMPLETE',
    detailNumbers: [1, 2],
  },
  {
    name: 'S3 även ofördelat',
    create: () => rig([K1, K2, K3]),
    status: 'COMPLETE',
    detailNumbers: [1, 2, 3],
  },
  {
    name: 'S4a återföring och ny post',
    create: () => rig([K1, K2, K3, REV, NEW]),
    status: 'COMPLETE',
    detailNumbers: [1, 2, 3, 4, 5],
  },
  {
    name: 'S4b differenspost',
    create: () => rig([K1, K2, K3, DIFF]),
    status: 'COMPLETE',
    detailNumbers: [1, 2, 3, 4],
  },
  {
    name: 'period före rättelsen validerar ändå alla detaljer',
    create: () => rig([K1, REV, NEW], { periodFrom: '2026-10-01', periodTo: '2026-10-19' }),
    status: 'COMPLETE',
    detailNumbers: [1, 4, 5],
  },
  {
    name: 'period från rättelsedatum behåller rättelsens referens',
    create: () => rig([K1, REV, NEW], { periodFrom: '2026-10-20', periodTo: '2026-10-31' }),
    status: 'COMPLETE',
    detailNumbers: [1, 4, 5],
  },
  {
    name: 'tom vald period ger noll först efter alla detaljer',
    create: () => rig([K1, REV, NEW], { periodFrom: '2026-11-01', periodTo: '2026-11-30' }),
    status: 'COMPLETE',
    detailNumbers: [1, 4, 5],
  },
  {
    name: 'Removed, dimensioner, Eveno och lexikografisk detaljordning 1-10-2',
    create: () => {
      const headerTen = { ...HEADER_DIMENSION, VoucherNumber: 10 }
      const mixed = voucher(
        2,
        '2026-10-10',
        [
          row(5170, 10, 0, { CostCenter: 'HUSC', Project: '7' }),
          row(5170, 20, 0, { Project: '7' }),
          row(5170, 30, 0, { CostCenter: 'HUSA', Project: '7' }),
          { Account: 5170, Debit: 40 },
          { Account: 2440, Credit: 100 },
        ],
        { ReferenceNumber: 'referens-utan-typ' },
      )
      const test = rig([mixed, REMOVED, headerTen], { evenoExported: new Set(['1|L|2']) })
      test.reader.mock.costCenters = ['HUSA', 'HUSB', 'HUSC']
      test.reader.mock.projects = [{ ProjectNumber: '7', Description: 'Syntetiskt projekt' }]
      test.config.mappings = new Map([
        ...test.config.mappings,
        ['PROJECT:7', { propertyId: 'p-b', propertyName: 'HUS-B' }],
      ])
      return test
    },
    status: 'COMPLETE_WITH_UNCERTAINTY',
    detailNumbers: [1, 10, 2],
  },
  {
    name: 'sen ogiltig rad på annat konto utanför perioden kastar reducerreferenser och reducerosäkerheter',
    create: () => {
      const test = withCatalogWarning([REMOVED, HEADER_DIMENSION, LATE_INVALID])
      duplicateOnSecondPage(test, HEADER_DIMENSION)
      return test
    },
    status: 'PARTIAL',
    detailNumbers: [1, 2, 9],
    check: (result) => {
      expect(result.reason).toBe('Verifikat 1|L|9 rad 2: ogiltigt konto')
      expect(result.references).toStrictEqual([])
      expect(result.uncertainties).toHaveLength(2) // katalog + identisk listdublett, inte reducerdata
    },
  },
  {
    name: 'giltiga detaljbelopp överflödar först vid summering och behåller redan lagda referenser',
    create: () => withCatalogWarning([REMOVED, HEADER_DIMENSION, HUGE]),
    status: 'PARTIAL',
    detailNumbers: [1, 2, 3],
    check: (result) => {
      expect(result.reason).toBe('Beloppssumman ligger utanför säkert talområde')
      expect(result.references).toHaveLength(3) // även overflowpostens referens läggs före add()
      expect(result.uncertainties).toHaveLength(3) // katalog + Removed + huvuddimension
    },
  },
  {
    name: 'sen parserogiltighet vinner över tidigare möjlig summeringsoverflow',
    create: () => withCatalogWarning([REMOVED, HEADER_DIMENSION, HUGE, LATE_INVALID]),
    status: 'PARTIAL',
    detailNumbers: [1, 2, 3, 9],
    check: (result) => {
      expect(result.reason).toBe('Verifikat 1|L|9 rad 2: ogiltigt konto')
      expect(result.references).toStrictEqual([])
      expect(result.uncertainties).toHaveLength(1) // bara katalogen, all reducerdata kasseras
    },
  },
  {
    name: 'identisk dublett över sidgräns hämtas en gång med oförändrad varning och coverage',
    create: () => {
      const test = rig([K1, K2, K3])
      duplicateOnSecondPage(test, K2)
      return test
    },
    status: 'COMPLETE',
    detailNumbers: [1, 2, 3],
    check: (result) => {
      expect(result.coverage['/3/vouchers/sublist']).toStrictEqual({
        pages: 2,
        totalPages: 2,
        totalResources: 3,
        itemsSeen: 4,
      })
    },
  },
  {
    name: 'motsägande dublett över sidgräns stoppar före varje detaljGET',
    create: () => {
      const test = rig([K1, K2, K3])
      duplicateOnSecondPage(test, { ...K2, Description: 'Annat innehåll för samma nyckel' })
      return test
    },
    status: 'PARTIAL',
    detailNumbers: [],
    check: (result) => expect(result.reason).toBe('KONFLIKT: verifikat 1|L|2 med olika innehåll'),
  },
  {
    name: 'saknad sen detalj lämnar inga tidigare reducerreferenser',
    create: () => {
      const test = withCatalogWarning([REMOVED, HEADER_DIMENSION, LATE_VALID])
      test.reader.failures.set('/3/vouchers/L/9', new FortnoxReadError('invalid', 404))
      return test
    },
    status: 'PARTIAL',
    detailNumbers: [1, 2, 9],
    check: (result) => expect(result.references).toStrictEqual([]),
  },
  {
    name: 'enskilt belopp utanför säkert öreområde är parserfel även efter giltiga detaljer',
    create: () =>
      withCatalogWarning([
        REMOVED,
        HEADER_DIMENSION,
        voucher(9, '2026-03-01', [row(5170, 100000000000000), row(2440, 0, 100000000000000)]),
      ]),
    status: 'PARTIAL',
    detailNumbers: [1, 2, 9],
    check: (result) => expect(result.reason).toBe('Verifikat 1|L|9 rad 1: ogiltigt belopp'),
  },
  {
    name: 'saknad inaktiv beloppssida, exakt decimal, explicit IB-noll och saknad bokföringsmetod',
    create: () => {
      const test = rig([
        voucher(1, '2026-10-02', [
          { Account: 5170, Debit: 10.05, CostCenter: 'HUSA' },
          { Account: 2440, Credit: 10.05 },
        ]),
      ])
      test.reader.mock.accounts = [{ Number: 5170, Active: true, BalanceBroughtForward: 0 }]
      test.reader.mock.financialYears = [{ Id: 1, FromDate: '2026-01-01', ToDate: '2026-12-31' }]
      return test
    },
    status: 'COMPLETE',
    detailNumbers: [1],
  },
  {
    name: 'sen authförlust bevarar katalogunderlag men inget tidigare reducerresultat',
    create: () => {
      const test = withCatalogWarning([REMOVED, HEADER_DIMENSION, LATE_VALID])
      test.reader.failures.set('/3/vouchers/L/9', new FortnoxReadError('auth', 401))
      return test
    },
    status: 'AUTH_LOST',
    detailNumbers: [1, 2, 9],
    check: (result) => expect(result.references).toStrictEqual([]),
  },
]

describe('Fortnox ledger — fryst referens från 2b7d6817', () => {
  it.each(scenarios)('$name', async ({ create, status, detailNumbers, check }) => {
    const test = create()
    const result = await readLedger(test.reader, 'synthetic-baseline-token', test.config)
    expect(result.status).toBe(status)
    expect(test.reader.details).toStrictEqual(
      detailNumbers.map((number) => ({
        path: `/3/vouchers/L/${number}`,
        query: { financialyear: 1 },
      })),
    )
    if (status !== 'COMPLETE' && status !== 'COMPLETE_WITH_UNCERTAINTY') {
      expect(result.summary).toBeNull()
      expect(result.rows).toBeNull()
    }
    check?.(result)
    expect({ result, detailGets: test.reader.details }).toMatchSnapshot()
  })
})
