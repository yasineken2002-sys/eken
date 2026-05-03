import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Anthropic from '@anthropic-ai/sdk'
import { PrismaService } from '../common/prisma/prisma.service'
import { AiUsageService } from './usage/ai-usage.service'
import { TenantToolExecutorService } from './tools/tenant-tool-executor.service'
import { TENANT_TOOLS, TENANT_ACTION_TOOLS } from './tools/tenant-ai-tools.definition'
import { AI_MODELS } from './ai.config'

const TENANT_MODEL = AI_MODELS.CHAT
const TENANT_MAX_TOKENS = 1024
const TENANT_MAX_TOOL_ITERATIONS = 3

// Per-tenant kostnadsskydd. Översätter från spec:
// - 50 anrop/dag per hyresgäst
// - 50 SEK/månad per hyresgäst
const TENANT_DAILY_CALL_LIMIT = 50
const TENANT_MONTHLY_COST_SEK = 50

const TENANT_SYSTEM_PROMPT = `Du är hyresgästens hjälpsamma digitala assistent från Eveno.

Du kan svara på frågor om kontrakt, hyra, betalningar och fastigheten där hyresgästen bor.
Du kan hjälpa hyresgästen skapa felanmälan eller begära uppsägning av hyresavtalet.

VID KOMPLEXA FRÅGOR: Hänvisa till fastighetsägaren direkt vid juridiska konflikter,
oklar betalning, eller frågor som kräver beslut från hyresvärden.

ALDRIG:
- Lova något på fastighetsägarens vägnar
- Föreslå hyresjusteringar
- Avtala om nya kontrakt
- Acceptera uppsägningar (du kan bara förmedla en BEGÄRAN)
- Ge råd som strider mot Hyreslagen 12 kap. Jordabalken

ALLTID:
- Svara på svenska, vänligt och pedagogiskt
- Använd verktyg för att hämta hyresgästens egen data innan du svarar
- Förklara hyresregler enkelt — referera till Hyreslagen när relevant
- Avsluta med ett konkret nästa steg om det är hjälpsamt

OM HYRESGÄSTENS DATA:
- get_my_lease — kontrakt, hyra, uppsägningstid, indexklausul
- get_my_invoices — fakturor och avier (filtrera på status)
- get_my_payment_history — vilka fakturor som är betalda
- get_my_documents — kontrakt och kvitton
- get_my_property_info — fastighet och hyresvärdens kontakt
- get_my_maintenance_tickets — egna felanmälningar

ÅTGÄRDER (kräver bekräftelse i UI):
- create_maintenance_ticket — skapa felanmälan med titel, beskrivning, kategori
- request_termination — begär uppsägning (preliminärt — hyresvärden måste godkänna)

UPPSÄGNINGSREGLER (Hyreslagen 12 kap. JB):
- Hyresgäst får säga upp tillsvidareavtal med 3 månaders varsel
- Tidsbegränsade avtal löper till slutdatum men kan förlängas
- Uppsägningen ska vara skriftlig — request_termination räknas som skriftlig
- Återkom alltid till att hyresvärden måste bekräfta begäran

FELANMÄLNINGAR:
- URGENT (Akut) endast vid vatten, brand, el, värmebortfall — inte små fel
- HIGH (Hög) för icke-akuta men viktiga problem (t.ex. ej fungerande vitvara)
- NORMAL för vanliga problem
- LOW för kosmetiska frågor

PRONOMEN OCH REFERENSER:
- "min hyra" / "vad jag betalar" → get_my_lease
- "min faktura" / "min senaste avi" → get_my_invoices
- "vad har jag betalat" / "förra året" → get_my_payment_history
- "mitt kontrakt" → get_my_documents eller get_my_lease
- "min hyresvärd" / "vem äger huset" → get_my_property_info`

export interface TenantPendingAction {
  toolName: string
  toolInput: Record<string, unknown>
  confirmationMessage: string
  details: Record<string, string>
}

export interface TenantChatResponse {
  reply: string
  conversationId: string
  pendingAction?: TenantPendingAction
}

