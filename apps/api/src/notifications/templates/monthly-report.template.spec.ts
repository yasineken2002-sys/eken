/**
 * Steg 3, PR 3a — månadsrapporten renderas genom den gemensamma brandade
 * shellen. Verifierar att RAMEN nu är shellens (header/footer/logo/font/färg)
 * medan rapportens DATA är oförändrad, samt att den flaggade hårdkodade färgen
 * bytts mot DEFAULT_BRAND_COLOR. Mallen är ren → testas isolerat.
 */

import { DEFAULT_BRAND_COLOR, BRAND_FONT_STACKS } from '@eken/shared'
import { generateMonthlyReportHtml } from './monthly-report.template'
import type { MonthlyReportData } from './monthly-report.template'

function makeData(overrides: Partial<MonthlyReportData> = {}): MonthlyReportData {
  return {
    header: {
      monthLabel: 'Maj 2026',
      organizationName: 'Värd AB',
      organizationAddress: 'Storgatan 1, 111 22 Stockholm',
      generatedAt: '1 juni 2026',
    },
    brand: {
      logoDataUrl: null,
      primaryColor: null,
      secondaryColor: null,
      brandFont: null,
      org: {
        name: 'Värd AB',
        orgNumber: '556000-0001',
        street: 'Storgatan 1',
        postalCode: '111 22',
        city: 'Stockholm',
      },
    },
    summary: {
      revenue: { current: 125000, prevMonthPct: 4.2, prevYearPct: 10 },
      occupancy: { currentPct: 92.5, prevMonthDeltaPct: 1.1 },
      overdue: { count: 3, totalAmount: 18000, over30Count: 1 },
      tenants: { newLeases: 2, terminatedLeases: 1 },
    },
    kpis: {
      revenue: {
        total: 125000,
        rent: 100000,
        service: 10000,
        utility: 8000,
        deposit: 5000,
        other: 2000,
        paid: 120000,
      },
      occupancy: {
        totalUnits: 40,
        occupied: 37,
        vacant: 3,
        renovation: 0,
        reserved: 0,
        ratePct: 92.5,
      },
      payments: { onTime: 30, late1to7: 4, late8to30: 2, late30plus: 1 },
      maintenance: { incoming: 5, resolved: 4, avgResolutionDays: 3, topProperties: [] },
    },
    properties: [{ name: 'Storgatan 1', revenue: 80000, occupancyPct: 95, vacant: 1, tickets: 2 }],
    appendix: { newLeases: [], terminatedLeases: [] },
    aiInsights: 'Sammanfattning\n- Stark månad',
    ...overrides,
  }
}

describe('generateMonthlyReportHtml — brandad shell', () => {
  it('renderas genom shellen (brandad header + footer)', () => {
    const html = generateMonthlyReportHtml(makeData())
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('class="bp-header"')
    expect(html).toContain('class="bp-footer"')
    // shell-titel innehåller månaden (data bevarad)
    expect(html).toContain('Månadsrapport — Maj 2026')
    // ingen kvarvarande egen hero eller per-sid-footer ("sid N")
    expect(html).not.toContain('class="hero"')
    expect(html).not.toMatch(/sid \d/)
  })

  it('behåller rapportens data och sektioner oförändrade', () => {
    const html = generateMonthlyReportHtml(makeData())
    expect(html).toContain('Sammanfattning')
    expect(html).toContain('Detaljerade nyckeltal')
    expect(html).toContain('Per fastighet')
    expect(html).toContain('AI-insikter')
    expect(html).toContain('Storgatan 1') // fastighetsrad
    expect(html).toContain('Beläggning')
    // KPI-siffra finns kvar (antal lägenheter)
    expect(html).toContain('40')
  })

  it('flaggade hårdkodade färgen ersatt med DEFAULT_BRAND_COLOR (beläggningskortet)', () => {
    const html = generateMonthlyReportHtml(makeData())
    expect(html).toContain(DEFAULT_BRAND_COLOR)
    expect(html).not.toContain('#2563EB') // gamla hårdkoden borta
  })

  it('väver in logga och brand-typsnitt från orgens varumärke', () => {
    const html = generateMonthlyReportHtml(
      makeData({
        brand: {
          logoDataUrl: 'data:image/png;base64,AAAA',
          primaryColor: '#123456',
          secondaryColor: '#654321',
          brandFont: 'GEORGIA',
          org: { name: 'Värd AB', orgNumber: null, street: null, postalCode: null, city: null },
        },
      }),
    )
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toContain(BRAND_FONT_STACKS.GEORGIA)
    expect(html).toContain('#123456') // primär (shell-header-border)
    expect(html).toContain('#654321') // sekundär
  })

  it('escapar dynamiskt innehåll (ingen XSS via org-/fastighetsnamn)', () => {
    const html = generateMonthlyReportHtml(
      makeData({
        brand: {
          logoDataUrl: null,
          primaryColor: null,
          secondaryColor: null,
          brandFont: null,
          org: {
            name: 'Värd <script>alert(1)</script>',
            orgNumber: null,
            street: null,
            postalCode: null,
            city: null,
          },
        },
        properties: [{ name: '<b>Fast</b>', revenue: 1, occupancyPct: 1, vacant: 0, tickets: 0 }],
      }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<b>Fast</b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;Fast&lt;/b&gt;')
  })

  it('appendix-sidan tas med endast när det finns kontraktsrörelser', () => {
    const without = generateMonthlyReportHtml(makeData())
    expect(without).not.toContain('Appendix — kontraktsrörelser')

    const withAppendix = generateMonthlyReportHtml(
      makeData({
        appendix: {
          newLeases: [
            {
              tenant: 'Anna Andersson',
              unit: 'Lgh 1',
              property: 'Storgatan 1',
              startDate: '2026-05-01',
              monthlyRent: 12000,
            },
          ],
          terminatedLeases: [],
        },
      }),
    )
    expect(withAppendix).toContain('Appendix — kontraktsrörelser')
    expect(withAppendix).toContain('Anna Andersson')
  })
})
