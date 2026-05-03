import { Injectable, Logger } from '@nestjs/common'
import Anthropic from '@anthropic-ai/sdk'
import { AiMemoryType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AiUsageService } from './usage/ai-usage.service'
import { AI_MODELS } from './ai.config'

const MEMORY_MODEL = AI_MODELS.MEMORY

const VALID_TYPES = new Set<AiMemoryType>([
  AiMemoryType.preference,
  AiMemoryType.fact,
  AiMemoryType.relationship,
  AiMemoryType.convention,
])

const TYPE_LABELS: Record<AiMemoryType, string> = {
  preference: 'Användarens preferenser',
  fact: 'Fakta om verksamheten',
  relationship: 'Relationer',
  convention: 'Konventioner',
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name)
  private readonly anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })

  constructor(
    private prisma: PrismaService,
    private readonly usage: AiUsageService,
  ) {}

  async getMemories(organizationId: string, userId: string): Promise<string> {
    const memories = await this.prisma.aiMemory.findMany({
      where: { organizationId, userId },
      orderBy: { updatedAt: 'desc' },
    })

    if (memories.length === 0) return ''

    const grouped: Record<AiMemoryType, string[]> = {
      preference: [],
      fact: [],
      relationship: [],
      convention: [],
    }
    for (const m of memories) {
      grouped[m.type].push(`- ${m.key}: ${m.value}`)
    }

    const sections: string[] = []
    for (const type of Object.keys(grouped) as AiMemoryType[]) {
      const lines = grouped[type]
      if (lines.length === 0) continue
      sections.push(`${TYPE_LABELS[type]}:\n${lines.join('\n')}`)
    }

    if (sections.length === 0) return ''

    return `INLÄRDA MINNEN FÖR DENNA ANVÄNDARE:\n${sections.join('\n\n')}\n\nAnvänd dessa som standard när användaren inte specificerar något annat.`
  }

  async extractAndSaveMemories(
    message: string,
    reply: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const response = await this.anthropic.messages.create({
      model: MEMORY_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Analysera detta samtal och extrahera vanor, preferenser, fakta, relationer och konventioner.
Svara ENDAST med giltig JSON i formatet:
{"memories": [{"key": "...", "value": "...", "type": "preference|fact|relationship|convention"}]}

Returnera {"memories": []} om inget värdefullt finns att spara.

Klassificera varje minne i en av fyra typer:
- preference: användarens preferenser för hur saker ska göras
  (t.ex. "föredrar att se hyror i tusental", "vill alltid bekräfta innan utskick")
- fact: fakta om verksamheten eller fastigheterna
  (t.ex. "fastighet Vasagatan 12 har gammalt VVS-system",
   "vanlig hyra för hyresgäst Erik = 8500 kr",
   "betalningsvillkor = 30 dagar")
- relationship: relationer mellan entiteter eller personer
  (t.ex. "tenantId X är vän till ägaren",
   "kontaktperson för fastighet Y är driftansvarig Z")
- convention: konventioner och rutiner i verksamheten
  (t.ex. "vi rundar alltid upp till närmaste 100-tal",
   "fakturadag = 1:a varje månad",
   "vi skickar alltid välkomstbrev vid nya kontrakt")

Extrahera BARA tydligt upprepade eller explicita fakta.
Hitta inte på saker — om du är osäker, hoppa över.

Samtal:
Användare: ${message}
AI: ${reply}`,
        },
      ],
    })

    void this.usage
      .logUsage({
        organizationId,
        userId,
        endpoint: 'memory',
        model: MEMORY_MODEL,
        usage: response.usage,
      })
      .catch((err: unknown) => this.logger.warn('logUsage(memory) failed', err))

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '{}'
    const cleaned = text
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim()

    let facts: Array<{ key: string; value: string; type: AiMemoryType }> = []
    try {
      const parsed: unknown = JSON.parse(cleaned)
      const memories =
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>)['memories'])
          ? ((parsed as Record<string, unknown>)['memories'] as unknown[])
          : Array.isArray(parsed)
            ? parsed
            : []

      facts = memories.flatMap(
        (item): Array<{ key: string; value: string; type: AiMemoryType }> => {
          if (typeof item !== 'object' || item === null) return []
          const obj = item as Record<string, unknown>
          const key = obj['key']
          const value = obj['value']
          const type = obj['type']
          if (typeof key !== 'string' || typeof value !== 'string') return []
          const normalizedType =
            typeof type === 'string' && VALID_TYPES.has(type as AiMemoryType)
              ? (type as AiMemoryType)
              : AiMemoryType.fact
          return [{ key, value, type: normalizedType }]
        },
      )
    } catch {
      this.logger.warn('Failed to parse memory extraction response:', cleaned)
      return
    }

    for (const fact of facts) {
      await this.prisma.aiMemory.upsert({
        where: { organizationId_userId_key: { organizationId, userId, key: fact.key } },
        update: { value: fact.value, type: fact.type },
        create: {
          organizationId,
          userId,
          key: fact.key,
          value: fact.value,
          type: fact.type,
        },
      })
    }
  }

  async clearMemories(organizationId: string, userId: string): Promise<void> {
    await this.prisma.aiMemory.deleteMany({ where: { organizationId, userId } })
  }
}
