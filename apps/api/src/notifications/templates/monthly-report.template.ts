import { formatCurrency, DEFAULT_BRAND_COLOR } from '@eken/shared'
import { buildBrandedPdfHtml } from '../../common/branding'

// ── Datakontrakt ─────────────────────────────────────────────────────────────
// Produceras av MonthlyReportService.buildReportData() och konsumeras enbart
// av generateMonthlyReportHtml() nedan. Alla belopp är råa tal (SEK) —
// formatering sker i mallen via formatCurrency.

export interface MonthlyReportData {
  header: {
    monthLabel: string // "Maj 2026"
    organizationName: string
    organizationAddress: string // "Storgatan 4, 111 22 Stockholm"
    generatedAt: string // "1 juni 2026"
  }
  // Varumärke (Steg 3, PR 3a) — månadsrapporten renderas genom den gemensamma
  // brandade PDF-shellen. Fälten kommer från Organization; shellen hanterar
  // defaults (primär → DEFAULT_BRAND_COLOR, sekundär → härleds, font → fallback).
  brand: {
    logoDataUrl: string | null
    primaryColor: string | null // org.invoiceColor
    secondaryColor: string | null // org.brandSecondaryColor
    brandFont: string | null // org.brandFont
    org: {
      name: string
      orgNumber: string | null
      street: string | null
      postalCode: string | null
      city: string | null
    }
  }
  summary: {
    revenue: { current: number; prevMonthPct: number | null; prevYearPct: number | null }
    occupancy: { currentPct: number; prevMonthDeltaPct: number | null }
    overdue: { count: number; totalAmount: number; over30Count: number }
    tenants: { newLeases: number; terminatedLeases: number }
  }
  kpis: {
    revenue: {
      total: number
      rent: number
      service: number
      utility: number
      deposit: number
      other: number
      paid: number
    }
    occupancy: {
      totalUnits: number
      occupied: number
      vacant: number
      renovation: number
      reserved: number
      ratePct: number
    }
    payments: { onTime: number; late1to7: number; late8to30: number; late30plus: number }
    maintenance: {
      incoming: number
      resolved: number
      avgResolutionDays: number | null
      topProperties: Array<{ name: string; count: number }>
    }
  }
  properties: Array<{
    name: string
    revenue: number
    occupancyPct: number
    vacant: number
    tickets: number
  }>
  appendix: {
    newLeases: Array<{
      tenant: string
      unit: string
      property: string
      startDate: string
      monthlyRent: number
    }>
    terminatedLeases: Array<{ tenant: string; unit: string; property: string; endDate: string }>
  }
  aiInsights: string // fritext från AI (3 rubriker); '' om AI hoppades över
}

// ── HTML-helpers ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Headless Chromium i produktionsmiljön saknar ett emoji-typsnitt — emoji
// renderas då som tomma rutor. Vi strippar därför alla emoji ur AI-texten
// (rubrikraderna stylas i stället via CSS).
function stripEmoji(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .trim()
}

// Procent-badge: grön vid ≥0, röd vid <0, neutral streck vid null (saknad
// jämförelsedata, t.ex. nystartad organisation utan historik).
function deltaBadge(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) {
    return `<span class="delta delta-flat">ingen jämförelse</span>`
  }
  const rounded = Math.round(pct * 10) / 10
  const cls = rounded >= 0 ? 'delta-up' : 'delta-down'
  const sign = rounded > 0 ? '+' : ''
  return `<span class="delta ${cls}">${sign}${rounded}%</span>`
}

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

