import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply } from 'fastify'
import Anthropic from '@anthropic-ai/sdk'
import { AiAssistantService, requiresDoubleConfirmation } from './ai-assistant.service'
import { MemoryService } from './memory.service'
import { PortfolioAnalysisService } from './portfolio-analysis.service'
import { DataContextService } from './data-context.service'
import { ToolExecutorService } from './tools/tool-executor.service'
import { TOOLS, ACTION_TOOLS } from './tools/ai-tools.definition'
import { AiUsageService } from './usage/ai-usage.service'
import { AiQuotaService } from './usage/ai-quota.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { ChatDto } from './dto/chat.dto'
import { ConfirmActionDto } from './dto/confirm-action.dto'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import type { JwtPayload } from '@eken/shared'
import { AI_MODELS } from './ai.config'

const STREAM_MODEL = AI_MODELS.STREAM
const STREAM_MAX_TOOL_ITERATIONS = 3
const STREAM_MAX_TOKENS = 2048

const STREAMING_SYSTEM_PROMPT = `Du är en intelligent AI-assistent för Eveno, ett svenskt fastighetsförvaltningssystem.
Du hjälper fastighetsförvaltare att hantera sin portfölj effektivt.

REGLER:
- Svara alltid på svenska
- Var konkret och använd faktiska siffror från datan
- Identifiera mönster, risker och möjligheter i portföljen
- Ge handlingsbara råd baserat på situationen
- Aldrig hitta på siffror – basera alltid svar på nedanstående data`

