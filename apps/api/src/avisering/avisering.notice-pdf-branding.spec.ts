/**
 * Steg 3, PR 3c — hyresavins PDF renderas genom den gemensamma brandade shellen
 * (buildBrandedPdfHtml, hideFooter). Avin är ett BETALNINGSINSTRUMENT, så detta
 * test låser framför allt att de BETALNINGSBÄRANDE fälten är BYTE-FÖR-BYTE
 * oförändrade efter migreringen:
 *   • OCR-nummer
 *   • OCR-maskinraden (giro-rad, inkl. '>' — får ALDRIG escapas)
 *   • bankgiro
 *   • betalbar total ("Att betala")
 *   • förfallodatum
 *   • betalningsmottagare (org-namn, RÅTT — byte-för-byte)
 * Samt att avin går genom shellen (header, ingen footer pga giro-slipen) och att
 * fri text (hyresgästnamn m.m.) escapas — men ALDRIG betalningsfälten.
 */

// storage.service (AWS SDK, ESM) + pdf.service (Puppeteer) dras in vid import.
// Samma mock-mönster som övriga avisering-specar (servicen importerar dem redan).
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'

// Bygger en avi med kända, kontrollerade värden så att den exakta OCR-raden kan
// förutsägas och jämföras byte-för-byte.
function buildNotice(overrides: Record<string, unknown> = {}) {
  return {
    type: 'RENT',
    isProrated: false,
    ocrNumber: '1234567890',
    noticeNumber: 'AVI-2026-0001',
    dueDate: new Date('2026-07-01T00:00:00Z'),
    year: 2026,
    month: 7,
    amount: 10000,
    totalAmount: 10000,
    vatAmount: 0,
    consumptionAmount: 0,
    reminderFeeAmount: 0,
    totalDays: null,
    daysCharged: null,
    periodStart: null,
    periodEnd: null,
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Anna',
      lastName: '& Co <x>',
      companyName: null,
      email: 'anna@example.se',
      phone: null,
    },
    lease: {
      monthlyRent: 10000,
      unit: {
        unitNumber: '1101',
        name: 'Lägenhet',
        property: { street: 'Storgatan 1', name: 'Fastigheten' },
      },
    },
    lines: [],
    ...overrides,
  }
}

const ORG = {
  name: 'Värd & Co', // '&' → escapas i headern men RÅTT i betalningsmottagaren
  street: 'Kungsgatan 2',
  postalCode: '111 22',
  city: 'Stockholm',
  email: 'kontakt@vard.se',
  bankgiro: '5050-1055',
  invoiceColor: null, // → DEFAULT_BRAND_COLOR
  brandSecondaryColor: null,
  brandFont: null,
  logoStorageKey: null,
}

function makeService() {
  const noop = {}
  return new AviseringService(
    noop as never, // prisma
    noop as never, // ocr
    noop as never, // mail
    noop as never, // pdf
    noop as never, // storage
    noop as never, // pdfQueue
    noop as never, // accounting
    noop as never, // consumption
    noop as never, // miscCharges
    { ensureDepositForNotice: jest.fn().mockResolvedValue({ created: false }) } as never, // deposits
    {} as never, // rentNoticeEvents
  )
}

async function render(noticeOverrides: Record<string, unknown> = {}): Promise<string> {
  const service = makeService()
  // buildNoticePdfHtml är privat men ren (utöver logo-hämtning, som hoppas över
  // när logoStorageKey är null) — anropas direkt för att inspektera HTML:en.
  return (
    service as unknown as {
      buildNoticePdfHtml: (n: unknown, o: unknown) => Promise<string>
    }
  ).buildNoticePdfHtml(buildNotice(noticeOverrides), ORG)
}

