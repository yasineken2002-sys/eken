import { DEFAULT_BRAND_COLOR, resolveBrandFontStack } from '@eken/shared'

/**
 * Gemensam brandad PDF-shell (Steg 3, PR 2).
 *
 * Tar organisationens varumärke (logga, primär-/sekundärfärg, typsnitt,
 * org-info) + ett färdigt innehålls-HTML-block och returnerar komplett brandad
 * HTML redo för `PdfService.generateFromHtml` (befintlig Puppeteer-primitiv —
 * ingen ny renderingsväg införs här).
 *
 * VIKTIGT (Steg 3, PR 2): INGEN befintlig PDF kopplas in i shellen ännu. Den
 * byggs och testas isolerat; varje befintlig PDF-typ migreras i en egen senare
 * PR. Att importera den här filen ändrar inte hur någon befintlig PDF ser ut.
 *
 * SÄKERHET: all org-info och alla skalärer som shellen själv väver in (namn,
 * adress, titel, footer-notis …) escapas. `contentHtml` är PER KONTRAKT ett
 * redan säkert HTML-block som anroparen byggt (samma ansvarsmodell som dagens
 * mallar som skickar färdig HTML till generateFromHtml) — det escapas INTE.
 */

/** HTML-escape för skalärer shellen väver in. Skyddar mot &/<>/"/' i org-data. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

export interface BrandedPdfOrg {
  name: string
  orgNumber?: string | null
  street?: string | null
  postalCode?: string | null
  city?: string | null
  email?: string | null
  phone?: string | null
  bankgiro?: string | null
  vatNumber?: string | null
}

export interface BrandedPdfShellInput {
  org: BrandedPdfOrg
  /** Logga som data:-URL (se getLogoDataUrl). Saknas → org-namn visas i stället. */
  logoDataUrl?: string | null
  /** Primärfärg = Organization.invoiceColor. Saknas → DEFAULT_BRAND_COLOR. */
  primaryColor?: string | null
  /** Sekundär/accent = Organization.brandSecondaryColor. Saknas → härleds från primär. */
  secondaryColor?: string | null
  /** Organization.brandFont (enum-värde). resolveBrandFontStack hanterar fallback. */
  brandFont?: string | null
  /** Valfri dokumenttitel som visas i headern. */
  title?: string | null
  /** Färdigt, säkert HTML-block med själva dokumentinnehållet. Escapas INTE. */
  contentHtml: string
  /** Valfri extra rad i footern (escapas). */
  footerNote?: string | null
  /**
   * Döljer den avslutande footern helt. Default: footern visas (oförändrat
   * beteende). Avsett för betalningsinstrument (t.ex. hyresavin) där en
   * bankgiro-/avrivningsslip MÅSTE vara sidans understa element — en generisk
   * footer efter slipen vore strukturellt fel. Anroparen ansvarar då själv för
   * att org-kontaktuppgifterna finns i contentHtml.
   */
  hideFooter?: boolean
}

/** Validerar en hex-färg (#RGB/#RRGGBB); ogiltigt → fallback. Skyddar style-attr. */
function safeColor(value: string | null | undefined, fallback: string): string {
  return value && /^#[0-9A-Fa-f]{3,8}$/.test(value) ? value : fallback
}

/**
 * Bygger komplett brandad HTML. Pure — inga sidoeffekter, ingen I/O.
 * Logga/färg/font hämtas av anroparen och skickas in; defaults hanteras här.
 */
export function buildBrandedPdfHtml(input: BrandedPdfShellInput): string {
  const primary = safeColor(input.primaryColor, DEFAULT_BRAND_COLOR)
  // Saknad sekundärfärg → härled genom att komplettera med primärfärgen.
  const secondary = safeColor(input.secondaryColor, primary)
  const fontStack = resolveBrandFontStack(input.brandFont)

  const org = input.org
  const addressLine = [org.street, [org.postalCode, org.city].filter(Boolean).join(' ')]
    .filter((p) => p && p.trim())
    .map((p) => escapeHtml(p as string))
    .join(', ')

  // Footer-metarader: bara de fält som faktiskt finns, alla escapade.
  const footerMeta = [
    org.orgNumber ? `Org.nr ${escapeHtml(org.orgNumber)}` : null,
    org.vatNumber ? `Momsreg.nr ${escapeHtml(org.vatNumber)}` : null,
    org.bankgiro ? `Bankgiro ${escapeHtml(org.bankgiro)}` : null,
    org.email ? escapeHtml(org.email) : null,
    org.phone ? escapeHtml(org.phone) : null,
  ].filter(Boolean) as string[]

  const safeOrgName = escapeHtml(org.name)
  const brandMark = input.logoDataUrl
    ? `<img class="bp-logo" src="${input.logoDataUrl}" alt="${safeOrgName}" />`
    : `<span class="bp-orgname">${safeOrgName}</span>`

  const titleBlock = input.title ? `<h1 class="bp-title">${escapeHtml(input.title)}</h1>` : ''

  const footerNoteBlock = input.footerNote
    ? `<div class="bp-footer-note">${escapeHtml(input.footerNote)}</div>`
    : ''

  // Footern utelämnas helt när hideFooter är satt (betalningsinstrument där en
  // slip ska vara sidans botten). Default → footern renderas som tidigare.
  const footerBlock = input.hideFooter
    ? ''
    : `
  <footer class="bp-footer">
    <div class="bp-footer-org">${safeOrgName}</div>
    ${addressLine ? `<div>${addressLine}</div>` : ''}
    ${footerMeta.length ? `<div>${footerMeta.join(' · ')}</div>` : ''}
    ${footerNoteBlock}
  </footer>`

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ${fontStack};
      font-size: 13px;
      line-height: 1.6;
      color: #1f2937;
    }
    .bp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 16px;
      border-bottom: 3px solid ${primary};
      margin-bottom: 24px;
    }
    .bp-logo { max-height: 56px; max-width: 220px; object-fit: contain; }
    .bp-orgname { font-size: 20px; font-weight: 700; color: ${primary}; }
    .bp-title {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      color: ${secondary};
      text-align: right;
    }
    .bp-content { font-size: 13px; }
    .bp-footer {
      margin-top: 40px;
      padding-top: 12px;
      border-top: 1px solid ${secondary};
      color: #6b7280;
      font-size: 11px;
    }
    .bp-footer .bp-footer-org { font-weight: 600; color: #374151; }
    .bp-footer-note { margin-top: 4px; }
  </style>
</head>
<body>
  <header class="bp-header">
    <div class="bp-brand">${brandMark}</div>
    ${titleBlock}
  </header>

  <main class="bp-content">
    ${input.contentHtml}
  </main>
${footerBlock}
</body>
</html>`
}
