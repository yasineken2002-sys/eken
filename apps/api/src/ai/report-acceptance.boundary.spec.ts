jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { readLedger } from '../fortnox/fortnox-ledger'
import { FortnoxReadError } from '../fortnox/fortnox.types'
import { formatFortnoxShadowForAi } from '../fortnox/fortnox-ai-context'
import {
  assistantRig,
  date,
  ledgerFixture,
  memoryDb,
  readRow,
  voucher,
} from './report-acceptance.fixtures.testing'

describe('AF01–AF20 B: befintliga källgränser, oberoende originalorakel', () => {
  it('AF02 B kostnadsurval40000: id skiljer Eken/Eken, radens kostnadsställe före projekt', async () => {
    const { reader, config } = ledgerFixture([
      voucher(1, 30000, '2026-09-15', { CostCenter: 'HUSA', Project: '2' }),
      voucher(2, 6000),
      voucher(3, 4000, '2026-09-15', { CostCenter: 'UNMAPPED' }),
    ])
    const result = await readLedger(reader, 'synthetic-port', config)
    expect(result.summary).toMatchObject({
      totalOre: 4000000,
      unallocatedOre: 600000,
      byProperty: [{ propertyId: 'P-A', propertyName: 'Eken', amountOre: 3000000 }],
      unmappedDimensions: [{ dimensionType: 'COST_CENTER', code: 'UNMAPPED', amountOre: 400000 }],
    })
    expect(result.rows?.[0]).toMatchObject({
      propertyId: 'P-A',
      dimensionType: 'COST_CENTER',
      code: 'HUSA',
    })
    // No manufactured zero row for P-B; a cost selection is not its whole result.
    expect(result.summary?.byProperty.find((p) => p.propertyId === 'P-B')).toBeUndefined()
  })

  it.each([true, false])(
    'AF04 B liability IB presence=%s: periodmovement is not endbalance',
    async (withIb) => {
      const { reader, config } = ledgerFixture([
        voucher(1, -20000, '2026-09-10', { Account: 2890 }),
        voucher(2, 5000, '2026-09-20', { Account: 2890 }),
      ])
      reader.accounts.push({
        Number: 2890,
        Active: true,
        ...(withIb ? { BalanceBroughtForward: -15000 } : {}),
      })
      const result = await readLedger(reader, 'synthetic-port', { ...config, costAccounts: [2890] })
      expect(result.summary?.totalOre).toBe(-1500000)
      expect(result.summary?.balanceBroughtForwardOre?.['2890']).toBe(withIb ? -1500000 : null)
      // The reader exposes components, not a verified balance/report. Endbalance -3000000
      // may not be replaced by period movement -1500000; S asserts report abstention.
      expect(result.summary).not.toHaveProperty('closingBalanceOre')
    },
  )

  it('AF05 B external25000 contains own7000 once; invoice31250 is no VAT source', async () => {
    const { reader, config } = ledgerFixture([voucher(12, 7000), voucher(13, 18000)])
    const result = await readLedger(reader, 'synthetic-port', {
      ...config,
      evenoExported: new Set(['7|A|12']),
    })
    expect(result.summary).toMatchObject({ totalOre: 2500000, evenoExportOre: 700000 })
    expect(result.summary?.totalOre).not.toBe(3200000)
    expect(result.summary?.totalOre).not.toBe(1800000)
    expect(result.summary).not.toHaveProperty('vatOre')
  })

  it('AF06 B year/series/number is exact within company101; another company fails closed', async () => {
    const { reader, config } = ledgerFixture([voucher(12, 7000)])
    const otherYear = await readLedger(reader, 'synthetic-port', {
      ...config,
      evenoExported: new Set(['8|A|12']),
    })
    expect(otherYear.summary?.evenoExportOre).toBe(0)
    const own = await readLedger(reader, 'synthetic-port', {
      ...config,
      evenoExported: new Set(['7|A|12']),
    })
    expect(own.rows?.[0]).toMatchObject({ voucher: '7|A|12', evenoExport: true })
    reader.company.DatabaseNumber = 202
    const foreign = await readLedger(reader, 'synthetic-port', config)
    expect(foreign.status).toBe('WRONG_COMPANY')
    expect(foreign.summary).toBeNull()
    expect(foreign.rows).toBeNull()
  })

  it('AF08 B July–June fiscal year refuses June–July query across its boundary', async () => {
    const { reader, config } = ledgerFixture([voucher(1, 40000)])
    const result = await readLedger(reader, 'synthetic-port', {
      ...config,
      periodFrom: '2026-06-01',
      periodTo: '2026-07-31',
    })
    expect(result.status).not.toBe('COMPLETE')
    expect(result.summary).toBeNull()
  })

  it.each(['complete', 'page3-missing', 'changed-total', 'identity-conflict'])(
    'AF09 B 250 objects/100+100+50 %s; partial is null, never zero or subtotal',
    async (variant) => {
      const { reader, config } = ledgerFixture(
        Array.from({ length: 250 }, (_, i) => voucher(i + 1, 100)),
      )
      const get = reader.get.bind(reader)
      const observed: number[] = []
      reader.get = (async (
        token: string,
        path: string,
        query?: Record<string, string | number>,
      ) => {
        if (path === '/3/vouchers/sublist' && query?.page === 3 && variant === 'page3-missing')
          throw new FortnoxReadError('transient', 429)
        const response = await get<Record<string, unknown>>(token, path, query)
        if (path === '/3/vouchers/sublist') {
          observed.push((response['Vouchers'] as unknown[]).length)
          if (query?.page === 3 && variant === 'changed-total')
            (response['MetaInformation'] as Record<string, unknown>)['@TotalResources'] = 251
          if (query?.page === 3 && variant === 'identity-conflict')
            (response['Vouchers'] as unknown[])[0] = voucher(1, 999)
        }
        return response
      }) as typeof reader.get
      const result = await readLedger(reader, 'synthetic-port', config)
      if (variant === 'complete') {
        expect(observed).toEqual([100, 100, 50])
        expect(result.status).toBe('COMPLETE')
        expect(result.summary?.totalOre).toBe(2500000)
        expect(result.coverage['/3/vouchers/sublist']).toMatchObject({ pages: 3, itemsSeen: 250 })
      } else {
        expect(result.status).toBe('PARTIAL')
        expect(result.summary).toBeNull()
        expect(result.rows).toBeNull()
      }
    },
  )

  it('AF09 B complete empty period is the distinct valid zero', async () => {
    const { reader, config } = ledgerFixture([])
    const result = await readLedger(reader, 'synthetic-port', config)
    expect(result.status).toBe('COMPLETE')
    expect(result.summary?.totalOre).toBe(0)
  })

  it('AF10 B R2 failure does not renew R1 historical read time', () => {
    const text = formatFortnoxShadowForAi(
      {
        connection: { status: 'ACTIVE', fortnoxDatabaseNumber: 101, fortnoxCompanyName: 'O-A' },
        latestCompleteRead: readRow(),
        latestRead: readRow({
          id: 'R2',
          status: 'PARTIAL',
          summary: null,
          startedAt: date('2026-10-13T08:00:00Z'),
          completedAt: date('2026-10-13T08:01:00Z'),
        }),
        exports: null,
      },
      date('2026-10-14'),
    ).join('\n')
    expect(text).toContain('Läs-id R1')
    expect(text).toContain('2026-10-10')
    expect(text).toContain('Den tidigare kompletta läsningens ursprungliga lästid gäller fortsatt')
  })

  it('AF13 B wrong-company25000/7000 is absent from the actual report snapshot', async () => {
    const db = memoryDb('FORTNOX')
    db.connection.fortnoxDatabaseNumber = 202
    db.state.latest = readRow({
      fortnoxDatabaseNumber: 202,
      summary: { totalOre: 2500000, evenoExportOre: 700000 },
    })
    const { fortnox } = assistantRig(db.prisma)
    const snapshot = await fortnox.aiReportSnapshot('O-A', 'OWNER')
    expect(snapshot.reportUnavailable?.reason).toBe('COMPANY_MISMATCH')
    expect(snapshot.latestRead).toBeNull()
    expect(snapshot.latestCompleteRead).toBeNull()
    expect(JSON.stringify(snapshot)).not.toMatch(/2500000|700000/)
  })

  it('AF15 B September original10000, October reversal/new -2000, combined8000', async () => {
    const { reader, config } = ledgerFixture([
      voucher(1, 10000, '2026-09-15'),
      voucher(2, -10000, '2026-10-02'),
      voucher(3, 8000, '2026-10-02'),
    ])
    const september = await readLedger(reader, 'synthetic-port', config)
    const october = await readLedger(reader, 'synthetic-port', {
      ...config,
      periodFrom: '2026-10-01',
      periodTo: '2026-10-31',
    })
    const both = await readLedger(reader, 'synthetic-port', { ...config, periodTo: '2026-10-31' })
    expect(september.summary?.totalOre).toBe(1000000)
    expect(october.summary?.totalOre).toBe(-200000)
    expect(both.summary?.totalOre).toBe(800000)
    expect(both.rows?.map((r) => r.voucher)).toEqual(['7|A|1', '7|A|2', '7|A|3'])
  })
})
