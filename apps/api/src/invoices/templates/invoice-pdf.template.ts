import type { Decimal } from '@prisma/client/runtime/library'

interface InvoicePdfData {
  invoiceColor?: string
  invoiceTemplate?: string
  invoice: {
    invoiceNumber: string
    type: string
    status: string
    issueDate: Date | string
    dueDate: Date | string
    reference: string | null
    ocrNumber: string | null
    subtotal: Decimal | number
    vatTotal: Decimal | number
    total: Decimal | number
    lines: Array<{
      description: string
      quantity: Decimal | number
      unitPrice: Decimal | number
      vatRate: number
      total: Decimal | number
    }>
    tenant: {
      type: string
      firstName: string | null
      lastName: string | null
      companyName: string | null
      email: string
      phone: string | null
      address?: {
        street: string
        city: string
        postalCode: string
      } | null
    }
    organization: {
      name: string
      orgNumber: string | null
      email: string | null
      street: string | null
      city: string | null
      postalCode: string | null
      bankgiro: string | null
      logoUrl: string | null
    }
  }
  logoBase64: string | null
}

function formatSek(value: Decimal | number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(Number(value))
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString('sv-SE')
}

function tenantName(t: InvoicePdfData['invoice']['tenant']): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  }
  return t.companyName ?? '–'
}