@Controller('ai')
export class AiAssistantController {
  constructor(
    private readonly aiService: AiAssistantService,
    private readonly memoryService: MemoryService,
    private readonly portfolioAnalysisService: PortfolioAnalysisService,
    private readonly dataContext: DataContextService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly usageService: AiUsageService,
    private readonly quotaService: AiQuotaService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Get('chat/stream')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async streamChat(
    @Query('message') message: string,
    @Query('conversationId') conversationId: string | undefined,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Kvot-kontroll innan vi öppnar SSE-strömmen
    try {
      await this.quotaService.checkQuota(organizationId)
    } catch (err) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const msg = err instanceof Error ? err.message : 'AI-kvota överskriden'
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`)
      reply.raw.end()
      return
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      // 1. Get or create conversation
      let conversation = conversationId
        ? await this.prisma.aiConversation.findFirst({
            where: { id: conversationId, organizationId, userId: user.sub },
            include: { messages: { orderBy: { createdAt: 'asc' } } },
          })
        : null

      if (!conversation) {
        const title = message.length > 60 ? message.slice(0, 57) + '...' : message
        conversation = await this.prisma.aiConversation.create({
          data: { organizationId, userId: user.sub, title },
          include: { messages: true },
        })
      }

      // 2. Build data context + system prompt. Datum sänds som ett separat
      //    (icke-cachat) systemblock så att portföljdata-snapshotten kan
      //    cachas över flera dygn.
      const dataCtx = await this.dataContext.buildContext(organizationId)
      const dateContext = this.dataContext.getCurrentDateContext()
      const cacheableSystemText = `${STREAMING_SYSTEM_PROMPT}\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}`
      const systemBlocks: Anthropic.TextBlockParam[] = [
        {
          type: 'text',
          text: cacheableSystemText,
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: dateContext },
      ]

      // 3. Build message history
      let currentMessages: Anthropic.MessageParam[] = [
        ...conversation.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user' as const, content: message },
      ]

      send('start', { conversationId: conversation.id })

      const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY', '')
      const anthropic = new Anthropic({ apiKey })

      let assistantText = ''
      let pendingAction: {
        toolName: string
        toolInput: Record<string, unknown>
        confirmationMessage: string
        details: Record<string, string>
        requiresDoubleConfirm?: boolean
      } | null = null

      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0

      // 4. Tool-loop med streamning
      let iterations = 0
      let stopReason: string | null = null
      let assistantContent: Anthropic.ContentBlock[] = []

      while (iterations < STREAM_MAX_TOOL_ITERATIONS) {
        const stream = anthropic.messages.stream({
          model: STREAM_MODEL,
          max_tokens: STREAM_MAX_TOKENS,
          system: systemBlocks,
          tools: TOOLS,
          messages: currentMessages,
        })

        // Stream textdeltan direkt till klienten
        stream.on('text', (delta: string) => {
          if (delta) {
            assistantText += delta
            send('delta', { text: delta })
          }
        })

        // Annonsera tool_use så snart vi ser den i strömmen
        let lastNotifiedIndex = -1
        stream.on('streamEvent', (event) => {
          if (
            event.type === 'content_block_start' &&
            event.content_block.type === 'tool_use' &&
            event.index !== lastNotifiedIndex
          ) {
            lastNotifiedIndex = event.index
            send('tool_use_start', {
              id: event.content_block.id,
              name: event.content_block.name,
            })
          }
        })

        const finalMessage = await stream.finalMessage()
        assistantContent = finalMessage.content
        stopReason = finalMessage.stop_reason ?? null

        if (finalMessage.usage) {
          inputTokens += finalMessage.usage.input_tokens ?? 0
          outputTokens += finalMessage.usage.output_tokens ?? 0
          cacheReadTokens += finalMessage.usage.cache_read_input_tokens ?? 0
          cacheWriteTokens += finalMessage.usage.cache_creation_input_tokens ?? 0
        }

        if (stopReason !== 'tool_use') break

        const toolUses = assistantContent.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        )

        // Om en åtgärd uppstår: avbryt streaming och kräv bekräftelse.
        // Behåll bekräftelseflödet — actions exekveras inte direkt.
        const actionBlock = toolUses.find((tu) => ACTION_TOOLS.has(tu.name))
        if (actionBlock) {
          const input = actionBlock.input as Record<string, unknown>
          const conf = this.aiService.buildConfirmation(actionBlock.name, input)
          const needsDouble = requiresDoubleConfirmation(actionBlock.name, input)
          pendingAction = {
            toolName: actionBlock.name,
            toolInput: input,
            ...conf,
            ...(needsDouble ? { requiresDoubleConfirm: true } : {}),
          }
          break
        }

        // Read-tools — kör parallellt och annonsera resultat
        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = await Promise.all(
          toolUses.map(async (tu) => {
            send('tool_use_executing', {
              id: tu.id,
              name: tu.name,
              input: tu.input as Record<string, unknown>,
            })
            let result: unknown
            try {
              result = await this.toolExecutor.executeTool(
                tu.name,
                tu.input as Record<string, unknown>,
                organizationId,
                user.sub,
                user.role,
                { conversationId: conversation!.id },
              )
            } catch (err) {
              result = {
                success: false,
                message: err instanceof Error ? err.message : 'Fel vid verktygsanrop',
              }
            }
            send('tool_result', { id: tu.id, name: tu.name, result })
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            }
          }),
        )

        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: assistantContent },
          { role: 'user', content: toolResultBlocks },
        ]
        iterations++
      }

      // 5. Logga kostnad
      void this.usageService
        .logUsage({
          organizationId,
          userId: user.sub,
          endpoint: 'stream',
          model: STREAM_MODEL,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: cacheWriteTokens,
          },
        })
        .catch(() => undefined)

      // 6. Spara — actions sparar bara user-meddelandet (svaret kommer vid bekräftelse)
      if (pendingAction) {
        await this.prisma.aiMessage.create({
          data: { conversationId: conversation.id, role: 'user', content: message },
        })
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        })
        send('pending_action', { conversationId: conversation.id, ...pendingAction })
      } else {
        await this.prisma.aiMessage.createMany({
          data: [
            { conversationId: conversation.id, role: 'user', content: message },
            {
              conversationId: conversation.id,
              role: 'assistant',
              content: assistantText || 'Inget svar.',
            },
          ],
        })
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        })
        send('done', { conversationId: conversation.id })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Okänt fel'
      send('error', { message: `Något gick fel, försök igen. (${msg})` })
    } finally {
      reply.raw.end()
    }
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  chat(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Body() dto: ChatDto) {
    return this.aiService.chat(orgId, user.sub, user.role, dto.message, dto.conversationId)
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirmAction(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmActionDto,
  ) {
    return this.aiService.confirmAction(
      dto.toolName,
      dto.toolInput,
      dto.conversationId,
      dto.confirmed,
      orgId,
      user.sub,
      user.role,
    )
  }

  @Get('conversations')
  getConversations(@OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
    return this.aiService.getConversations(orgId, user.sub)
  }

  @Get('conversations/:id')
  getConversation(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.aiService.getConversation(orgId, user.sub, id)
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteConversation(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.aiService.deleteConversation(orgId, user.sub, id)
  }

  @Delete('memory')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearMemory(@OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
    return this.memoryService.clearMemories(orgId, user.sub)
  }

  @Get('analysis')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  getAnalysis(@OrgId() orgId: string, @Query('type') type: string) {
    const validTypes = ['revenue', 'occupancy', 'risks', 'full'] as const
    const analysisType = validTypes.includes(type as 'revenue')
      ? (type as (typeof validTypes)[number])
      : 'full'
    return this.portfolioAnalysisService.analyzePortfolio(orgId, analysisType)
  }

  @Get('usage')
  getUsage(@OrgId() orgId: string) {
    return this.quotaService.getStatus(orgId)
  }

  @Get('usage/breakdown')
  getUsageBreakdown(@OrgId() orgId: string) {
    return this.usageService.getMonthlyBreakdown(orgId)
  }
}
