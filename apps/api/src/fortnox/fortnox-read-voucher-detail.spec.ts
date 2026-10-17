import { parseVoucherDetail } from './fortnox-read-voucher-checkpoint'
import type { FortnoxVoucher } from './fortnox.types'

const year = { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' }
const first: FortnoxVoucher = {
  Year: 1,
  VoucherSeries: 'L',
  VoucherNumber: 1,
  TransactionDate: '2026-09-30',
  CostCenter: { body: 'RAW_HEADER' },
  ReferenceType: 7,
  ReferenceNumber: false,
  Description: 'RAW_DESCRIPTION',
  VoucherRows: [
    { Account: 2440, Credit: 10.05, Debit: null, Description: 'RAW_ROW' },
    { Account: 5170, Debit: 10.05, CostCenter: '', Project: 'Å A\u030A', Removed: true },
  ],
}

describe('Gemensam detaljparser bevarar v1:s ekonomiska normalform', () => {
  it('bevarar hela året, radpositioner, Unicode, Removed och truthy referens utan råfält', () => {
    expect(parseVoucherDetail('1|L|1', first, year)).toStrictEqual({
      key: '1|L|1',
      date: '2026-09-30',
      headerDimensionPresent: true,
      reference: { type: null, number: null },
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
          project: 'Å A\u030A',
          removed: true,
        },
      ],
    })
  })

  it('bevarar båda beloppssidorna och en tom referenstyp när referensnumret finns', () => {
    expect(
      parseVoucherDetail(
        '1|L|10',
        {
          Year: 1,
          VoucherSeries: 'L',
          VoucherNumber: 10,
          TransactionDate: '2026-10-01',
          ReferenceType: '',
          ReferenceNumber: '17',
          VoucherRows: [
            { Account: 5170, Debit: 0.1, Credit: 0.2, CostCenter: '0', Project: '' },
            { Account: 1930, Debit: 0.2, Credit: 0.1 },
          ],
        },
        year,
      ),
    ).toStrictEqual({
      key: '1|L|10',
      date: '2026-10-01',
      headerDimensionPresent: false,
      reference: { type: '', number: '17' },
      rows: [
        {
          index1: 1,
          account: 5170,
          debitOre: 10,
          creditOre: 20,
          costCenter: '0',
          project: null,
          removed: false,
        },
        {
          index1: 2,
          account: 1930,
          debitOre: 20,
          creditOre: 10,
          costCenter: null,
          project: null,
          removed: false,
        },
      ],
    })
  })

  it('lämnar obalans åt reduceraren och bevarar sista dagen i det frysta året', () => {
    expect(
      parseVoucherDetail(
        '1|L|2',
        {
          Year: 1,
          VoucherSeries: 'L',
          VoucherNumber: 2,
          TransactionDate: '2026-12-31',
          CostCenter: '',
          Project: null,
          ReferenceType: '',
          ReferenceNumber: '',
          VoucherRows: [
            { Account: 1930, Debit: 1 },
            { Account: 2440, Credit: 0.99 },
          ],
        },
        year,
      ),
    ).toStrictEqual({
      key: '1|L|2',
      date: '2026-12-31',
      headerDimensionPresent: false,
      reference: null,
      rows: [
        {
          index1: 1,
          account: 1930,
          debitOre: 100,
          creditOre: 0,
          costCenter: null,
          project: null,
          removed: false,
        },
        {
          index1: 2,
          account: 2440,
          debitOre: 0,
          creditOre: 99,
          costCenter: null,
          project: null,
          removed: false,
        },
      ],
    })
  })

  it('ändrade fria beskrivningar ändrar inte den validerade detaljen', () => {
    const changed = { ...first, Description: 'CHANGED', Comments: { body: 'NOT_SAVED' } }
    const actual = parseVoucherDetail('1|L|1', changed, year)
    expect(actual).toStrictEqual(parseVoucherDetail('1|L|1', first, year))
    expect(JSON.stringify(actual)).not.toMatch(/CHANGED|NOT_SAVED|RAW_DESCRIPTION|RAW_ROW/)
  })

  it.each([
    { name: 'fel nyckel', patch: { VoucherNumber: 10 } },
    { name: 'omöjligt datum', patch: { TransactionDate: '2026-02-31' } },
    {
      name: 'Removed som sträng',
      patch: {
        VoucherRows: [
          { Account: 1930, Debit: 1 },
          { Account: 2440, Credit: 1, Removed: 'true' },
        ],
      },
    },
    {
      name: 'bråkdelsöre',
      patch: {
        VoucherRows: [
          { Account: 1930, Debit: 0.001 },
          { Account: 2440, Credit: 1 },
        ],
      },
    },
    {
      name: 'sen ogiltig rad också utanför vald månad och kostkonto',
      patch: {
        VoucherRows: [
          { Account: 2440, Credit: 10.05 },
          { Account: 5170, Debit: 10.05 },
          { Account: 10000, Debit: 1 },
        ],
      },
    },
  ])('nekar hela detaljen vid $name', ({ patch }) => {
    expect(parseVoucherDetail('1|L|1', { ...first, ...patch }, year)).toBeNull()
  })
})
