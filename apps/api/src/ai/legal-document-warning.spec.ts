/**
 * Varnings-mekanismen för send_document_to_tenant (INFORMERA & VARNA, blockera
 * aldrig). Verifierar:
 *   • detectLegalDocumentWarning klassar rättsverkande-liknande innehåll och
 *     returnerar en klartext-varning — utan paragraf-/SFS-nummer.
 *   • rent informativa dokument ger ingen varning.
 *   • buildConfirmation lägger varningen i bekräftelserutan (men blockerar
 *     inget — confirm-grinden är oförändrad).
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AiAssistantService } from './ai-assistant.service'
import { detectLegalDocumentWarning } from './legal-document-warning'

describe('detectLegalDocumentWarning', () => {
  it('flaggar uppsägning', () => {
    const w = detectLegalDocumentWarning('Uppsägning av hyresavtal', 'Härmed sägs avtalet upp.')
    expect(w?.label).toBe('uppsägning')
    expect(w?.warning).toContain('INTE en juridiskt giltig uppsägning')
  })

  it('flaggar hyreshöjning', () => {
    const w = detectLegalDocumentWarning(
      'Meddelande',
      'Vi planerar en hyreshöjning från årsskiftet.',
    )
    expect(w?.label).toBe('hyreshöjning')
  })

  it('flaggar rättelseanmaning/tillsägelse', () => {
    expect(detectLegalDocumentWarning('Tillsägelse', 'Du måste åtgärda störningen.')?.label).toBe(
      'rättelseanmaning',
    )
  })

  it('flaggar förverkande/avhysning', () => {
    expect(detectLegalDocumentWarning('Information', 'Vi överväger avhysning.')?.label).toBe(
      'förverkande/avhysning',
    )
  })

  it('ger INGEN varning för rent informativa dokument', () => {
    expect(
      detectLegalDocumentWarning('Information om sophämtning', 'Sophämtning sker på tisdagar.'),
    ).toBeNull()
    expect(
      detectLegalDocumentWarning('Välkomstbrev', 'Varmt välkommen till din nya lägenhet!'),
    ).toBeNull()
  })

  it('citerar ALDRIG paragraf-/SFS-nummer i varningstexten (projektregel)', () => {
    const w = detectLegalDocumentWarning('Uppsägning', 'sägs upp')
    expect(w).not.toBeNull()
    expect(w!.warning).not.toMatch(/\b\d{1,2}\s*(kap|§)/i) // inga "12 kap", "§"
    expect(w!.warning).not.toMatch(/\d{4}:\d+/) // inga SFS-nummer (ÅÅÅÅ:NN)
    expect(w!.warning).toContain('hyreslagens formkrav')
  })
})

function makeService() {
  const configService = { get: jest.fn().mockReturnValue('') }
  return new AiAssistantService(
    {} as never,
    configService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // legalRetrieval — nås aldrig (inga juridiska frågor i denna spec)
  )
}

describe('buildConfirmation — send_document_to_tenant', () => {
  it('rättsverkande-liknande innehåll → varning visas i bekräftelserutan', () => {
    const service = makeService()
    const conf = service.buildConfirmation('send_document_to_tenant', {
      tenantName: 'Tim Johansson',
      title: 'Uppsägning av hyresavtal',
      content: 'Härmed sägs ditt hyresavtal upp.',
    })
    expect(conf.confirmationMessage).toContain('INTE en juridiskt giltig')
    expect(conf.details.Juridisk).toContain('portalleverans räcker inte')
  })

  it('informativt dokument → ingen varning (men bekräftelseruta finns kvar)', () => {
    const service = makeService()
    const conf = service.buildConfirmation('send_document_to_tenant', {
      tenantName: 'Tim Johansson',
      title: 'Information om sophämtning',
      content: 'Sophämtning sker på tisdagar.',
    })
    expect(conf.confirmationMessage).not.toContain('INTE en juridiskt giltig')
    expect(conf.details.Juridisk).toBeUndefined()
    expect(conf.confirmationMessage).toContain('hyresgästportal')
  })
})
