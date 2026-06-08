import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { AiUsageService } from '../ai/usage/ai-usage.service'
import { AiQuotaService } from '../ai/usage/ai-quota.service'
import { AI_MODELS } from '../ai/ai.config'

const INSPECTION_MODEL = AI_MODELS.VISION_INSPECTION

// Rimlighetsgränser. AI-vision kan — i kantfall eller vid prompt injection —
// returnera hallucinerade/orimliga belopp. En enskild besiktningspost (golv, vägg,
// vitvara …) över MAX_ITEM_REPAIR_COST_SEK är inte en verklig reparationskostnad.
// Sådana belopp FLAGGAS för manuell granskning och persisteras ALDRIG som ett tyst
// avdragsunderlag mot en hyresgästs deposition.
const MAX_ITEM_REPAIR_COST_SEK = 1_000_000

export type AnalysisCondition = 'GOOD' | 'ACCEPTABLE' | 'DAMAGED' | 'MISSING'
const VALID_CONDITIONS: readonly AnalysisCondition[] = ['GOOD', 'ACCEPTABLE', 'DAMAGED', 'MISSING']

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

// Strukturschema. safeParse misslyckas BARA om svaret inte ens är ett objekt med en
// items-array — då kasserar vi hela analysen (konservativt: besiktningen får hanteras
// manuellt och blir aldrig tyst ett avdragsunderlag). Fältens innehåll normaliseras
// sedan defensivt i validateAndNormalize (fel typ → null/fallback), samma filosofi som
// ContractScannerService.validate / PdfStatementParserService.validate.
const RawItemSchema = z.object({
  room: z.unknown(),
  item: z.unknown(),
  condition: z.unknown(),
  notes: z.unknown(),
  repairCost: z.unknown(),
})
const RawAnalysisSchema = z.object({
  overallCondition: z.unknown(),
  notes: z.unknown(),
  urgentIssues: z.unknown(),
  estimatedTotalCost: z.unknown(),
  items: z.array(RawItemSchema),
})