function detectMime(logoUrl: string): string {
  const ext = logoUrl.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

export function generateInvoiceHtml(data: InvoicePdfData): string {
  const { invoice, logoBase64 } = data
  const color = data.invoiceColor ?? '#1a6b3c'
  const template = data.invoiceTemplate ?? 'classic'
  const { tenant, organization } = invoice

  const logoHtml = logoBase64
    ? `<img src="data:${detectMime(organization.logoUrl ?? '')};base64,${logoBase64}"
            alt="${organization.name}" style="max-height:56px;max-width:180px;object-fit:contain;">`
    : `<span style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:${color};">${organization.name}</span>`

  // Template-specific header HTML
  let headerHtml: string
  if (template === 'modern') {
    headerHtml = `
<div style="background:${color};padding:32px 40px;margin:-40px -40px 40px -40px;display:flex;align-items:center;justify-content:space-between;">
  <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;">${organization.name}</div>
  <div style="font-size:32px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">FAKTURA</div>
</div>`
  } else if (template === 'minimal') {
    headerHtml = `
<div style="margin-bottom:32px;padding-bottom:16px;border-bottom:2px solid ${color};">
  <div style="font-size:26px;font-weight:700;color:${color};letter-spacing:-0.5px;">${organization.name}</div>
  <div style="font-size:15px;color:#6b7280;margin-top:6px;">${invoice.invoiceNumber}</div>
</div>`
  } else {
    // classic (default)
    headerHtml = `
<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:40px;">
  <div>${logoHtml}</div>
  <div style="text-align:right;">
    <div style="font-size:32px;font-weight:800;color:${color};letter-spacing:-0.5px;">FAKTURA</div>
    <div style="font-size:15px;color:#6b7280;margin-top:2px;">${invoice.invoiceNumber}</div>
    ${invoice.reference ? `<span style="display:inline-block;background:#e8f5ee;color:${color};border-radius:999px;padding:2px 12px;font-size:13px;font-weight:600;margin-top:4px;">${invoice.reference}</span>` : ''}
  </div>
</div>`
  }

  const tenantAddress = tenant.address
    ? `<div style="color:#374151;">${tenant.address.street}</div>
       <div style="color:#374151;">${tenant.address.postalCode} ${tenant.address.city}</div>`
    : ''

  const orgAddress = [organization.street, organization.postalCode, organization.city]
    .filter(Boolean)
    .join(' · ')

  const linesHtml = invoice.lines
    .map(
      (line, i) => `
      <tr style="background:${i % 2 === 1 ? '#f9fafb' : '#ffffff'};">
        <td style="padding:10px 12px;color:#111827;">${line.description}</td>
        <td style="padding:10px 12px;text-align:right;color:#374151;">${Number(line.quantity)}</td>
        <td style="padding:10px 12px;text-align:right;color:#374151;">${formatSek(line.unitPrice)}</td>
        <td style="padding:10px 12px;text-align:right;color:#374151;">${line.vatRate}%</td>
        <td style="padding:10px 12px;text-align:right;font-weight:600;color:#111827;">${formatSek(line.total)}</td>
      </tr>`,
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @page { size: A4; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    color: #111827;
    background: #ffffff;
    padding: 40px;
    width: 210mm;
    min-height: 297mm;
  }
  table { border-collapse: collapse; width: 100%; }
  th {
    padding: 10px 12px;
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    background: #f3f4f6;
    border-bottom: 1px solid #e2e8f0;
  }
  th:not(:first-child) { text-align: right; }
  .label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #9ca3af;
    margin-bottom: 4px;
  }
</style>
</head>
<body>

<!-- HEADER -->
${headerHtml}

<!-- META GRID -->
<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:36px;">
  <div style="background:#f9fafb;border-radius:8px;padding:20px;">
    <div class="label">Faktureras till</div>
    <div style="font-size:16px;font-weight:700;color:#111827;margin-bottom:4px;">${tenantName(tenant)}</div>
    <div style="color:#4b5563;margin-bottom:2px;">${tenant.email}</div>
    ${tenant.phone ? `<div style="color:#4b5563;margin-bottom:2px;">${tenant.phone}</div>` : ''}
    ${tenantAddress}
  </div>
  <div style="background:#f9fafb;border-radius:8px;padding:20px;">
    <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;align-items:baseline;">
      <span class="label" style="margin-bottom:0;">Utfärdandedatum</span>
      <span style="font-weight:500;">${formatDate(invoice.issueDate)}</span>
      <span class="label" style="margin-bottom:0;">Förfallodatum</span>
      <span style="font-weight:600;color:#dc2626;">${formatDate(invoice.dueDate)}</span>
      <span class="label" style="margin-bottom:0;">Betalningsvillkor</span>
      <span>30 dagar</span>
      <span class="label" style="margin-bottom:0;">Bankgiro</span>
      <span style="font-weight:500;">${organization.bankgiro ?? '–'}</span>
    </div>
  </div>
</div>

<!-- INVOICE LINES -->
<table style="margin-bottom:0;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
  <thead>
    <tr>
      <th style="text-align:left;">Beskrivning</th>
      <th>Antal</th>
      <th>À-pris</th>
      <th>Moms</th>
      <th>Belopp</th>
    </tr>
  </thead>
  <tbody>
    ${linesHtml}
  </tbody>
</table>

<!-- TOTALS -->
<div style="display:flex;justify-content:flex-end;margin-top:24px;">
  <div style="min-width:280px;">
    <div style="display:flex;justify-content:space-between;padding:6px 0;color:#374151;">
      <span>Netto exkl. moms</span>
      <span>${formatSek(invoice.subtotal)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;color:#374151;">
      <span>Moms</span>
      <span>${formatSek(invoice.vatTotal)}</span>
    </div>
    <div style="border-top:2px solid #111827;margin:8px 0;"></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;">
      <span style="font-size:17px;font-weight:700;color:#111827;">Att betala</span>
      <span style="font-size:17px;font-weight:800;color:${color};">${formatSek(invoice.total)}</span>
    </div>
  </div>
</div>

${
  invoice.ocrNumber
    ? `
<!-- OCR -->
<div style="margin-top:32px;background:#f5f5f5;border:1px solid #ddd;border-radius:8px;padding:16px 20px;text-align:center;">
  <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">
    OCR-nummer — ange alltid vid betalning
  </div>
  <div style="font-size:26px;font-weight:700;font-family:'Courier New',monospace;letter-spacing:4px;color:${color};">
    ${invoice.ocrNumber}
  </div>
  <div style="font-size:10px;color:#888;margin-top:6px;">
    Bankgiro: <strong>${organization.bankgiro ?? '–'}</strong> · Att betala: <strong>${formatSek(invoice.total)}</strong>
  </div>
</div>`
    : ''
}

<!-- FOOTER -->
<div style="position:fixed;bottom:32px;left:40px;right:40px;
            border-top:1px solid #e2e8f0;padding-top:12px;
            font-size:11px;color:#9ca3af;display:flex;justify-content:space-between;">
  <span>${organization.name}${organization.orgNumber ? ' · ' + organization.orgNumber : ''}</span>
  <span>${[organization.email, orgAddress].filter(Boolean).join(' · ')}</span>
</div>

</body>
</html>`
}
