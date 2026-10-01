/**
 * Facit för återläsningen (port av offline-riggens facit, FORTNOX-PROVBEREDSKAP v2
 * + PERIOD + KVALITETSTILLAGG-01). Belopp är syntetiska, netto, inte bokföringsråd.
 */
import { MockFortnoxLedgerReader } from './fortnox-providers'
import { readLedger, toOre, type LedgerReadConfig } from './fortnox-ledger'
import { FortnoxReadError, type FortnoxVoucher } from './fortnox.types'

const row = (Account: number, Debit = 0, Credit = 0, extra: Record<string, unknown> = {}) => ({
  Account,
  Debit,
  Credit,
  Removed: false,
  ...extra,
})
const ver = (
  n: number,
  date: string,
  rows: unknown[],
  extra: Record<string, unknown> = {},
): FortnoxVoucher => ({
  Year: 1,
  VoucherSeries: 'L',
  VoucherNumber: n,
  TransactionDate: date,
  VoucherRows: rows,
  ...extra,
})

const K1 = ver(1, '2026-10-02', [row(5170, 12000, 0, { CostCenter: 'HUSA' }), row(2440, 0, 12000)])
const K2 = ver(2, '2026-10-05', [
  row(5170, 4000, 0, { CostCenter: 'HUSA' }),
  row(5170, 2000, 0, { CostCenter: 'HUSB' }),
  row(2440, 0, 6000),
])
const K3 = ver(3, '2026-10-07', [row(5170, 2000), row(2440, 0, 2000)])
const REV = ver(4, '2026-10-20', [row(5170, 0, 12000, { CostCenter: 'HUSA' }), row(2440, 12000)], {
  ReferenceType: 'MANUAL',
  ReferenceNumber: 'L1',
})
const NEW = ver(5, '2026-10-20', [row(5170, 15000, 0, { CostCenter: 'HUSA' }), row(2440, 0, 15000)])
const DIFF = ver(4, '2026-10-20', [row(5170, 3000, 0, { CostCenter: 'HUSA' }), row(2440, 0, 3000)])

const MAP = new Map([
  ['COST_CENTER:HUSA', { propertyId: 'p-a', propertyName: 'HUS-A' }],
  ['COST_CENTER:HUSB', { propertyId: 'p-b', propertyName: 'HUS-B' }],
])
const CFG: LedgerReadConfig = {
  expectedDatabaseNumber: 900001,
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-01-01',
  periodTo: '2026-12-31',
  costAccounts: [5170],
  mappings: MAP,
  evenoExported: new Set(),
}

function reader(vouchers: FortnoxVoucher[]) {
  const r = new MockFortnoxLedgerReader()
  r.vouchers = vouchers
  return r
}
const prop = (res: Awaited<ReturnType<typeof readLedger>>, id: string) =>
  res.summary?.byProperty.find((p) => p.propertyId === id)?.amountOre ?? 0
const facit = async (vs: FortnoxVoucher[], cfg: Partial<LedgerReadConfig> = {}) => {
  const res = await readLedger(reader(vs), 't', { ...CFG, ...cfg })
  return {
    res,
    sum: res.summary && [
      res.summary.totalOre,
      prop(res, 'p-a'),
      prop(res, 'p-b'),
      res.summary.unallocatedOre,
    ],
  }
}

describe('Fortnox-återläsning — facit S1–S4', () => {
  it.each([
    ['S1', [K1], [1200000, 1200000, 0, 0]],
    ['S2', [K1, K2], [1800000, 1600000, 200000, 0]],
    ['S3', [K1, K2, K3], [2000000, 1600000, 200000, 200000]],
    ['S4a återföring + ny', [K1, K2, K3, REV, NEW], [2300000, 1900000, 200000, 200000]],
    ['S4b differens', [K1, K2, K3, DIFF], [2300000, 1900000, 200000, 200000]],
  ])('%s', async (_n, vs, want) => {
    const { res, sum } = await facit(vs as FortnoxVoucher[])
    expect(res.status).toBe('COMPLETE')
    expect(sum).toEqual(want)
  })

  it('rättelse ersätter ingen rad via referens; referensen redovisas bara', async () => {
    const { res } = await facit([K1, K2, K3, REV, NEW])
    const a = res
      .rows!.filter((r) => r.propertyId === 'p-a')
      .map((r) => r.amountOre)
      .sort((x, y) => x - y)
    expect(a).toEqual([-1200000, 400000, 1200000, 1500000])
    expect(res.references).toEqual([
      { voucher: '1|L|4', referenceType: 'MANUAL', referenceNumber: 'L1' },
    ])
  })

  it('period väljs på TransactionDate; rättelse på eget datum', async () => {
    const oct = await facit([K1, REV, NEW], { periodFrom: '2026-10-01', periodTo: '2026-10-19' })
    const late = await facit([K1, REV, NEW], { periodFrom: '2026-10-20', periodTo: '2026-10-31' })
    expect(oct.sum).toEqual([1200000, 1200000, 0, 0])
    expect(late.sum).toEqual([300000, 300000, 0, 0])
  })

  it('giltig tom period ger noll först efter komplett genomgång', async () => {
    const { res } = await facit([K1], { periodFrom: '2026-11-01', periodTo: '2026-11-30' })
    expect(res.status).toBe('COMPLETE')
    expect(res.summary!.totalOre).toBe(0)
  })
})

