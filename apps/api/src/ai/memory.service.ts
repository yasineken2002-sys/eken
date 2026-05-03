import { Injectable, Logger } from '@nestjs/common'
import Anthropic from '@anthropic-ai/sdk'
import { PrismaService } from '../common/prisma/prisma.service'
import { AiUsageService } from './usage/ai-usage.service'

const MEMORY_MODEL = 'claude-haiku-4-5-20251001'

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

    const lines = memories.map((m) => `- ${m.key}: ${m.value}`).join('\n')
    return `INLÄRDA PREFERENSER FÖR DENNA ANVÄNDARE:\n${lines}\n\nAnvänd dessa preferenser som standard när användaren inte specificerar något annat.`
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
          content: `Analysera detta samtal och extrahera vanor och preferenser.
Svara ENDAST med JSON array eller [].
Format: [{"key": "nyckel", "value": "värde"}]

Extrahera BARA fakta som är tydligt upprepade eller explicita.
Exempelnycklar: betalningsvillkor, vanlig_hyra, faktura_dag

Specifika mönster att leta efter:
1. Återkommande belopp per hyresgäst → key: "vanlig_hyra_{tenantId}", value: beloppet
2. Föredragna betalningsvillkor → key: "betalningsvillkor", value: antal dagar (t.ex. "30")
3. Smeknamn på hyresgäster → key: "smeknamn_{smeknamn}", value: "tenantId:{id}"
4. Vanliga fakturabeskrivningar → key: "vanlig_beskrivning", value: beskrivningstexten
5. Föredragen faktureringsdag → key: "faktura_dag", value: dag i månaden (t.ex. "1")

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

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '[]'

    let facts: Array<{ key: string; value: string }> = []
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) {
        facts = parsed.filter(
          (item): item is { key: string; value: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>)['key'] === 'string' &&
            typeof (item as Record<string, unknown>)['value'] === 'string',
        )
      }
    } catch {
      this.logger.warn('Failed to parse memory extraction response:', text)
      return
    }

    for (const fact of facts) {
      await this.prisma.aiMemory.upsert({
        where: { organizationId_userId_key: { organizationId, userId, key: fact.key } },
        update: { value: fact.value },
        create: { organizationId, userId, key: fact.key, value: fact.value },
      })
    }
  }

  async clearMemories(organizationId: string, userId: string): Promise<void> {
    await this.prisma.aiMemory.deleteMany({ where: { organizationId, userId } })
  }
}
