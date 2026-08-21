/**
 * MODELLEN SKA FÅ TEXTEN OMASKERAD (#507).
 *
 * Principen är trepartad, och den här specen bevakar den mittersta:
 *
 *   Lagrad rad orörd.  MODELLEN FÅR DEN ORÖRD.  Människan får den maskerad.
 *
 * Maskerar man historiken på väg IN i modellen är det inte en loggåtgärd utan en
 * ändring av assistentens arbetsminne: den tappar vad som just sagts, och svarar
 * sämre på nästa fråga. Det var precis därför förslag 3a i #494 avslogs.
 *
 * Utan den här specen är det lätt att "förbättra" #507 genom att maskera på fler
 * ställen — och den försämringen skulle vara tyst, eftersom ingenting kraschar.
 *
 * INGA VERKLIGA PERSONUPPGIFTER: personnumret är daterat 30 februari, som inte
 * finns, och domänen är reserverad för test.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AiAssistantService } from './ai-assistant.service'

const PNR = '19000230-0000'
const EPOST = 'ingen.person@example.invalid'

describe('modellen får historiken OMASKERAD', () => {
  it('getOrCreateConversation returnerar meddelandena i klartext', async () => {
    const lagrat = {
      id: 'conv-1',
      messages: [
        { role: 'user', content: `Kolla ${PNR}` },
        { role: 'assistant', content: `Skickat till ${EPOST}` },
      ],
    }
    const svc = Object.create(AiAssistantService.prototype) as AiAssistantService
    Object.defineProperty(svc, 'prisma', {
      value: { aiConversation: { findFirst: async () => lagrat } },
    })

    const priv = svc as unknown as {
      getOrCreateConversation: (
        o: string,
        u: string,
        m: string,
        c?: string,
      ) => Promise<typeof lagrat>
    }
    const conv = await priv.getOrCreateConversation('org-1', 'user-1', 'ny fråga', 'conv-1')

    // DET HÄR ÄR POÄNGEN: ingen maskering på vägen till modellen.
    expect(conv.messages[0]!.content).toContain(PNR)
    expect(conv.messages[1]!.content).toContain(EPOST)
    expect(JSON.stringify(conv)).not.toContain('***MASKERAT***')
  })

  it('den strömmande chattvägen maskerar inte heller', () => {
    // Kontrollern läser historiken direkt för att bygga modellens kontext.
    // Källkoden är beviset: skulle någon lägga maskeringen där blir den här röd.
    const källa = readFileSync(join(__dirname, 'ai-assistant.controller.ts'), 'utf8')
    expect(källa).toContain('aiConversation.findFirst')
    expect(källa).not.toContain('maskAiContentForDisplay')
  })

  it('och kvitteringsfilen säger varför den vägen är undantagen', () => {
    const ack = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'scripts', 'ai-display-masking.ack.json'), 'utf8'),
    ) as { files: Record<string, { reason: string }> }
    const post = ack.files['ai/ai-assistant.controller.ts']
    expect(post).toBeDefined()
    expect(post!.reason).toMatch(/MODELLEN/)
  })
})
