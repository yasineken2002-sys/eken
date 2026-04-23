import { Injectable, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface ScannedContract {
  tenantName: string | null
  tenantType: 'INDIVIDUAL' | 'COMPANY' | null
  tenantEmail: string | null
  tenantPhone: string | null
  personalNumber: string | null
  companyName: string | null
  orgNumber: string | null
  propertyAddress: string | null
  unitDescription: string | null
  monthlyRent: number | null
  depositAmount: number | null
  startDate: string | null
  endDate: string | null
  noticePeriodMonths: number | null
  confidence: number
  rawText: string
}

@Injectable()
export class ContractScannerService {
  constructor(private readonly config: ConfigService) {}

  async scanContract(fileBuffer: Buffer, mimeType: string): Promise<ScannedContract> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY')
    if (!apiKey) {
      throw new BadRequestException('AI-scanning är inte konfigurerat. Kontakta administratören.')
    }

    const base64 = fileBuffer.toString('base64')

    const contentBlock =
      mimeType === 'application/pdf'
        ? {
            type: 'document' as const,
            source: {
              type: 'base64' as const,
              media_type: mimeType,
              data: base64,
            },
          }
        : {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp',
              data: base64,
            },
          }

    const prompt = `Du är ett system som extraherar information från svenska hyreskontrakt.

Analysera detta hyreskontrakt och extrahera informationen.
Svara ENDAST med ett JSON-objekt, ingen annan text, inga kodblock.

{
  "tenantName": "fullt namn eller null",
  "tenantType": "INDIVIDUAL eller COMPANY",
  "tenantEmail": "e-post eller null",
  "tenantPhone": "telefon eller null",
  "personalNumber": "personnummer YYYYMMDD-XXXX eller null",
  "companyName": "företagsnamn eller null",
  "orgNumber": "org.nummer eller null",
  "propertyAddress": "fastighetens adress eller null",
  "unitDescription": "lägenhetsnummer eller beskrivning eller null",
  "monthlyRent": numerisk månadshyra SEK eller null,
  "depositAmount": numerisk deposition SEK eller null,
  "startDate": "YYYY-MM-DD eller null",
  "endDate": "YYYY-MM-DD eller null om tillsvidare",
  "noticePeriodMonths": numerisk uppsägningstid månader eller null,
  "confidence": tal 0-1,
  "rawText": "första 500 tecknen av kontraktstexten"
}`

    let response: Response
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                contentBlock,
                {
                  type: 'text',
                  text: prompt,
                },
              ],
            },
          ],
        }),
      })
    } catch {
      throw new BadRequestException('Kunde inte ansluta till AI-tjänsten. Försök igen.')
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Okänt fel')
      console.error('Anthropic API error:', response.status, errorBody)
      throw new BadRequestException('Kunde inte läsa kontraktet. Kontrollera att filen är tydlig.')
    }

    let data: {
      content: Array<{ type: string; text: string }>
    }

    try {
      data = (await response.json()) as typeof data
    } catch {
      throw new BadRequestException('Kunde inte tolka AI-svaret. Försök igen.')
    }

    const text = data.content?.[0]?.text ?? ''
    const clean = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim()

    try {
      return JSON.parse(clean) as ScannedContract
    } catch {
      throw new BadRequestException(
        'Kunde inte läsa kontraktet. Kontrollera att filen är tydlig och läsbar.',
      )
    }
  }
}
