import { Injectable, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Anthropic from '@anthropic-ai/sdk'
import { AiUsageService } from '../ai/usage/ai-usage.service'
import { AiQuotaService } from '../ai/usage/ai-quota.service'

const INSPECTION_MODEL = 'claude-sonnet-4-5'

export type AnalysisCondition = 'GOOD' | 'ACCEPTABLE' | 'DAMAGED' | 'MISSING'

export interface AnalysisItem {
  room: string
  item: string
  condition: AnalysisCondition
  notes: string | null
  repairCost: number | null
}

export interface AnalysisResult {
  overallCondition: string
  notes: string
  urgentIssues: string[]
  estimatedTotalCost: number
  items: AnalysisItem[]
}

export interface ImageInput {
  buffer: Buffer
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  caption?: string
}

const ANALYSIS_PROMPT = `Du är expert på bostadsbesiktningar i Sverige. Analysera bilderna noggrant och returnera ENBART ett JSON-objekt utan kodblock eller annan text:
{
  "overallCondition": "Sammanfattande helhetsskick på svenska (1-2 meningar)",
  "notes": "Övriga noteringar eller observationer",
  "urgentIssues": ["Brådskande problem som kräver omedelbar åtgärd"],
  "estimatedTotalCost": 0,
  "items": [
    {
      "room": "rumsnamn på svenska",
      "item": "föremål som besiktigas",
      "condition": "GOOD",
      "notes": null,
      "repairCost": null
    }
  ]
}

Använd svenska rum: Hall, Kök, Badrum, Vardagsrum, Sovrum, Balkong, Förråd, Övrigt.
Vanliga föremål: Golv, Väggar, Tak, Fönster, Dörrar, Vitvaror, Köksluckor, Bänkskiva, Lister, Eluttag, Lampor, Handfat, Toalett, Dusch/Badkar.
Condition-värden: GOOD (bra skick), ACCEPTABLE (godkänt), DAMAGED (skadat – ange skada i notes), MISSING (saknas).
Uppskatta reparationskostnader i SEK baserat på svenska priser 2024-2026. Sätt repairCost till null om skick är GOOD eller ACCEPTABLE.
Om en bild är oklar, ange GOOD med notes "Bild oklar – manuell kontroll rekommenderas".`

@Injectable()
export class InspectionAnalyzerService {
  private readonly client: Anthropic

  constructor(
    private readonly configService: ConfigService,
    private readonly usage: AiUsageService,
    private readonly quota: AiQuotaService,
  ) {
    this.client = new Anthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY', ''),
    })
  }

  async analyzeImages(
    images: ImageInput[],
    organizationId: string,
    userId?: string,
  ): Promise<AnalysisResult> {
    await this.quota.checkQuota(organizationId)
    const content: Anthropic.MessageParam['content'] = []

    for (let i = 0; i < images.length; i++) {
      const img = images[i]!
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType,
          data: img.buffer.toString('base64'),
        },
      })
      content.push({
        type: 'text',
        text: img.caption ? `Bild ${i + 1}: ${img.caption}` : `Bild ${i + 1}`,
      })
    }

    content.push({ type: 'text', text: ANALYSIS_PROMPT })

    try {
      const response = await this.client.messages.create({
        model: INSPECTION_MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content }],
      })

      void this.usage
        .logUsage({
          organizationId,
          userId: userId ?? null,
          endpoint: 'inspection-analyze',
          model: INSPECTION_MODEL,
          usage: response.usage,
        })
        .catch(() => undefined)

      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
      if (!textBlock) throw new Error('Inget textsvar från AI')

      const clean = textBlock.text.replace(/```json|```/g, '').trim()
      return JSON.parse(clean) as AnalysisResult
    } catch {
      throw new BadRequestException(
        'Kunde inte analysera bilderna. Kontrollera att bilderna är tydliga.',
      )
    }
  }
}
