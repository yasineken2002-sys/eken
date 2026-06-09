/**
 * Steg 3, PR 3b — besiktningsprotokollet renderas genom den gemensamma brandade
 * PDF-shellen (buildBrandedPdfHtml). Låser att:
 *   • protokollet går genom shellen (shell-header/-footer + dokumenttitel)
 *   • orgens primärfärg (invoiceColor) styr rubrikerna i stället för förr
 *     hårdkodade #2563EB
 *   • orgens typsnitt (brandFont) vävs in av shellen
 *   • DYNAMISKT innehåll HTML-escapas (rum/föremål/anteckning/övergripande +
 *     org-namn) — ingen rå injektion i PDF-HTML:en
 *   • SEMANTISKA status-/summafärger (rött för skadat) bevaras (penganeutralt,
 *     inte varumärke)
 *   • protokollets DATA (rum, föremål, kostnad) är oförändrad
 */

// storage.service (AWS SDK, ESM) + pdf.service (Puppeteer) dras in transitivt
// via common/branding resp. konstruktorn. Stubbas — samma mönster som övriga
// specar som transitivt rör dessa. (Steg 3, PR 3b.)
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { InspectionsService } from './inspections.service'

function buildService() {
  const inspection = {
    id: 'insp-1',
    organizationId: 'org-1',
    type: 'MOVE_OUT',
    scheduledDate: new Date('2026-05-01T00:00:00Z'),
    property: { name: 'Storgatan 1' },
    unit: { name: 'Lägenhet 1101' },
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Anna',
      lastName: 'Andersson',
      companyName: null,
    },
    overallCondition: 'Gott skick & välstädat',
    items: [
      {
        room: 'Kök',
        item: '<script>alert(1)</script>',
        condition: 'DAMAGED',
        notes: 'Repor & märken',
        repairCost: 5000,
      },
    ],
  }

  const org = {
    id: 'org-1',
    name: 'Värd & Co AB',
    orgNumber: '556000-0001',
    vatNumber: 'SE556000000101',
    email: 'kontakt@vard.se',
    phone: '08-123456',
    street: 'Kungsgatan 2',
    postalCode: '111 22',
    city: 'Stockholm',
    bankgiro: '123-4567',
    logoStorageKey: null,
    invoiceColor: '#123456',
    brandSecondaryColor: null,
    brandFont: 'INTER',
  }

  const prisma = {
    inspection: { findFirst: jest.fn().mockResolvedValue(inspection) },
    organization: { findUnique: jest.fn().mockResolvedValue(org) },
  }

  const generateFromHtml = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4'))
  const pdfService = { generateFromHtml }
  const storage = {}

  const service = new InspectionsService(prisma as never, pdfService as never, storage as never)
  return { service, generateFromHtml }
}

describe('InspectionsService.generateProtocolPdf — brandad PDF-shell (Steg 3, PR 3b)', () => {
  async function renderHtml(): Promise<string> {
    const { service, generateFromHtml } = buildService()
    const buffer = await service.generateProtocolPdf('insp-1', 'org-1')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(generateFromHtml).toHaveBeenCalledTimes(1)
    return generateFromHtml.mock.calls[0]![0] as string
  }

  it('renderar genom shellen med dokumenttitel och brandad header/footer', async () => {
    const html = await renderHtml()
    expect(html).toContain('class="bp-header"')
    expect(html).toContain('class="bp-footer"')
    expect(html).toContain('Besiktningsprotokoll')
    // Utflyttningsbesiktning som undertitel (innehållets typ-rad bevarad).
    expect(html).toContain('Utflyttningsbesiktning')
  })

  it('använder orgens primärfärg för rubriker, inte längre hårdkodad #2563EB', async () => {
    const html = await renderHtml()
    expect(html).toContain('#123456')
    expect(html).not.toContain('#2563EB')
  })

  it('väver in orgens typsnitt (brandFont INTER → Inter-stack)', async () => {
    const html = await renderHtml()
    expect(html).toContain('Inter')
  })

  it('HTML-escapar dynamiskt innehåll (föremål/anteckning/övergripande/org-namn)', async () => {
    const html = await renderHtml()
    // Föremålsnamnet får inte injiceras rått.
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // &-tecken i fritext och org-namn escapas.
    expect(html).toContain('Repor &amp; märken')
    expect(html).toContain('Gott skick &amp; välstädat')
    expect(html).toContain('Värd &amp; Co AB')
  })

  it('bevarar semantiska status-/summafärger (rött för skadat) och protokolldata', async () => {
    const html = await renderHtml()
    // 1 skadat föremål → röd summafärg bevaras (semantik, ej varumärke).
    expect(html).toContain('#DC2626')
    // Protokollets data oförändrad.
    expect(html).toContain('Kök')
    expect(html).toContain('Lägenhet 1101')
    expect(html).toContain('Storgatan 1')
    expect(html).toContain('Anna Andersson')
  })
})
