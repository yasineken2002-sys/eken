/**
 * Gemensam brandad PDF-shell (Steg 3, PR 2). Testas ISOLERAT (given input →
 * förväntad brandad HTML-struktur), inte via någon befintlig PDF-typ.
 * Verifierar: logga/org-namn-fallback, primär-/sekundärfärg, font-stack,
 * sekundärfärg-fallback, font-fallback, HTML-escaping av org-info + titel,
 * och att contentHtml vävs in oförändrat.
 */

import { BRAND_FONT_STACKS, DEFAULT_BRAND_COLOR } from '@eken/shared'
import { buildBrandedPdfHtml } from './branded-pdf-shell'

const BASE_ORG = {
  name: 'Värd AB',
  orgNumber: '556000-0001',
  street: 'Storgatan 1',
  postalCode: '111 22',
  city: 'Stockholm',
  email: 'info@vard.se',
  phone: '08-123 456',
  bankgiro: '123-4567',
  vatNumber: 'SE556000000101',
}

describe('buildBrandedPdfHtml', () => {
  it('väver in primärfärg, sekundärfärg och font-stack', () => {
    const html = buildBrandedPdfHtml({
      org: BASE_ORG,
      primaryColor: '#1a3a6b',
      secondaryColor: '#aa2222',
      brandFont: 'GEORGIA',
      contentHtml: '<p>Innehåll</p>',
    })
    expect(html).toContain('#1a3a6b') // primär
    expect(html).toContain('#aa2222') // sekundär
    expect(html).toContain(BRAND_FONT_STACKS.GEORGIA) // upplöst font-stack
    expect(html).toContain('<!DOCTYPE html>')
  })

  it('visar logga när logoDataUrl finns, annars org-namn', () => {
    const withLogo = buildBrandedPdfHtml({
      org: BASE_ORG,
      logoDataUrl: 'data:image/png;base64,AAAA',
      contentHtml: '<p>x</p>',
    })
    expect(withLogo).toContain('<img class="bp-logo" src="data:image/png;base64,AAAA"')

    const noLogo = buildBrandedPdfHtml({ org: BASE_ORG, contentHtml: '<p>x</p>' })
    expect(noLogo).not.toContain('<img class="bp-logo"')
    expect(noLogo).toContain('class="bp-orgname">Värd AB<')
  })

  it('saknad primärfärg → DEFAULT_BRAND_COLOR; saknad sekundärfärg → härleds från primär', () => {
    const html = buildBrandedPdfHtml({
      org: BASE_ORG,
      primaryColor: '#1a3a6b',
      // ingen secondaryColor
      contentHtml: '<p>x</p>',
    })
    // sekundär härleds = primär → primärfärgen förekommer både i header-border och footer-border
    const occurrences = html.split('#1a3a6b').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)

    const noColors = buildBrandedPdfHtml({ org: BASE_ORG, contentHtml: '<p>x</p>' })
    expect(noColors).toContain(DEFAULT_BRAND_COLOR)
  })

  it('saknad/okänd font → default-stacken (SYSTEM_SANS)', () => {
    const html = buildBrandedPdfHtml({ org: BASE_ORG, contentHtml: '<p>x</p>' })
    expect(html).toContain(BRAND_FONT_STACKS.SYSTEM_SANS)
    const bogus = buildBrandedPdfHtml({
      org: BASE_ORG,
      brandFont: 'NONSENS',
      contentHtml: '<p>x</p>',
    })
    expect(bogus).toContain(BRAND_FONT_STACKS.SYSTEM_SANS)
  })

  it('escapar org-namn, adress och titel (ingen XSS via org-data)', () => {
    const html = buildBrandedPdfHtml({
      org: {
        ...BASE_ORG,
        name: 'Värd <script>alert(1)</script> AB',
        street: 'Stor<gatan> 1',
      },
      title: 'Faktura <img src=x onerror=alert(2)>',
      contentHtml: '<p>säkert innehåll</p>',
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;gatan&gt;')
    // titeln escapad
    expect(html).toContain('Faktura &lt;img src=x')
  })

  it('väver in contentHtml oförändrat (anroparens redan säkra block)', () => {
    const content = '<table><tr><td>Rad 1</td></tr></table>'
    const html = buildBrandedPdfHtml({ org: BASE_ORG, contentHtml: content })
    expect(html).toContain(content)
  })

  it('ogiltig färgsträng faller tillbaka (skyddar style-attributet)', () => {
    const html = buildBrandedPdfHtml({
      org: BASE_ORG,
      primaryColor: 'red; } body { background: url(javascript:alert(1)) ' as never,
      contentHtml: '<p>x</p>',
    })
    expect(html).not.toContain('javascript:')
    expect(html).toContain(DEFAULT_BRAND_COLOR) // fallback
  })

  it('footer visar bara fält som finns (inga tomma rader)', () => {
    const minimal = buildBrandedPdfHtml({
      org: { name: 'Enkel Värd' },
      contentHtml: '<p>x</p>',
    })
    expect(minimal).toContain('Enkel Värd')
    expect(minimal).not.toContain('Org.nr')
    expect(minimal).not.toContain('Bankgiro')
  })

  it('hideFooter utelämnar footern helt; default visar den (betalningsinstrument)', () => {
    // Default: footern renderas (oförändrat beteende — 3a/3b påverkas inte).
    const withFooter = buildBrandedPdfHtml({ org: BASE_ORG, contentHtml: '<p>x</p>' })
    expect(withFooter).toContain('class="bp-footer"')
    expect(withFooter).toContain('Org.nr 556000-0001')

    // hideFooter: footern (och därmed org-metaraden/bankgiro) försvinner helt.
    const hidden = buildBrandedPdfHtml({
      org: BASE_ORG,
      contentHtml: '<p>x</p>',
      hideFooter: true,
    })
    expect(hidden).not.toContain('class="bp-footer"')
    expect(hidden).not.toContain('Org.nr')
    expect(hidden).not.toContain('Bankgiro 123-4567')
    // Headern och innehållet finns kvar.
    expect(hidden).toContain('class="bp-header"')
    expect(hidden).toContain('<p>x</p>')
  })
})
