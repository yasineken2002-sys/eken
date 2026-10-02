/**
 * Tom Fortnox-samling (observerad 2026-10-02, testföretag utan år/dimensioner).
 * Fixtures är de oförändrade observerade svaren (se __fixtures__/observerad-20261002).
 * Positiv kontroll: exakt tom första sida → fullständig tom katalog.
 * Negativa kontroller: varje avvikelse från den exakta formen fortsätter avvisas.
 */
import financialYears from './__fixtures__/observerad-20261002/observed-financialyears.json'
import costCenters from './__fixtures__/observerad-20261002/observed-costcenters.json'
import projects from './__fixtures__/observerad-20261002/observed-projects.json'
import { readCatalog } from './fortnox-catalog'
import { readLedger } from './fortnox-ledger'
import { isExactEmptyFirstPage } from './fortnox-pagination'
import type { FortnoxLedgerReader } from './fortnox.types'

const COMPANY = {
  CompanyInformation: { DatabaseNumber: 1868238, OrganizationNumber: '556000-0000' },
}

function reader(over: Record<string, unknown> = {}): FortnoxLedgerReader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async get<T>(_t: string, path: string): Promise<T> {
      calls.push(path)
      if (path in over) return structuredClone(over[path]) as T
      if (path === '/3/companyinformation') return COMPANY as T
      if (path === '/3/financialyears') return structuredClone(financialYears) as T
      if (path === '/3/costcenters') return structuredClone(costCenters) as T
      if (path === '/3/projects') return structuredClone(projects) as T
      throw new Error(`oväntad väg ${path}`)
    },
  }
}

describe('observerad tom Fortnox-katalog', () => {
  it('fixtures är exakt den observerade tomma formen', () => {
    for (const [f, key] of [
      [financialYears, 'FinancialYears'],
      [costCenters, 'CostCenters'],
      [projects, 'Projects'],
    ] as const) {
      expect(isExactEmptyFirstPage(1, f as Record<string, unknown>, key)).toBe(true)
    }
  })

  it('positiv: tom katalog blir ready/complete med tomma listor (inte färdig exportkonfiguration)', async () => {
    const c = await readCatalog(reader(), 't', {
      expectedDatabaseNumber: 1868238,
      financialYearId: null,
    })
    expect([c.ready, c.complete, c.reason]).toEqual([true, true, null])
    expect([c.financialYears, c.dimensions, c.costAccounts, c.voucherSeries]).toEqual([
      [],
      [],
      [],
      [],
    ])
  })

  const meta = (cp: unknown, tp: unknown, tr: unknown) => ({
    '@CurrentPage': cp,
    '@TotalPages': tp,
    '@TotalResources': tr,
  })
  it.each([
    ['TotalPages 0 men TotalResources 1', { MetaInformation: meta(1, 0, 1), FinancialYears: [] }],
    [
      'TotalPages 0 med element i listan',
      {
        MetaInformation: meta(1, 0, 0),
        FinancialYears: [{ Id: 1, FromDate: '2026-01-01', ToDate: '2026-12-31' }],
      },
    ],
    ['fel sida', { MetaInformation: meta(2, 0, 0), FinancialYears: [] }],
    ['saknad lista', { MetaInformation: meta(1, 0, 0) }],
    ['lista som objekt', { MetaInformation: meta(1, 0, 0), FinancialYears: {} }],
    ['strängtal', { MetaInformation: meta('1', '0', '0'), FinancialYears: [] }],
    ['saknad metadata', { FinancialYears: [] }],
  ])('negativ: %s → ready=false', async (_n, body) => {
    const c = await readCatalog(reader({ '/3/financialyears': body }), 't', {
      expectedDatabaseNumber: 1868238,
      financialYearId: null,
    })
    expect([c.ready, c.complete, c.financialYears]).toEqual([false, false, []])
  })

  it('vanlig paginerad lista håller fortfarande (positiv kontroll)', async () => {
    const one = (page: number) => ({
      MetaInformation: meta(page, 2, 2),
      FinancialYears: [{ Id: page, FromDate: `202${page}-01-01`, ToDate: `202${page}-12-31` }],
    })
    const r: FortnoxLedgerReader = {
      async get<T>(
        _t: string,
        path: string,
        q?: Readonly<Record<string, string | number>>,
      ): Promise<T> {
        if (path === '/3/companyinformation') return COMPANY as T
        if (path === '/3/financialyears') return one(Number(q?.page)) as T
        return structuredClone(path === '/3/costcenters' ? costCenters : projects) as T
      },
    }
    const c = await readCatalog(r, 't', { expectedDatabaseNumber: 1868238, financialYearId: null })
    expect([c.ready, c.financialYears.map((y) => y.id)]).toEqual([true, [2, 1]])
  })

  it('ledger: tomma kostnadsställen ger komplett täckning 0/0 (inte fel)', async () => {
    const r: FortnoxLedgerReader = {
      async get<T>(_t: string, path: string): Promise<T> {
        if (path === '/3/companyinformation') return COMPANY as T
        if (path === '/3/financialyears/1')
          return { FinancialYear: { Id: 1, FromDate: '2026-01-01', ToDate: '2026-12-31' } } as T
        if (path === '/3/accounts/5170') return { Account: { Number: 5170, Active: true } } as T
        if (path === '/3/costcenters') return structuredClone(costCenters) as T
        if (path === '/3/vouchers/sublist')
          return { MetaInformation: meta(1, 0, 0), Vouchers: [] } as T
        throw new Error(path)
      },
    }
    const res = await readLedger(r, 't', {
      expectedDatabaseNumber: 1868238,
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      costAccounts: [5170],
      mappings: new Map(),
      evenoExported: new Set(),
    })
    expect(res.status).toBe('COMPLETE')
    expect(res.summary?.totalOre).toBe(0)
    expect(res.coverage['/3/costcenters']).toEqual({
      pages: 1,
      totalPages: 0,
      totalResources: 0,
      itemsSeen: 0,
    })
  })
})
