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
import type { FastifyReply } from 'fastify'
import { AiAssistantService } from './ai-assistant.service'
import { MemoryService } from './memory.service'
import { PortfolioAnalysisService } from './portfolio-analysis.service'
import { DataContextService } from './data-context.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { ChatDto } from './dto/chat.dto'
import { ConfirmActionDto } from './dto/confirm-action.dto'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import type { JwtPayload } from '@eken/shared'

const STREAMING_SYSTEM_PROMPT = `Du är en intelligent AI-assistent för Eken, ett svenskt fastighetsförvaltningssystem.
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
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Get('chat/stream')
  async streamChat(
    @Query('message') message: string,
    @Query('conversationId') conversationId: string | undefined,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Res() reply: FastifyReply,
  ): Promise<void> {
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

      // 2. Build data context + system prompt
      const dataCtx = await this.dataContext.buildContext(organizationId)
      const systemPrompt = `${STREAMING_SYSTEM_PROMPT}\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}`

      // 3. Build message history
      const allMessages = [
        ...conversation.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user' as const, content: message },
      ]

      send('start', { conversationId: conversation.id })

      // 4. Call Anthropic with stream: true
      const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY', '')
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2048,
          stream: true,
          system: systemPrompt,
          messages: allMessages,
        }),
      })

      // 5. Read stream
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7)
          } else if (trimmed.startsWith('data: ')) {
            if (currentEvent !== 'content_block_delta') continue
            try {
              const parsed = JSON.parse(trimmed.slice(6)) as {
                type?: string
                delta?: { type?: string; text?: string }
              }
              if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                const text = parsed.delta.text ?? ''
                if (text) {
                  fullText += text
                  send('delta', { text })
                }
              }
            } catch {
              // ignore malformed lines
            }
          }
        }
      }

      // 6. Save to DB
      await this.prisma.aiMessage.createMany({
        data: [
          { conversationId: conversation.id, role: 'user', content: message },
          {
            conversationId: conversation.id,
            role: 'assistant',
            content: fullText || 'Inget svar.',
          },
        ],
      })
      await this.prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      })

      // 7. Done
      send('done', { conversationId: conversation.id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Okänt fel'
      send('error', { message: `Något gick fel, försök igen. (${msg})` })
    } finally {
      reply.raw.end()
    }
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
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
  getAnalysis(@OrgId() orgId: string, @Query('type') type: string) {
    const validTypes = ['revenue', 'occupancy', 'risks', 'full'] as const
    const analysisType = validTypes.includes(type as 'revenue')
      ? (type as (typeof validTypes)[number])
      : 'full'
    return this.portfolioAnalysisService.analyzePortfolio(orgId, analysisType)
  }
}
