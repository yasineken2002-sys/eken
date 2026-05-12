import { PLATFORM_COMPANY } from '@eken/shared'

export interface PlatformInvoicePdfData {
  invoiceNumber: string
  invoiceDate: Date
  dueDate: Date
  type: 'PLAN_FEE' | 'AI_CREDITS' | 'OTHER'
  description: string | null
  planPeriodStart: Date | null
  planPeriodEnd: Date | null
  amountNetSek: number
  vatRate: number
  vatAmountSek: number
  amountGrossSek: number
  ocrNumber: string
  customer: {
    name: string
    orgNumber: string | null
    email: string
    street: string
    postalCode: string
    city: string
    country: string
  }
}

const MONTHS_SV = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
]

function fmtDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function planPeriodLabel(start: Date | null, end: Date | null): string {
  if (!start || !end) return ''
  const startMonth = MONTHS_SV[start.getMonth()]
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startMonth} ${start.getFullYear()}`
  }
  return `${fmtDate(start)} – ${fmtDate(end)}`
}

/**
 * HTML-mall för plattformsfaktura. Genereras till PDF via PdfService.
 * Layout: header med Eveno-logga + bolagsuppgifter (vänster) och
 * fakturanummer/datum (höger), mottagarblock, specifikationstabell,
 * summering med moms, betalblock med bankgiro + OCR, footer med F-skatt.
 */
export function generatePlatformInvoiceHtml(data: PlatformInvoicePdfData): string {
  const c = PLATFORM_COMPANY
  const periodLabel = planPeriodLabel(data.planPeriodStart, data.planPeriodEnd)

  const lineDescription =
    data.type === 'PLAN_FEE'
      ? `Eveno – Plattformsavgift${periodLabel ? ` (${periodLabel})` : ''}`
      : data.type === 'AI_CREDITS'
        ? (data.description ?? 'Extra AI-credits')
        : (data.description ?? 'Tjänst')

  // Allt inline-styled: Puppeteer renderar HTML utan extern CSS-laddning,
  // och vi vill att layouten är förutsägbar oberoende av miljö.
  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <title>Faktura ${data.invoiceNumber}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      color: #111827;
      font-size: 12px;
      line-height: 1.5;
      margin: 0;
      padding: 32px 40px;
      -webkit-print-color-adjust: exact;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid ${c.primaryColor};
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .brand {
      font-size: 26px;
      font-weight: 700;
      color: ${c.primaryColor};
      letter-spacing: -0.02em;
    }
    .brand-sub { color: #6B7280; font-size: 11px; margin-top: 2px; }
    .meta { text-align: right; font-size: 11px; }
    .meta .label { color: #6B7280; }
    .meta .value { font-weight: 600; color: #111827; }
    .meta table { border-collapse: collapse; }
    .meta td { padding: 1px 0; }
    .meta td:first-child { padding-right: 14px; }
    .blocks {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    .block-title {
      font-size: 11px;
      font-weight: 600;
      color: #6B7280;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 6px;
    }
    .block-body { font-size: 12px; color: #111827; line-height: 1.55; }
    table.specification {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0 8px;
    }
    table.specification thead th {
      background: #F7F8FA;
      font-size: 10.5px;
      font-weight: 600;
      color: #6B7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #E5E7EB;
    }
    table.specification tbody td {
      padding: 10px;
      border-bottom: 1px solid #F3F4F6;
      vertical-align: top;
    }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .totals {
      margin-top: 12px;
      margin-left: auto;
      width: 280px;
      font-size: 12px;
    }
    .totals .row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
    }
    .totals .row.total {
      border-top: 2px solid #111827;
      padding-top: 8px;
      margin-top: 6px;
      font-weight: 700;
      font-size: 14px;
    }
    .pay-block {
      margin-top: 24px;
      background: #F7F8FA;
      border: 1px solid #E5E7EB;
      border-left: 4px solid ${c.primaryColor};
      border-radius: 8px;
      padding: 14px 16px;
    }
    .pay-block h3 {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #6B7280;
    }
    .pay-block table { width: 100%; border-collapse: collapse; }
    .pay-block td { padding: 2px 0; }
    .pay-block td:first-child { color: #6B7280; padding-right: 16px; width: 130px; }
    .pay-block td:last-child { font-weight: 600; }
    .ocr { font-family: 'Menlo', 'Monaco', monospace; font-size: 14px; letter-spacing: 0.05em; }
    .footer {
      margin-top: 28px;
      border-top: 1px solid #E5E7EB;
      padding-top: 12px;
      font-size: 10.5px;
      color: #6B7280;
      display: flex;
      justify-content: space-between;
    }
    .footer .fskatt {
      background: #DCFCE7;
      color: #166534;
      padding: 4px 8px;
      border-radius: 4px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">${c.brandName}</div>
      <div class="brand-sub">${c.legalName} · Org.nr ${c.orgNumber} · ${c.vatNumber}</div>
    </div>
    <div class="meta">
      <table>
        <tr><td class="label">Fakturanummer</td><td class="value">${data.invoiceNumber}</td></tr>
        <tr><td class="label">Fakturadatum</td><td class="value">${fmtDate(data.invoiceDate)}</td></tr>
        <tr><td class="label">Förfallodatum</td><td class="value">${fmtDate(data.dueDate)}</td></tr>
      </table>
    </div>
  </div>

  <div class="blocks">
    <div>
      <div class="block-title">Från</div>
      <div class="block-body">
        <strong>${c.legalName}</strong><br />
        ${c.street}<br />
        ${c.postalCode} ${c.city}<br />
        ${c.country}<br />
        ${c.email}
      </div>
    </div>
    <div>
      <div class="block-title">Till</div>
      <div class="block-body">
        <strong>${escapeHtml(data.customer.name)}</strong><br />
        ${data.customer.orgNumber ? `Org.nr ${escapeHtml(data.customer.orgNumber)}<br />` : ''}
        ${escapeHtml(data.customer.street)}<br />
        ${escapeHtml(data.customer.postalCode)} ${escapeHtml(data.customer.city)}<br />
        ${escapeHtml(data.customer.country)}<br />
        ${escapeHtml(data.customer.email)}
      </div>
    </div>
  </div>

  <table class="specification">
    <thead>
      <tr>
        <th>Beskrivning</th>
        <th class="num">Antal</th>
        <th class="num">à-pris (exkl moms)</th>
        <th class="num">Belopp (exkl moms)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${escapeHtml(lineDescription)}</td>
        <td class="num">1</td>
        <td class="num">${fmtCurrency(data.amountNetSek)}</td>
        <td class="num">${fmtCurrency(data.amountNetSek)}</td>
      </tr>
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Belopp exkl moms</span><span class="num">${fmtCurrency(data.amountNetSek)}</span></div>
    <div class="row"><span>Moms ${data.vatRate}%</span><span class="num">${fmtCurrency(data.vatAmountSek)}</span></div>
    <div class="row total"><span>Att betala</span><span class="num">${fmtCurrency(data.amountGrossSek)}</span></div>
  </div>

  <div class="pay-block">
    <h3>Betalning</h3>
    <table>
      <tr><td>Bankgiro</td><td>${c.bankgiro}</td></tr>
      <tr><td>OCR-nummer</td><td class="ocr">${data.ocrNumber}</td></tr>
      <tr><td>Förfallodatum</td><td>${fmtDate(data.dueDate)}</td></tr>
      <tr><td>Att betala</td><td>${fmtCurrency(data.amountGrossSek)}</td></tr>
    </table>
  </div>

  <div class="footer">
    <div>
      ${c.legalName} · ${c.street} · ${c.postalCode} ${c.city}<br />
      ${c.invoicingEmail} · ${c.website}
    </div>
    ${c.hasFSkatt ? '<div class="fskatt">Innehar F-skatt</div>' : ''}
  </div>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