@Injectable()
export class TenantAiService {
  private readonly logger = new Logger(TenantAiService.name)
  private readonly client: Anthropic

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly toolExecutor: TenantToolExecutorService,
    private readonly usage: AiUsageService,
  ) {
    this.client = new Anthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY', ''),
    })
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async chat(
    tenantId: string,
    organizationId: string,
    message: string,
    conversationId?: string,
  ): Promise<TenantChatResponse> {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY', '')
    if (!apiKey) {
      throw new BadRequestException(
        'AI-assistenten är inte tillgänglig just nu. Kontakta din hyresvärd direkt.',
      )
    }

    await this.assertTenantQuota(tenantId)

    const conversation = await this.getOrCreateConversation(tenantId, message, conversationId)

    const messages: Anthropic.MessageParam[] = [
      ...conversation.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: message },
    ]

    const tenantContext = await this.buildTenantContext(tenantId)

    let iterations = 0
    let currentMessages = messages
    let response = await this.callClaude(currentMessages, tenantContext, organizationId, tenantId)

    while (response.stop_reason === 'tool_use' && iterations < TENANT_MAX_TOOL_ITERATIONS) {
      const toolBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      if (!toolBlock) break

      const toolName = toolBlock.name
      const toolInput = toolBlock.input as Record<string, unknown>

      // Action — defer execution
      if (TENANT_ACTION_TOOLS.has(toolName)) {
        await this.prisma.aiTenantMessage.create({
          data: { conversationId: conversation.id, role: 'user', content: message },
        })
        await this.prisma.aiTenantConversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        })
        return {
          reply: '',
          conversationId: conversation.id,
          pendingAction: {
            toolName,
            toolInput,
            ...this.buildConfirmation(toolName, toolInput),
          },
        }
      }

      // Read — execute and feed back
      let toolResult: unknown
      try {
        toolResult = await this.toolExecutor.executeTool(
          toolName,
          toolInput,
          tenantId,
          organizationId,
          { conversationId: conversation.id },
        )
      } catch (err) {
        toolResult = {
          success: false,
          message: err instanceof Error ? err.message : 'Något gick fel',
        }
      }

      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content },
        {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: toolBlock.id,
              content: JSON.stringify(toolResult),
            },
          ],
        },
      ]

      response = await this.callClaude(currentMessages, tenantContext, organizationId, tenantId)
      iterations++
    }

    return this.handleTextResponse(response, conversation.id, message)
  }

  async confirmAction(
    toolName: string,
    toolInput: Record<string, unknown>,
    conversationId: string,
    confirmed: boolean,
    tenantId: string,
    organizationId: string,
  ): Promise<TenantChatResponse> {
    const conversation = await this.prisma.aiTenantConversation.findFirst({
      where: { id: conversationId, tenantId },
    })
    if (!conversation) throw new NotFoundException('Konversation hittades inte')

    if (!confirmed) {
      const cancelMsg =
        'Inga problem, jag avbryter åtgärden. Säg till om jag kan hjälpa med något annat.'
      await this.prisma.aiTenantMessage.create({
        data: { conversationId, role: 'assistant', content: cancelMsg },
      })
      await this.prisma.aiTenantConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      })
      return { reply: cancelMsg, conversationId }
    }

    let result: { success: boolean; message: string }
    try {
      result = await this.toolExecutor.executeTool(toolName, toolInput, tenantId, organizationId, {
        conversationId,
        confirmedAt: new Date(),
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Okänt fel'
      const failMsg = `Åtgärden gick inte att slutföra: ${errMsg}`
      await this.prisma.aiTenantMessage.create({
        data: { conversationId, role: 'assistant', content: failMsg },
      })
      return { reply: failMsg, conversationId }
    }

    const reply = result.success ? result.message : `Åtgärden misslyckades: ${result.message}`
    await this.prisma.aiTenantMessage.create({
      data: { conversationId, role: 'assistant', content: reply },
    })
    await this.prisma.aiTenantConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    })
    return { reply, conversationId }
  }

  // ── Conversation management ────────────────────────────────────────────

  async getConversations(tenantId: string) {
    return this.prisma.aiTenantConversation.findMany({
      where: { tenantId },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    })
  }

  async getConversation(tenantId: string, conversationId: string) {
    const conv = await this.prisma.aiTenantConversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (!conv) throw new NotFoundException('Konversation hittades inte')
    return conv
  }

  async deleteConversation(tenantId: string, conversationId: string) {
    const conv = await this.prisma.aiTenantConversation.findFirst({
      where: { id: conversationId, tenantId },
    })
    if (!conv) throw new NotFoundException('Konversation hittades inte')
    await this.prisma.aiTenantConversation.delete({ where: { id: conversationId } })
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async assertTenantQuota(tenantId: string): Promise<void> {
    const status = await this.usage.getTenantUsage(tenantId)
    if (status.callsToday >= TENANT_DAILY_CALL_LIMIT) {
      throw new ServiceUnavailableException(
        'Jag har nått min dagsgräns för svar. Kontakta din hyresvärd direkt så hjälper de dig vidare.',
      )
    }
    if (status.monthlyCostSek >= TENANT_MONTHLY_COST_SEK) {
      throw new ServiceUnavailableException(
        'Jag har nått månadens AI-budget. Kontakta din hyresvärd direkt så hjälper de dig vidare.',
      )
    }
  }

  private async getOrCreateConversation(
    tenantId: string,
    message: string,
    conversationId?: string,
  ) {
    if (conversationId) {
      const conv = await this.prisma.aiTenantConversation.findFirst({
        where: { id: conversationId, tenantId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      })
      if (!conv) throw new NotFoundException('Konversation hittades inte')
      return conv
    }
    const title = message.length > 60 ? message.slice(0, 57) + '...' : message
    return this.prisma.aiTenantConversation.create({
      data: { tenantId, title },
      include: { messages: true },
    })
  }

  private async buildTenantContext(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        firstName: true,
        lastName: true,
        companyName: true,
        type: true,
        email: true,
      },
    })
    if (!tenant) return ''
    const name =
      tenant.type === 'COMPANY'
        ? (tenant.companyName ?? tenant.email)
        : `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim() || tenant.email
    return `Inloggad hyresgäst: ${name} (${tenant.email}). Använd hyresgästens namn naturligt i svaret.`
  }

  private async callClaude(
    messages: Anthropic.MessageParam[],
    tenantContext: string,
    organizationId: string,
    tenantId: string,
  ): Promise<Anthropic.Message> {
    const dateContext = new Intl.DateTimeFormat('sv-SE').format(new Date())
    try {
      const response = await this.client.messages.create({
        model: TENANT_MODEL,
        max_tokens: TENANT_MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: TENANT_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: `Dagens datum: ${dateContext}\n\n${tenantContext}` },
        ],
        tools: TENANT_TOOLS,
        messages,
      })
      void this.usage
        .logUsage({
          organizationId,
          tenantId,
          endpoint: 'tenant-chat',
          model: TENANT_MODEL,
          usage: response.usage,
        })
        .catch((err: unknown) => this.logger.warn('logUsage(tenant-chat) failed', err))
      return response
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Okänt fel'
      throw new ServiceUnavailableException(
        `AI-assistenten kunde inte svara just nu (${msg}). Försök igen om en stund eller kontakta din hyresvärd.`,
      )
    }
  }

  private extractText(response: Anthropic.Message): string {
    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    return block?.text ?? 'Jag har inget svar just nu — försök gärna omformulera frågan.'
  }

  private async handleTextResponse(
    response: Anthropic.Message,
    conversationId: string,
    userMessage: string,
  ): Promise<TenantChatResponse> {
    const reply = this.extractText(response)
    await this.prisma.aiTenantMessage.createMany({
      data: [
        { conversationId, role: 'user', content: userMessage },
        { conversationId, role: 'assistant', content: reply },
      ],
    })
    await this.prisma.aiTenantConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    })
    return { reply, conversationId }
  }

  private buildConfirmation(
    toolName: string,
    input: Record<string, unknown>,
  ): { confirmationMessage: string; details: Record<string, string> } {
    switch (toolName) {
      case 'create_maintenance_ticket': {
        const priority = (input.priority as string | undefined) ?? 'NORMAL'
        const priorityLabel: Record<string, string> = {
          URGENT: 'Akut',
          HIGH: 'Hög',
          NORMAL: 'Normal',
          LOW: 'Låg',
        }
        return {
          confirmationMessage: `Skapa felanmälan: ${String(input.title ?? '')}`,
          details: {
            Titel: String(input.title ?? ''),
            Beskrivning: String(input.description ?? ''),
            Kategori: String(input.category ?? 'OTHER'),
            Prioritet: priorityLabel[priority] ?? priority,
          },
        }
      }
      case 'request_termination':
        return {
          confirmationMessage: `Skicka begäran om uppsägning till hyresvärden`,
          details: {
            'Önskat slutdatum': String(input.requestedEndDate ?? ''),
            ...(input.reason ? { Anledning: String(input.reason) } : {}),
            Status: 'Preliminär — hyresvärden måste godkänna enligt Hyreslagen 12 kap. JB',
          },
        }
      default:
        return {
          confirmationMessage: `Bekräfta åtgärd: ${toolName}`,
          details: {},
        }
    }
  }
}