// fmt() i servicen: sv-SE med exakt två decimaler. Replikeras här för att jämföra
// beloppet oberoende av tusentalsavgränsarens exakta tecken (NBSP).
function fmt(n: number): string {
  return n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

describe('AviseringService.buildNoticePdfHtml — brandad shell + betalningsintegritet (PR 3c)', () => {
  it('BETALNINGSBÄRANDE fält är byte-för-byte oförändrade', async () => {
    const html = await render()

    // OCR-nummer (visas i giro-slipen).
    expect(html).toContain('1234567890')

    // OCR-maskinraden EXAKT. Härledd ur den oförändrade formatBankgiroLine-
    // algoritmen: kronor=10000, ören=00, Luhn-kontrollsiffra=9, bg utan bindestreck.
    // Innehåller '>' → bevisar att raden INTE escapas (escaping → '&gt;').
    expect(html).toContain('# 1234567890 # 10000 00 9 > 50501055#41#')
    expect(html).not.toContain('&gt; 50501055')

    // Bankgiro (TILL BANKGIRO) oförändrat.
    expect(html).toContain('5050-1055')

    // Betalbar total ("Att betala") — exakt belopp.
    expect(html).toContain(`${fmt(10000)} kr`)

    // Förfallodatum oförändrat.
    expect(html).toContain('2026-07-01')

    // Betalningsmottagare = org-namnet RÅTT (byte-för-byte) i slipen, trots '&'.
    expect(html).toContain('Värd & Co')
  })

  it('renderas genom shellen (header) UTAN footer (giro-slipen är sidans botten)', async () => {
    const html = await render()
    expect(html).toContain('class="bp-header"')
    expect(html).not.toContain('class="bp-footer"')
    // Dokumenttitel via shellen.
    expect(html).toContain('Hyresavi')
  })

  it('saknad invoiceColor → DEFAULT_BRAND_COLOR (pixel-identiskt med tidigare #1a6b3c)', async () => {
    const html = await render()
    expect(html).toContain(DEFAULT_BRAND_COLOR)
    expect(DEFAULT_BRAND_COLOR).toBe('#1a6b3c')
  })

  it('escapar fri text (hyresgästnamn) men ALDRIG betalningsfält', async () => {
    const html = await render()
    // Hyresgästnamnet escapas (latent XSS-skydd).
    expect(html).toContain('Anna &amp; Co &lt;x&gt;')
    expect(html).not.toContain('<x>')
    // Men org-namnet i betalningsmottagaren är fortfarande rått (se test ovan) —
    // betalningsfält rörs aldrig.
  })

  it('bevarar avins data (objekt, enhet, fastighet)', async () => {
    const html = await render()
    expect(html).toContain('1101')
    expect(html).toContain('Lägenhet')
    expect(html).toContain('Storgatan 1')
  })

  it('depositionsavi får titeln Depositionsavi via shellen', async () => {
    const html = await render({ type: 'DEPOSIT' })
    expect(html).toContain('Depositionsavi')
  })

  // ── T1.4 PR2 — efterdebiterings-text (JB 12:21, hyresjurist MÅSTE) ──────────
  it('backfill-avi (hel månad): visar efterfakturerad-text för perioden ÄVEN när isProrated=false', async () => {
    const html = await render({
      isBackfill: true,
      isProrated: false,
      periodStart: new Date('2026-02-10T00:00:00Z'),
      periodEnd: new Date('2026-02-20T00:00:00Z'),
    })
    expect(html).toContain('Efterfakturerad hyra för perioden')
    expect(html).toContain('februari 2026')
    expect(html).toContain('sen registrering')
  })

  it('backfill-avi (delmånad): efterfakturerad-text visas även i delmånads-grenen', async () => {
    const html = await render({
      isBackfill: true,
      isProrated: true,
      totalDays: 28,
      daysCharged: 11,
      periodStart: new Date('2026-02-10T00:00:00Z'),
      periodEnd: new Date('2026-02-20T00:00:00Z'),
    })
    expect(html).toContain('Efterfakturerad hyra för perioden')
    expect(html).toContain('sen registrering')
  })

  it('vanlig (icke-backfill) avi visar INTE efterfakturerad-text', async () => {
    const html = await render()
    expect(html).not.toContain('Efterfakturerad hyra')
  })
})
