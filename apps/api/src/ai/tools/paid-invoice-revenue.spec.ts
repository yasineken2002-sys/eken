/**
 * Periodtolkningen och måttets etikett för get_revenue_report / compare_revenue.
 *
 * Den här specen äger det som inte behöver en databas: att YYYY-MM-DD blir
 * hela svenska kalenderdagar (även DST-dygnen), att en ogiltig period avvisas
 * INNAN någon fakturafråga ställs, och att modellens verktygsyta (TOOLS) och
 * menyns katalog säger samma sak som svaret. Beteendet mot riktiga rader ägs av
 * ai-ekonomimatt.db.spec.ts.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'
import { TOOLS } from './ai-tools.definition'
import { buildToolCatalog } from './ai-tools.catalog'
import {
  PAID_INVOICE_TOTAL_CAVEAT,
  PAID_INVOICE_TOTAL_MEASURE,
  svenskMånad,
  tolkaSvenskPeriod,
} from './paid-invoice-revenue'

describe('tolkaSvenskPeriod — hela svenska kalenderdagar, båda inkluderade', () => {
  it.each([
    // [from, to, fromInstant, toExclusiveInstant, timmar]
    ['2026-08-01', '2026-08-31', '2026-07-31T22:00:00.000Z', '2026-08-31T22:00:00.000Z', 744],
    ['2026-01-01', '2026-01-31', '2025-12-31T23:00:00.000Z', '2026-01-31T23:00:00.000Z', 744],
    ['2026-03-29', '2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 23],
    ['2026-10-25', '2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 25],
    ['2026-12-31', '2026-12-31', '2026-12-30T23:00:00.000Z', '2026-12-31T23:00:00.000Z', 24],
  ])('%s–%s', (from, to, fromInstant, toExclusiveInstant, timmar) => {
    const t = tolkaSvenskPeriod(from, to)
    if (!t.ok) throw new Error(t.message)
    expect(t.period).toEqual({
      from,
      to,
      timeZone: 'Europe/Stockholm',
      inclusive: true,
      fromInstant,
      toExclusiveInstant,
    })
    expect((t.where.lt.getTime() - t.where.gte.getTime()) / 3_600_000).toBe(timmar)
  })

  it.each([
    ['omvänd', '2026-08-31', '2026-08-01', /ligger efter/],
    ['30 februari', '2026-02-30', '2026-03-01', /YYYY-MM-DD/],
    ['månad 13', '2026-13-01', '2026-13-02', /YYYY-MM-DD/],
    ['bara månad', '2026-08', '2026-08-31', /YYYY-MM-DD/],
    ['tidsstämpel', '2026-08-01T00:00:00Z', '2026-08-31', /YYYY-MM-DD/],
    ['saknas', undefined, '2026-08-31', /YYYY-MM-DD/],
    ['inte en sträng', 20260801, '2026-08-31', /YYYY-MM-DD/],
  ])('%s avvisas med förklaring', (_namn, from, to, mönster) => {
    const t = tolkaSvenskPeriod(from, to)
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.message).toMatch(mönster)
  })

  it('samma dag som start och slut är tillåten', () => {
    expect(tolkaSvenskPeriod('2026-08-15', '2026-08-15').ok).toBe(true)
  })

  it('månadsnyckeln följer svenskt datum, inte UTC-datum', () => {
    expect(svenskMånad(new Date('2026-07-31T22:00:00.000Z'))).toBe('2026-08')
    expect(svenskMånad(new Date('2026-07-31T21:59:59.999Z'))).toBe('2026-07')
    expect(svenskMånad(new Date('2026-12-31T23:30:00.000Z'))).toBe('2027-01')
  })
})

describe('ogiltig period ger avslag UTAN fakturafråga', () => {
  function executor() {
    const findMany = jest.fn().mockResolvedValue([])
    const ex = Object.assign(Object.create(ToolExecutorService.prototype), {
      prisma: { invoice: { findMany } },
      audit: { logToolExecution: jest.fn().mockResolvedValue(undefined) },
      logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    }) as ToolExecutorService
    return { ex, findMany }
  }
  const kör = (ex: ToolExecutorService, verktyg: string, input: Record<string, unknown>) =>
    ex.executeTool(verktyg, input, 'org-1', { kind: 'USER', id: 'u-1' }, 'OWNER')

  it.each([
    ['get_revenue_report', { from: '2026-08-31', to: '2026-08-01' }],
    ['get_revenue_report', { from: '2026-08', to: '2026-08-31' }],
    [
      'compare_revenue',
      {
        period1From: '2026-07-01',
        period1To: '2026-07-31',
        period2From: '2026-08-31',
        period2To: '2026-08-01',
      },
    ],
  ])('%s %j', async (verktyg, input) => {
    const { ex, findMany } = executor()
    const svar = await kör(ex, verktyg, input)
    expect(svar.success).toBe(false)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('positiv kontroll: en giltig period ställer frågan med svenska gränser', async () => {
    const { ex, findMany } = executor()
    const svar = await kör(ex, 'get_revenue_report', { from: '2026-08-01', to: '2026-08-31' })
    expect(svar.success).toBe(true)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          status: 'PAID',
          paidAt: {
            gte: new Date('2026-07-31T22:00:00.000Z'),
            lt: new Date('2026-08-31T22:00:00.000Z'),
          },
        },
      }),
    )
  })
})

describe('modellens och menyns yta säger vilket mått det är', () => {
  const beskrivning = (namn: string) => TOOLS.find((t) => t.name === namn)?.description ?? ''
  const katalog = buildToolCatalog()
  const post = (namn: string) => katalog.find((p) => p.name === namn)

  it.each(['get_revenue_report', 'compare_revenue'])('%s: TOOLS-beskrivningen', (namn) => {
    const text = beskrivning(namn)
    expect(text).toMatch(/betalda fakturors total/i)
    expect(text).toMatch(/INTE hyresavier/)
    expect(text).toMatch(/INTE bokförd intäkt/)
    expect(text).toMatch(/INTE verifierad bankinbetalning/)
    expect(text).toMatch(/fick status Betald/)
    expect(text).toMatch(/hela svenska kalenderdagar/)
  })

  it('get_dashboard_stats: TOOLS-beskrivningen etiketterar totalPaidRevenue', () => {
    const text = beskrivning('get_dashboard_stats')
    expect(text).toContain('totalPaidRevenue: betalda fakturors total')
    expect(text).toMatch(/INTE hyresavier/)
    expect(text).toMatch(/INTE verifierad bankinbetalning/)
  })

  it('katalogen lovar inte "intäkter" för verktyg som räknar betalda fakturor', () => {
    expect(post('get_revenue_report')).toMatchObject({
      label: 'Hämtar betalda fakturors total',
      menuLabel: 'Hämta betalda fakturors total',
    })
    expect(post('compare_revenue')).toMatchObject({
      label: 'Jämför betalda fakturors total över tid',
      menuLabel: 'Jämför betalda fakturors total över tid',
    })
  })

  it('måttet och svarstexten säger att status Betald inte är bankbevis', () => {
    expect(PAID_INVOICE_TOTAL_MEASURE.excludes).toContain(
      'Verifierad bankinbetalning — status Betald kan sättas manuellt utan bankunderlag',
    )
    expect(PAID_INVOICE_TOTAL_MEASURE.definition).toMatch(/inte verifierad bankinbetalning/)
    expect(PAID_INVOICE_TOTAL_CAVEAT).toMatch(/bevisar inte att pengarna kommit in på banken/)
  })

  it('måttets metadata ligger under nycklar som inte ramas in som osäker text', () => {
    // untrusted-content.ts ramar in bl.a. `description`/`title`/`content`; då hade
    // modellen fått måttets definition märkt som opålitlig hyresgästtext.
    expect(Object.keys(PAID_INVOICE_TOTAL_MEASURE).sort()).toEqual(
      ['definition', 'excludes', 'id', 'includes', 'name'].sort(),
    )
  })
})