// Renderar AI:ns fritext (rubrikrader + punktlistor) till HTML. Rader som
// inleds med -, • eller * blir <li>; övriga icke-tomma rader blir rubriker.
function renderAiInsights(text: string): string {
  if (!text.trim()) {
    return `<p class="ai-fallback">AI-insikterna kunde inte genereras för denna månad. Övriga delar av rapporten är fullständiga.</p>`
  }
  const lines = text.split('\n').map((l) => stripEmoji(l))
  const out: string[] = []
  let inList = false
  for (const line of lines) {
    if (!line) continue
    const isBullet = /^[-•*]\s+/.test(line)
    if (isBullet) {
      if (!inList) {
        out.push('<ul class="ai-list">')
        inList = true
      }
      out.push(`<li>${esc(line.replace(/^[-•*]\s+/, ''))}</li>`)
    } else {
      if (inList) {
        out.push('</ul>')
        inList = false
      }
      out.push(`<h3 class="ai-heading">${esc(line)}</h3>`)
    }
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

// ── Sidbyggare ───────────────────────────────────────────────────────────────

function summaryCard(accent: string, label: string, value: string, ...lines: string[]): string {
  return `
    <div class="sum-card" style="border-top:3px solid ${accent}">
      <div class="sum-label">${esc(label)}</div>
      <div class="sum-value">${value}</div>
      ${lines.map((l) => `<div class="sum-sub">${l}</div>`).join('')}
    </div>`
}

function kpiRow(label: string, value: string): string {
  return `<div class="kpi-row"><span class="kpi-label">${esc(label)}</span><span class="kpi-value">${value}</span></div>`
}

function kpiCard(title: string, rows: string): string {
  return `<div class="kpi-card"><div class="kpi-head">${esc(title)}</div>${rows}</div>`
}

function buildPage1(data: MonthlyReportData): string {
  const s = data.summary
  return `
  <section class="page">
    <h2 class="section-title">Sammanfattning</h2>
    <div class="card-grid">
      ${summaryCard(
        '#0F7B3E',
        'Omsättning denna månad',
        formatCurrency(s.revenue.current),
        `${deltaBadge(s.revenue.prevMonthPct)} mot förra månaden`,
        `${deltaBadge(s.revenue.prevYearPct)} mot samma månad förra året`,
      )}
      ${summaryCard(
        // Steg 3, PR 3a: ersätter tidigare hårdkodad #2563EB (ett av de 14
        // ställena i branding.ts-kartan) med den delade default-varumärkesfärgen.
        DEFAULT_BRAND_COLOR,
        'Beläggning',
        pct(s.occupancy.currentPct),
        `${deltaBadge(s.occupancy.prevMonthDeltaPct)} mot förra månaden`,
      )}
      ${summaryCard(
        '#D97706',
        'Förfallna fakturor',
        `${s.overdue.count} st`,
        `${formatCurrency(s.overdue.totalAmount)} totalt`,
        `${s.overdue.over30Count} st över 30 dagar`,
      )}
      ${summaryCard(
        '#0F1F47',
        'Hyresgäströrelse',
        `${s.tenants.newLeases} nya`,
        `${s.tenants.newLeases} nya kontrakt`,
        `${s.tenants.terminatedLeases} avslutade kontrakt`,
      )}
    </div>
  </section>`
}

function buildPage2(data: MonthlyReportData): string {
  const k = data.kpis
  const totalPaidCount =
    k.payments.onTime + k.payments.late1to7 + k.payments.late8to30 + k.payments.late30plus
  const paidPct = (n: number): string =>
    totalPaidCount > 0 ? ` (${Math.round((n / totalPaidCount) * 100)}%)` : ''

  const revenueCard = kpiCard(
    'Intäkter',
    kpiRow('Total fakturerad intäkt', formatCurrency(k.revenue.total)) +
      kpiRow('Hyresintäkter (RENT)', formatCurrency(k.revenue.rent)) +
      kpiRow('Tjänster (SERVICE)', formatCurrency(k.revenue.service)) +
      kpiRow('Förbrukning (UTILITY)', formatCurrency(k.revenue.utility)) +
      kpiRow('Deposition (DEPOSIT)', formatCurrency(k.revenue.deposit)) +
      kpiRow('Övrigt (OTHER)', formatCurrency(k.revenue.other)) +
      kpiRow('Varav inbetalt under månaden', formatCurrency(k.revenue.paid)),
  )

  const occupancyCard = kpiCard(
    'Beläggning (nuläge)',
    kpiRow('Antal lägenheter totalt', String(k.occupancy.totalUnits)) +
      kpiRow('Uthyrda', String(k.occupancy.occupied)) +
      kpiRow('Lediga', String(k.occupancy.vacant)) +
      kpiRow('Under renovering', String(k.occupancy.renovation)) +
      kpiRow('Reserverade', String(k.occupancy.reserved)) +
      kpiRow('Beläggningsgrad', pct(k.occupancy.ratePct)),
  )

  const paymentsCard = kpiCard(
    'Betalningsmönster',
    kpiRow('I tid', `${k.payments.onTime} st${paidPct(k.payments.onTime)}`) +
      kpiRow('1–7 dagar sent', `${k.payments.late1to7} st${paidPct(k.payments.late1to7)}`) +
      kpiRow('8–30 dagar sent', `${k.payments.late8to30} st${paidPct(k.payments.late8to30)}`) +
      kpiRow('30+ dagar sent', `${k.payments.late30plus} st${paidPct(k.payments.late30plus)}`),
  )

  const maintenanceCard = kpiCard(
    'Underhåll',
    kpiRow('Inkomna felanmälningar', String(k.maintenance.incoming)) +
      kpiRow('Lösta felanmälningar', String(k.maintenance.resolved)) +
      kpiRow(
        'Genomsnittlig lösningstid',
        k.maintenance.avgResolutionDays === null ? '—' : `${k.maintenance.avgResolutionDays} dagar`,
      ) +
      (k.maintenance.topProperties.length > 0
        ? k.maintenance.topProperties
            .map((p, i) => kpiRow(`Mest ärenden #${i + 1}`, `${esc(p.name)} (${p.count} st)`))
            .join('')
        : kpiRow('Fastigheter med ärenden', 'Inga ärenden denna månad')),
  )

  return `
  <section class="page">
    <h2 class="section-title">Detaljerade nyckeltal</h2>
    <div class="card-grid">
      ${revenueCard}
      ${occupancyCard}
      ${paymentsCard}
      ${maintenanceCard}
    </div>
  </section>`
}

function buildPage3(data: MonthlyReportData): string {
  const rows =
    data.properties.length > 0
      ? data.properties
          .map(
            (p) => `
        <tr>
          <td class="td-name">${esc(p.name)}</td>
          <td class="td-num">${formatCurrency(p.revenue)}</td>
          <td class="td-num">${pct(p.occupancyPct)}</td>
          <td class="td-num">${p.vacant}</td>
          <td class="td-num">${p.tickets}</td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="5" class="td-empty">Inga fastigheter registrerade.</td></tr>`
  return `
  <section class="page">
    <h2 class="section-title">Per fastighet</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Fastighet</th>
          <th class="th-num">Intäkter</th>
          <th class="th-num">Beläggning</th>
          <th class="th-num">Vakanta</th>
          <th class="th-num">Ärenden</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`
}

function buildPage4(data: MonthlyReportData): string {
  return `
  <section class="page">
    <h2 class="section-title">AI-insikter &amp; rekommendationer</h2>
    <div class="ai-card">
      ${renderAiInsights(data.aiInsights)}
    </div>
    <p class="ai-note">Insikterna är AI-genererade utifrån månadens portföljdata och bör läsas
      som beslutsstöd, inte som finansiell rådgivning.</p>
  </section>`
}

function buildPage5(data: MonthlyReportData): string {
  const newRows = data.appendix.newLeases
    .map(
      (l) => `
      <tr>
        <td>${esc(l.tenant)}</td>
        <td>${esc(l.property)} · ${esc(l.unit)}</td>
        <td class="td-num">${esc(l.startDate)}</td>
        <td class="td-num">${formatCurrency(l.monthlyRent)}</td>
      </tr>`,
    )
    .join('')
  const endRows = data.appendix.terminatedLeases
    .map(
      (l) => `
      <tr>
        <td>${esc(l.tenant)}</td>
        <td>${esc(l.property)} · ${esc(l.unit)}</td>
        <td class="td-num">${esc(l.endDate)}</td>
      </tr>`,
    )
    .join('')
  return `
  <section class="page">
    <h2 class="section-title">Appendix — kontraktsrörelser</h2>

    <h3 class="sub-title">Nya kontrakt denna månad (${data.appendix.newLeases.length})</h3>
    ${
      data.appendix.newLeases.length > 0
        ? `<table class="data-table">
            <thead><tr><th>Hyresgäst</th><th>Objekt</th><th class="th-num">Startdatum</th><th class="th-num">Månadshyra</th></tr></thead>
            <tbody>${newRows}</tbody>
          </table>`
        : `<p class="td-empty">Inga nya kontrakt denna månad.</p>`
    }

    <h3 class="sub-title">Avslutade kontrakt denna månad (${data.appendix.terminatedLeases.length})</h3>
    ${
      data.appendix.terminatedLeases.length > 0
        ? `<table class="data-table">
            <thead><tr><th>Hyresgäst</th><th>Objekt</th><th class="th-num">Avslutsdatum</th></tr></thead>
            <tbody>${endRows}</tbody>
          </table>`
        : `<p class="td-empty">Inga avslutade kontrakt denna månad.</p>`
    }
  </section>`
}

// ── Huvudfunktion ────────────────────────────────────────────────────────────

// Innehålls-CSS för rapporten. Steg 3, PR 3a: rapportens egna outer-wrapper
// (html/head/body), hero och per-sid-footer är borttagna — RAMEN (header/footer/
// typsnitt/varumärkesfärg) kommer nu från den gemensamma brandade shellen.
// body-regelns font-family är medvetet borttagen så att shellens typsnitt
// (org.brandFont) styr; övriga sektioner/data är oförändrade.
const REPORT_CONTENT_CSS = `
  * { box-sizing: border-box; }
  body {
    color: #1A2233;
    background: #FAFAF7;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    font-size: 12px;
    line-height: 1.5;
  }
  .page { page-break-after: always; padding-bottom: 24px; }
  .page:last-child { page-break-after: auto; }

  .section-title {
    font-size: 17px; font-weight: 700; letter-spacing: -0.01em;
    color: #0F1F47; margin: 0 0 14px;
  }
  .sub-title {
    font-size: 13px; font-weight: 700; color: #0F1F47;
    margin: 22px 0 8px;
  }

  /* Kortrutnät: 2×2 — används på sida 1 (sammanfattning) och sida 2 (KPI) */
  .card-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    align-items: start;
  }

  /* Sammanfattningskort (sida 1) */
  .sum-card {
    background: #FFFFFF; border: 1px solid #E7E5DF; border-radius: 12px;
    padding: 16px 18px; page-break-inside: avoid;
  }
  .sum-label {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: #6B7280; margin: 0 0 4px;
  }
  .sum-value {
    font-size: 26px; font-weight: 700; letter-spacing: -0.02em; color: #0F1F47;
  }
  .sum-sub { font-size: 11.5px; color: #4B5563; margin-top: 4px; }
  .delta {
    font-weight: 600; font-size: 11px; padding: 1px 6px;
    border-radius: 999px;
  }
  .delta-up { background: #E3F2E9; color: #0F7B3E; }
  .delta-down { background: #FBE7E5; color: #C0392B; }
  .delta-flat { background: #EEEDEA; color: #6B7280; }

  /* KPI-kort (sida 2) */
  .kpi-card {
    background: #FFFFFF; border: 1px solid #E7E5DF; border-radius: 12px;
    padding: 4px 18px 8px; page-break-inside: avoid;
  }
  .kpi-head {
    font-size: 12.5px; font-weight: 700; color: #0F1F47;
    padding: 12px 0 8px; border-bottom: 2px solid #0F1F47;
  }
  .kpi-row {
    display: flex; justify-content: space-between;
    padding: 7px 0; border-bottom: 1px solid #F0EFEC; font-size: 12px;
  }
  .kpi-row:last-child { border-bottom: none; }
  .kpi-label { color: #4B5563; }
  .kpi-value { font-weight: 600; color: #1A2233; text-align: right; }

  /* Tabeller (sida 3 + 5) */
  .data-table {
    width: 100%; border-collapse: collapse;
    background: #FFFFFF; border: 1px solid #E7E5DF;
    border-radius: 12px; overflow: hidden;
    page-break-inside: avoid;
  }
  .data-table th {
    background: #0F1F47; color: #FFFFFF; font-size: 10.5px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    text-align: left; padding: 10px 12px;
  }
  .data-table .th-num { text-align: right; }
  .data-table td {
    padding: 9px 12px; font-size: 11.5px;
    border-bottom: 1px solid #F0EFEC;
  }
  .data-table tr:last-child td { border-bottom: none; }
  .td-name { font-weight: 600; color: #0F1F47; }
  .td-num { text-align: right; }
  .td-empty { text-align: center; color: #6B7280; font-style: italic; }

  /* AI-sida (sida 4) */
  .ai-card {
    background: #FFFFFF; border: 1px solid #E7E5DF; border-radius: 12px;
    padding: 8px 22px 18px; page-break-inside: avoid;
  }
  .ai-heading {
    font-size: 12.5px; font-weight: 700; color: #0F1F47;
    margin: 18px 0 6px; padding-bottom: 5px; border-bottom: 2px solid #E7E5DF;
  }
  .ai-list { margin: 0 0 4px; padding-left: 18px; }
  .ai-list li { font-size: 12px; color: #374151; margin-bottom: 6px; }
  .ai-fallback { font-size: 12px; color: #6B7280; font-style: italic; }
  .ai-note { font-size: 10.5px; color: #9CA3AF; margin-top: 12px; }
`

/**
 * Bygger den fullständiga HTML-strängen för månadsrapportens PDF genom den
 * gemensamma brandade shellen (logga/primär-/sekundärfärg/typsnitt + konsekvent
 * header/footer från orgens varumärke). Renderas sedan av
 * PdfService.generateFromHtml(). Sida 5 (appendix) tas bara med om det finns
 * kontraktsrörelser att redovisa. RAPPORTENS DATA är oförändrad — bara ramen.
 */
export function generateMonthlyReportHtml(data: MonthlyReportData): string {
  const hasAppendix =
    data.appendix.newLeases.length > 0 || data.appendix.terminatedLeases.length > 0

  const pages = [buildPage1(data), buildPage2(data), buildPage3(data), buildPage4(data)]
  if (hasAppendix) pages.push(buildPage5(data))

  const contentHtml = `<style>${REPORT_CONTENT_CSS}</style>\n${pages.join('\n')}`

  return buildBrandedPdfHtml({
    org: data.brand.org,
    logoDataUrl: data.brand.logoDataUrl,
    primaryColor: data.brand.primaryColor,
    secondaryColor: data.brand.secondaryColor,
    brandFont: data.brand.brandFont,
    title: `Månadsrapport — ${data.header.monthLabel}`,
    contentHtml,
    footerNote: `Genererad av Eveno · ${data.header.generatedAt}`,
  })
}
