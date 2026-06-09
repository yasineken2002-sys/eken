/**
 * Steg 3, PR 3e — inkassounderlaget (collection-export.service.ts) renderas nu
 * genom den gemensamma brandade shellen (buildBrandedPdfHtml, hideFooter) i
 * stället för egen inline-HTML med hårdkodad grön #1a4a28 och ingen logga.
 *
 * Detta är systemets MEST juridiskt laddade dokument — det går till ett
 * inkassobolag med ett krav mot en hyresgäst. Testet låser därför att
 * migreringen är BYTE-FÖR-BYTE neutral för allt bindande innehåll:
 *
 *   (a) Den HYRESJURIST-KRÄVDA DISCLAIMERN — att borgenären ansvarar för att
 *       skicka vidare till inkassobolaget, att Eveno INTE bedriver inkasso-
 *       verksamhet, samt lagrum (1981:739) — ordagrant oförändrad.
 *   (b) ALLA belopp: radbelopp (skuldspecifikation), total skuld (= invoice.total)
 *       och de samlade påminnelseavgifterna — oförändrade.
 *   (c) Borgenär (org.nr) + gäldenär (personnr) + förfallodatum + kontrakts-
 *       referens — oförändrade.
 *
 * OBS (medveten avgränsning): DETTA inkasso-PDF har — till skillnad från
 * hyresavi-/avi-inkassoflödet — INGEN OCR-rad, INGET bankgiro och INGEN
 * period-segmenterad dröjsmålsränta i dokumentet. Testet låser att inget sådant
 * smyger in via shellen (bankgiro finns på org men får ALDRIG synas här — det
 * vore en betalningsväg som motsäger inkassoflödet).
 *
 * Visuell ändring (avsiktlig, ej innehåll): egen grön #1a4a28 → DEFAULT_BRAND_COLOR.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { CollectionExportService } from './collection-export.service'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'

function formatSek(amount: number): string {
  return `${amount.toLocaleString('sv-SE', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} kr`
}

const ORG = {
  name: 'Värd & Co', // '&' → escapas i shell-headern och i Borgenär-boxen
  orgNumber: '556000-0001',
  street: 'Storgatan 1',
  postalCode: '111 22',
  city: 'Stockholm',
  email: 'kontakt@vard.se',
  phone: '08-123 456',
  bankgiro: '1234-5678', // finns på org men FÅR INTE synas i inkassounderlaget
  vatNumber: 'SE556000000101',
  invoiceColor: null, // → DEFAULT_BRAND_COLOR
  brandSecondaryColor: null,
  brandFont: null,
  logoStorageKey: null, // → getLogoDataUrl returnerar null utan storage-anrop
}

const INVOICE = {
  invoiceNumber: 'INV-2026-0042',
  dueDate: new Date('2026-05-31T00:00:00Z'),
  total: 8120,
  status: 'OVERDUE',
  organization: ORG,
  tenant: {
    type: 'INDIVIDUAL',
    firstName: 'Anna',
    lastName: "O'Brien & <x>", // apostrof + &/<> → escapas (aldrig rått)
    companyName: null,
    personalNumber: '900101-1234',
    orgNumber: null,
    email: 'anna@example.se',
    phone: '070-111 22 33',
    street: 'Gränsgatan 5',
    postalCode: '222 33',
    city: 'Göteborg',
  },
  customer: null,
  lines: [{ description: 'Hyra & moms <maj>', quantity: 1, unitPrice: 8000, total: 8000 }],
  paymentReminders: [
    { type: 'REMINDER_FRIENDLY', sentAt: new Date('2026-06-05T00:00:00Z'), feeAmount: 60 },
    { type: 'REMINDER_FORMAL', sentAt: new Date('2026-06-20T00:00:00Z'), feeAmount: 60 },
  ],
  lease: {
    unit: { name: 'Lgh 1001', unitNumber: '1001', property: { name: 'Storgatan 1' } },
  },
}

function makeService(): CollectionExportService {
  const noop = {}
  return new CollectionExportService(
    noop as never, // prisma
    noop as never, // pdf
    noop as never, // storage
    noop as never, // pdfQueue
  )
}

async function render(): Promise<string> {
  // buildPdfHtml är privat men är den enda rena renderingsvägen.
  return (makeService() as unknown as { buildPdfHtml(i: unknown): Promise<string> }).buildPdfHtml(
    INVOICE,
  )
}

describe('CollectionExportService.buildPdfHtml — brandad shell + juridisk/ekonomisk integritet (PR 3e)', () => {
  it('(a) den hyresjurist-krävda disclaimern är byte-för-byte oförändrad', async () => {
    const html = await render()
    const text = html.replace(/\s+/g, ' ')
    expect(text).toContain(
      'Detta dokument är ett underlag för inkassoärende. Borgenären ansvarar för att ' +
        'skicka det vidare till sitt valda inkassobolag (t.ex. Visma Collectors, Intrum ' +
        'eller Lindorff). Eveno är ett fastighetssystem och bedriver INTE ' +
        'inkassoverksamhet. Påminnelseavgift utgår enligt lag (1981:739) om ersättning ' +
        'för inkassokostnader.',
    )
    // Lagrum + de tre laddade fraserna explicit (icke förhandlingsbart).
    expect(text).toContain('bedriver INTE inkassoverksamhet')
    expect(text).toContain('lag (1981:739)')
    expect(text).toContain('Borgenären ansvarar för att')
  })

  it('(b) alla belopp är oförändrade: radbelopp, total skuld, påminnelseavgifter', async () => {
    const html = await render()
    expect(html).toContain(`${formatSek(8000)}`) // radbelopp (à-pris + summa)
    expect(html).toContain(`${formatSek(8120)}`) // total skuld = invoice.total
    expect(html).toContain(`Inkluderar påminnelseavgifter ${formatSek(120)}`) // 60 + 60
  })

  it('(c) borgenär, gäldenär, förfallodatum och kontraktsreferens bevaras', async () => {
    const html = await render()
    expect(html).toContain('Borgenär (fastighetsägare)')
    expect(html).toContain('Org.nr: 556000-0001')
    expect(html).toContain('Gäldenär (hyresgäst)')
    expect(html).toContain('Personnr: 900101-1234')
    expect(html).toContain('2026-05-31') // förfallodatum (sv-SE)
    expect(html).toContain('Storgatan 1 – Lgh 1001 (1001)') // kontraktsreferens
    expect(html).toContain('Genererat')
    expect(html).toContain('Eveno fastighetssystem')
  })

  it('renderas genom shellen (header + titel) UTAN footer (disclaimern är sista ordet)', async () => {
    const html = await render()
    expect(html).toContain('class="bp-header"')
    expect(html).toContain('Inkassounderlag') // dokumenttitel via shellen
    expect(html).not.toContain('class="bp-footer"') // hideFooter
  })

  it('avgränsning: INGEN OCR, INGET bankgiro och INGEN dröjsmålsränta i dokumentet', async () => {
    const html = await render()
    expect(html).not.toContain('1234-5678') // org-bankgiro får ALDRIG synas här
    expect(html).not.toContain('Bankgiro')
    expect(html).not.toContain('OCR')
    expect(html).not.toContain('#41#') // ingen maskinläsbar giro-rad
    expect(html).not.toContain('Dröjsmålsränta')
    expect(html).not.toMatch(/ränta/i)
  })

  it('färg: egen grön #1a4a28 → DEFAULT_BRAND_COLOR (avsiktlig enhetlig brandfärg)', async () => {
    const html = await render()
    expect(html).toContain(DEFAULT_BRAND_COLOR)
    expect(html).not.toContain('#1a4a28')
  })

  it('escapar fri text (radbeskrivning, gäldenärnamn, org-namn) men ALDRIG belopp/disclaimer', async () => {
    const html = await render()
    expect(html).toContain('Hyra &amp; moms &lt;maj&gt;') // radbeskrivning escapad
    expect(html).toContain('O&#x27;Brien &amp; &lt;x&gt;') // gäldenärnamn (apostrof via shell-escape)
    expect(html).toContain('Värd &amp; Co') // org-namn escapat
    expect(html).not.toContain('<maj>')
    expect(html).not.toContain('<x>')
  })
})