@Injectable()
export class InspectionAnalyzerService {
  private readonly logger = new Logger(InspectionAnalyzerService.name)
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
    // Bildbesiktnings-AI ingår i baspriset — utlöses av admin men räknas
    // inte mot manuella chat-anropstaket. Ingen tak-kontroll.
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
          isAutomated: true,
          source: 'inspection_analyze',
        })
        .catch(() => undefined)

      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
      if (!textBlock) throw new Error('Inget textsvar från AI')

      const clean = textBlock.text.replace(/```json|```/g, '').trim()
      let parsed: unknown
      try {
        parsed = JSON.parse(clean)
      } catch {
        // Ogiltig JSON → kassera (gissa aldrig ett belopp ur trasig output).
        throw new BadRequestException(
          'AI-svaret kunde inte tolkas. Kör om analysen eller registrera besiktningen manuellt.',
        )
      }
      return this.validateAndNormalize(parsed)
    } catch (err) {
      // BadRequestException (ogiltig output/format) propageras oförändrad — den är ett
      // medvetet konservativt avslag, inte ett tekniskt fel. Övriga fel (SDK/nätverk)
      // mappas till ett generiskt bildfel.
      if (err instanceof BadRequestException) throw err
      throw new BadRequestException(
        'Kunde inte analysera bilderna. Kontrollera att bilderna är tydliga.',
      )
    }
  }

  // ── Output-validering (skyddar en hyresgästs pengar mot hallucinerade belopp) ──
  // AI-vision-output rör i förlängningen depositionsavdrag. Vi validerar därför
  // strukturen (kassera om den inte ens är ett objekt med items-array) och
  // RIMLIGHETSGRANSKAR varje belopp innan det får persisteras:
  //   • fel typ / icke-finit  → null
  //   • negativt              → null + flagga (aldrig ett negativt "avdrag")
  //   • över rimlighetstaket  → null + flagga för manuell granskning (tyst aldrig)
  //   • kostnad på GOOD/ACCEPTABLE → null (inkonsekvent — inget avdrag utan skada)
  // Konsekvensen: en hallucinerad reparationskostnad blir ALDRIG tyst ett belopp i
  // besiktningen; den nollställs och en svensk varningstext skrivs i postens notes så
  // att operatören granskar manuellt innan ett depositionsavdrag beslutas.
  private validateAndNormalize(input: unknown): AnalysisResult {
    const parsed = RawAnalysisSchema.safeParse(input)
    if (!parsed.success) {
      this.logger.warn('Inspektions-AI returnerade ogiltigt format — analysen kasseras')
      throw new BadRequestException(
        'AI-analysen hade ett ogiltigt format och kasserades. Registrera besiktningen ' +
          'manuellt så att inget felaktigt underlag skapas.',
      )
    }
    const raw = parsed.data

    const items: AnalysisItem[] = raw.items.map((it) => {
      const room = this.normalizeString(it.room, 100) ?? 'Övrigt'
      const item = this.normalizeString(it.item, 100) ?? 'Okänt'
      const conditionValid = VALID_CONDITIONS.includes(it.condition as AnalysisCondition)
      const condition: AnalysisCondition = conditionValid
        ? (it.condition as AnalysisCondition)
        : 'GOOD'
      let notes = this.normalizeString(it.notes, 1000)

      // Okänt/ogiltigt skick faller tillbaka till GOOD (konservativt: inget avdrag),
      // men flaggas — en hallucinerad skick-etikett får aldrig TYST dölja en skada.
      if (!conditionValid && it.condition != null && String(it.condition).trim() !== '') {
        const flag =
          `⚠ AI angav ett okänt skick ("${String(it.condition).slice(0, 40)}") — ` +
          'satt till GOOD, kräver manuell granskning.'
        notes = notes ? `${notes} ${flag}` : flag
      }

      let repairCost: number | null = null
      const rawCost = this.normalizeNumber(it.repairCost)
      if (rawCost !== null && (rawCost < 0 || rawCost > MAX_ITEM_REPAIR_COST_SEK)) {
        // Orimligt/negativt belopp: flagga, persistera ALDRIG som siffra.
        const flag =
          `⚠ AI angav en orimlig reparationskostnad (${Math.round(rawCost)} kr) — ` +
          'kräver manuell granskning innan ett depositionsavdrag beslutas.'
        notes = notes ? `${notes} ${flag}` : flag
      } else if (rawCost !== null) {
        repairCost = Math.round(rawCost)
      }
      // En kostnad på en post utan skada (GOOD/ACCEPTABLE) är inkonsekvent → inget avdrag.
      if ((condition === 'GOOD' || condition === 'ACCEPTABLE') && repairCost !== null) {
        repairCost = null
      }

      return { room, item, condition, notes, repairCost }
    })

    // Totalsumman härleds från de VALIDERADE post-beloppen — ALDRIG från AI:ns råa
    // totalsiffra. Annars kunde protokollet visa ett hallucinerat totalbelopp även när
    // varje enskild post nollställts av rimlighetsgrinden.
    const estimatedTotalCost = items.reduce((sum, it) => sum + (it.repairCost ?? 0), 0)

    return {
      overallCondition: this.normalizeString(raw.overallCondition, 500) ?? '',
      notes: this.normalizeString(raw.notes, 2000) ?? '',
      urgentIssues: Array.isArray(raw.urgentIssues)
        ? raw.urgentIssues
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.slice(0, 300))
        : [],
      estimatedTotalCost,
      items,
    }
  }

  private normalizeString(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null
    const t = v.trim()
    return t.length > 0 ? t.slice(0, max) : null
  }

  private normalizeNumber(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'string') {
      // Tolka "12 000", "12000 kr", "12000,50" defensivt; kräv minst en siffra
      // (annars blir en ren skräpsträng felaktigt 0, Number('') === 0).
      const cleaned = v
        .replace(/\s|kr|sek/gi, '')
        .replace(',', '.')
        .replace(/[^0-9.-]/g, '')
      if (!/\d/.test(cleaned)) return null
      const n = Number(cleaned)
      return Number.isFinite(n) ? n : null
    }
    return null
  }
}