describe('Fortnox-återläsning — negativa kontroller', () => {
  it('fel företag stoppar efter ett anrop', async () => {
    const r = reader([K1])
    r.company = { ...r.company, DatabaseNumber: 900002 }
    const res = await readLedger(r, 't', CFG)
    expect(res.status).toBe('WRONG_COMPANY')
    expect(res.summary).toBeNull()
    expect(r.calls).toEqual(['/3/companyinformation'])
  })

  it('okopplad dimension syns och påverkar inte fastigheterna', async () => {
    const k3 = ver(3, '2026-10-07', [
      row(5170, 2000, 0, { CostCenter: 'HUSC' }),
      row(2440, 0, 2000),
    ])
    const r = reader([K1, K2, k3])
    r.costCenters = ['HUSA', 'HUSB', 'HUSC']
    const res = await readLedger(r, 't', CFG)
    expect(res.summary!.totalOre).toBe(2000000)
    expect([prop(res, 'p-a'), prop(res, 'p-b')]).toEqual([1600000, 200000])
    expect(res.summary!.unmappedDimensions).toEqual([
      { dimensionType: 'COST_CENTER', code: 'HUSC', amountOre: 200000 },
    ])
  })

  it('huvudets dimension ärvs inte och ger osäkerhet', async () => {
    const k3 = ver(3, '2026-10-07', [row(5170, 2000), row(2440, 0, 2000)], { CostCenter: 'HUSB' })
    const res = (await facit([K1, K2, k3])).res
    expect(res.status).toBe('COMPLETE_WITH_UNCERTAINTY')
    expect(res.summary!.unallocatedOre).toBe(200000)
  })

  it('Removed-rad summeras inte och tappas inte tyst', async () => {
    const k3 = ver(3, '2026-10-07', [row(5170, 2000, 0, { Removed: true }), row(2440, 0, 2000)])
    const { res, sum } = await facit([K1, K2, k3])
    expect(sum).toEqual([1800000, 1600000, 200000, 0])
    expect(res.summary!.uncertainRemovedOre).toBe(200000)
    expect(res.status).toBe('COMPLETE_WITH_UNCERTAINTY')
  })

  it('dublett i listan räknas en gång', async () => {
    const r = reader([K1, K2, K3])
    const orig = r.get.bind(r)
    r.get = (async (t: string, p: string, q?: Record<string, string | number>) => {
      const body = (await orig(t, p, q)) as Record<string, unknown>
      if (p === '/3/vouchers/sublist' && q?.page === 2)
        (body.Vouchers as unknown[]).push(structuredClone(K2))
      return body
    }) as typeof r.get
    const res = await readLedger(r, 't', CFG)
    expect(res.summary!.totalOre).toBe(2000000)
  })

  it('samma id med annat innehåll är KONFLIKT', async () => {
    const r = reader([K1, K2, K3])
    const orig = r.get.bind(r)
    r.get = (async (t: string, p: string, q?: Record<string, string | number>) => {
      const body = (await orig(t, p, q)) as Record<string, unknown>
      if (p === '/3/vouchers/sublist' && q?.page === 2) {
        ;(body.Vouchers as unknown[]).push(ver(2, '2026-10-05', [row(5170, 9999)]))
      }
      return body
    }) as typeof r.get
    const res = await readLedger(r, 't', CFG)
    expect(res.status).toBe('PARTIAL')
    expect(res.reason).toMatch(/KONFLIKT/)
    expect(res.summary).toBeNull()
  })

  it('antal ändras under läsning → PARTIAL, summa null', async () => {
    const r = reader([K1, K2, K3, REV, NEW])
    r.hooks.set(4, () => r.vouchers.push(ver(6, '2026-10-21', [row(5170, 1)])))
    const res = await readLedger(r, 't', CFG)
    expect(res.status).toBe('PARTIAL')
    expect(res.summary).toBeNull()
  })

  it('listan tappar ett objekt men totalen säger fler → PARTIAL', async () => {
    const r = reader([K1, K2, K3])
    const orig = r.get.bind(r)
    r.get = (async (t: string, p: string, q?: Record<string, string | number>) => {
      const body = (await orig(t, p, q)) as Record<string, Record<string, number>>
      if (p === '/3/vouchers/sublist') {
        const mi = body.MetaInformation as Record<string, number>
        mi['@TotalResources'] = (mi['@TotalResources'] ?? 0) + 1
      }
      return body
    }) as typeof r.get
    expect((await readLedger(r, 't', CFG)).status).toBe('PARTIAL')
  })

  it('sidnummer som inte är heltal godtas inte', async () => {
    const r = reader([K1])
    const orig = r.get.bind(r)
    r.get = (async (t: string, p: string, q?: Record<string, string | number>) => {
      const body = (await orig(t, p, q)) as Record<string, Record<string, unknown>>
      if (p === '/3/vouchers/sublist')
        (body.MetaInformation as Record<string, unknown>)['@CurrentPage'] = true
      return body
    }) as typeof r.get
    expect((await readLedger(r, 't', CFG)).status).toBe('PARTIAL')
  })

  it('avbrott (429/nät) → PARTIAL, aldrig noll', async () => {
    const r = reader([K1, K2, K3])
    r.failOnCall = { n: 4, error: new FortnoxReadError('transient', 429) }
    const res = await readLedger(r, 't', CFG)
    expect(res.status).toBe('PARTIAL')
    expect(res.summary).toBeNull()
  })

  it('401 → AUTH_LOST', async () => {
    const r = reader([K1])
    r.failOnCall = { n: 2, error: new FortnoxReadError('auth', 401) }
    expect((await readLedger(r, 't', CFG)).status).toBe('AUTH_LOST')
  })

  it('saknad detalj → PARTIAL', async () => {
    const r = reader([K1, K2])
    const orig = r.get.bind(r)
    r.get = (async (t: string, p: string, q?: Record<string, string | number>) => {
      if (p === '/3/vouchers/L/2') throw new FortnoxReadError('invalid', 404)
      return orig(t, p, q)
    }) as typeof r.get
    expect((await readLedger(r, 't', CFG)).status).toBe('PARTIAL')
  })

  it('ogiltigt datum utanför perioden fäller ändå läsningen', async () => {
    const bad = ver(9, '2026-02-30', [row(5170, 1)])
    const res = (await facit([K1, bad], { periodFrom: '2026-10-01', periodTo: '2026-10-31' })).res
    expect(res.status).toBe('PARTIAL')
  })

  it('period utanför räkenskapsåret avvisas', async () => {
    expect((await facit([K1], { periodTo: '2027-01-31' })).res.status).toBe('FAILED')
  })

  it('kostnadsställen läses paginerat (fler än en sida)', async () => {
    const r = reader([K1])
    r.costCenters = ['HUSA', 'HUSB', 'X1', 'X2', 'X3']
    const res = await readLedger(r, 't', CFG)
    expect(res.coverage['/3/costcenters']).toEqual({
      pages: 3,
      totalPages: 3,
      totalResources: 5,
      itemsSeen: 5,
    })
    expect(res.status).toBe('COMPLETE')
  })

  it('Eveno-exporterade verifikat märks för att inte dubbelräknas', async () => {
    const res = (await facit([K1, K2], { evenoExported: new Set(['1|L|2']) })).res
    expect(res.summary!.evenoExportOre).toBe(600000)
    expect(res.summary!.totalOre).toBe(1800000)
  })

  it('belopp med mer än två decimaler är ogiltigt', async () => {
    expect(toOre(10.005)).toBeNull()
    expect(toOre(10.05)).toBe(1005)
    const bad = ver(1, '2026-10-02', [row(5170, 0.001)])
    expect((await facit([bad])).res.status).toBe('PARTIAL')
  })
})
