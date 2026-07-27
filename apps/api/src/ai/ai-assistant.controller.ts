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
  BadRequestException,
  Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Throttle } from '@nestjs/throttler'
import type { FastifyReply } from 'fastify'
import Anthropic from '@anthropic-ai/sdk'
import { Prisma } from '@prisma/client'
import {
  AiAssistantService,
  requiresDoubleConfirmation,
  SYSTEM_PROMPT,
} from './ai-assistant.service'
import { MemoryService } from './memory.service'
import { PortfolioAnalysisService } from './portfolio-analysis.service'
import { DataContextService } from './data-context.service'
import { ToolExecutorService } from './tools/tool-executor.service'
import { TOOLS, ACTION_TOOLS } from './tools/ai-tools.definition'
import { buildToolCatalog } from './tools/ai-tools.catalog'
import {
  AiAttachmentsService,
  MAX_ATTACHMENT_BUDGET_BYTES,
} from './attachments/ai-attachments.service'
import { assertRequestWithinLimit } from './attachments/request-size'
import {
  enforceToolPairInvariant,
  sanitizeBlocksForPersistence,
  wasRepaired,
  describeRepair,
  stripThinkingBlocks,
} from './history-integrity'
import { AiUsageService } from './usage/ai-usage.service'
import { AiQuotaService } from './usage/ai-quota.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { formatSourceSuffix } from './knowledge/grounding/legal-grounding'
import { ChatDto, CHAT_MESSAGE_MAX_LENGTH, CHAT_MAX_ATTACHMENTS } from './dto/chat.dto'
import { ConfirmActionDto } from './dto/confirm-action.dto'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import type { JwtPayload } from '@eken/shared'
import { chatRequestOptions, pickChatProfile } from './ai.config'

const STREAM_MAX_TOOL_ITERATIONS = 3

// Samma format som ChatDto:s @IsUUID('4') grindar på POST-vägen. SSE-vägen har
// ingen ValidationPipe och måste därför göra kontrollen själv.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Tokentaket är INTE längre en konstant här — det kommer från modellprofilen
// (se CHAT_PROFILE_TEXT / CHAT_PROFILE_VISION i ai.config.ts). SSE-vägen och den
// icke-strömmande vägen delar samma profil, så de kan inte drifta isär.

// C3: AI-assistenten kräver minst ACCOUNTANT. Utestänger VIEWER (som annars
// nådde chat/stream/analys) men bevarar bokförings-AI för ekonomirollen —
// tool-executorns finare spärrar (ACTION_TOOLS, ACCOUNTING_ONLY_ACTIONS) ligger
// kvar som djupförsvar ovanpå denna controller-gate. JWT enforce:as globalt.
@Controller('ai')
@Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
export class AiAssistantController {
  private readonly logger = new Logger(AiAssistantController.name)

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
    private readonly attachmentsService: AiAttachmentsService,
  ) {}

  @Get('chat/stream')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async streamChat(
    @Query('message') message: string,
    @Query('conversationId') conversationId: string | undefined,
    // B2: BARA id:n på URL:en, aldrig bytes — det var hela poängen med B1:s
    // separata uppladdning. Kommaseparerad lista, eller upprepad parameter
    // (Fastify ger då en array); båda formerna normaliseras nedan.
    @Query('attachmentIds') attachmentIdsRaw: string | string[] | undefined,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // SECURITY (H4): SSE-endpointen tar `message` som rå query-param och går
    // därmed förbi ChatDto:s ValidationPipe. Validera längden manuellt med
    // samma gränser (1–CHAT_MESSAGE_MAX_LENGTH) så att SSE-vägen inte blir en
    // kringgång av kostnads-/DoS-skyddet.
    if (typeof message !== 'string' || message.length < 1) {
      throw new BadRequestException('message krävs')
    }
    if (message.length > CHAT_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException(`message får vara högst ${CHAT_MESSAGE_MAX_LENGTH} tecken`)
    }

    // SECURITY: samma resonemang som för `message` ovan — query-params går förbi
    // ChatDto:s ValidationPipe, så SSE-vägen måste grinda bilage-id:n själv.
    // Utan taket kunde en URL bära hundratals id:n och dra ner obegränsat med
    // bytes ur R2 in i en enda request.
    const attachmentIds = (
      Array.isArray(attachmentIdsRaw)
        ? attachmentIdsRaw
        : typeof attachmentIdsRaw === 'string'
          ? attachmentIdsRaw.split(',')
          : []
    )
      .map((id) => id.trim())
      .filter((id) => id.length > 0)

    if (attachmentIds.length > CHAT_MAX_ATTACHMENTS) {
      throw new BadRequestException(`Högst ${CHAT_MAX_ATTACHMENTS} bilagor per meddelande`)
    }
    if (attachmentIds.some((id) => !UUID_RE.test(id))) {
      throw new BadRequestException('attachmentIds måste vara giltiga id:n')
    }

    // Kvot-kontroll innan vi öppnar SSE-strömmen.
    // checkQuota() täcker plan-räknaren + org-wide daglig kostnadscap.
    // checkUserDailyCostCap() lägger till per-user daglig cap (50 SEK/dag).
    try {
      await this.quotaService.checkQuota(organizationId)
      await this.quotaService.checkUserDailyCostCap(organizationId, user.sub)
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
      //    cachas över flera dygn. Använder samma fulla SYSTEM_PROMPT och
      //    memories-injektion som non-streaming chat() så att SSE-flödet
      //    inte får ett degraderat svar.
      const [dataCtx, memoriesCtx] = await Promise.all([
        this.dataContext.buildContext(organizationId),
        this.memoryService.getMemories(organizationId, user.sub),
      ])
      const dateContext = this.dataContext.getCurrentDateContext()
      const memorySection = memoriesCtx ? `\n\n${memoriesCtx}` : ''
      const cacheableSystemText = `${SYSTEM_PROMPT}\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}${memorySection}`
      const systemBlocks: Anthropic.TextBlockParam[] = [
        {
          type: 'text',
          text: cacheableSystemText,
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: dateContext },
      ]

      // Juridisk grundning (Etapp 2, PR 2.3a + miss-grind 2.3b) — exakt samma
      // delade väg som non-stream chat() (resolveLegalGrounding: deterministisk
      // grind + Haiku-relevansdomare). God träff → verifierad lagtext som eget
      // systemblock EFTER cache-breakpointen; svag/fel träff → ärligt miss-
      // block. Källhänvisningen binds av kod ur chunk-metadata efter avslutad
      // stream (gap A) — ALDRIG vid miss.
      const grounding = await this.aiService.resolveLegalGrounding(
        message,
        organizationId,
        user.sub,
      )
      if (grounding) {
        // PR 2.4: eget cache-breakpoint på lagtext-/miss-blocket — samma
        // hierarki som non-stream callClaude (TOOLS → systemprefix → detta
        // block; 3 av max 4 breakpoints). Ligger sist i system och kan inte
        // invalidera prefix-cachet; återanvänds inom tool-loopen och vid
        // snabba följdfrågor med samma hämtade paragrafer.
        systemBlocks.push({
          type: 'text',
          text: grounding.contextBlock,
          cache_control: { type: 'ephemeral' },
        })
      }

      // 3. Build message history via gemensam helper som hanterar både
      //    blocks-fallback (FAS 3) och sliding window för långa konversationer
      //    (FAS 4). Korta konversationer (≤30 meddelanden) returnerar
      //    historiken oförändrad — ingen beteendeskillnad.
      // B2: bilagor → innehållsblock. Org-scopningen (org + user, och antalet
      // träffar måste matcha antalet id:n) sker i buildContentBlocks och kastar
      // innan strömmen hunnit kosta något.
      const attached = await this.attachmentsService.buildContentBlocks(
        attachmentIds,
        organizationId,
        user.sub,
      )

      // MODELLVALET för hela strömmen. Samma regel som i den icke-strömmande
      // vägen: grundas på faktiska innehållsblock, inte på id-listans längd,
      // och är oföränderlig genom hela tool-loopen nedan.
      const profile = pickChatProfile(attached.contentBlocks.length > 0)

      // Text-only är OFÖRÄNDRAT: utan bilagor är content en ren sträng.
      // Bilagorna läggs före texten så modellen läser underlaget innan frågan.
      const userContent: string | Anthropic.ContentBlockParam[] =
        attached.contentBlocks.length > 0
          ? [...attached.contentBlocks, { type: 'text' as const, text: message }]
          : message

      // Det som PERSISTERAS är referenser, aldrig base64 — se ATTACHMENT_REF_BLOCK.
      const userBlocks =
        attached.refBlocks.length > 0
          ? ([
              ...attached.refBlocks,
              { type: 'text', text: message },
            ] as unknown as Prisma.InputJsonValue)
          : null

      const history = await this.aiService.buildMessageHistoryForClaude(
        conversation,
        MAX_ATTACHMENT_BUDGET_BYTES - attached.encodedBytes,
      )
      let currentMessages: Anthropic.MessageParam[] = [
        ...history,
        { role: 'user' as const, content: userContent },
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
        // B3 — sista grinden före anropet. Pre-flight-kollen i
        // buildContentBlocks såg bara de NYA bilagorna; först här är hela
        // requesten känd (bilagor + rehydrerad historik + system + verktyg).
        assertRequestWithinLimit({
          system: systemBlocks,
          tools: TOOLS,
          messages: currentMessages,
        })

        // SISTA GRINDEN — exakt samma tvåstegssanering som non-stream-vägen,
        // ur samma modul: resonemangsblock ut (modellbundna, historiken kan
        // blanda Sonnet- och Opus-turer), sedan par-invarianten (ett obesvarat
        // tool_use hade annars fällt varje request i konversationen).
        const { messages: safeMessages, repair } = enforceToolPairInvariant(
          stripThinkingBlocks(currentMessages),
        )
        if (wasRepaired(repair)) {
          this.logger.warn(`Historiken sanerades före stream: ${describeRepair(repair)}`)
        }

        const stream = anthropic.messages.stream({
          // Modell + tokentak + effort samlat från profilen — vald en gång
          // ovan, oförändrad genom alla iterationer.
          ...chatRequestOptions(profile),
          system: systemBlocks,
          tools: TOOLS,
          messages: safeMessages,
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
          await this.aiService.enrichDoubleConfirmContext(actionBlock.name, input, organizationId)
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

      // CITAT-INTEGRITET (gap A): på ett avslutat, grundat textsvar appendar
      // KODEN den auktoritativa källhänvisningen — byggd ur de hämtade
      // chunkarnas metadata innan AI:n svarade — som ett sista delta. AI:ns
      // strömmade text kan aldrig påverka källraden. Aldrig på pending actions
      // — och ALDRIG vid miss (gap B): ingen grund, ingen källrad.
      if (!pendingAction && grounding?.outcome === 'grounded' && assistantText) {
        const sourceSuffix = formatSourceSuffix(grounding)
        assistantText += sourceSuffix
        send('delta', { text: sourceSuffix })
      }

      // 5. Logga kostnad
      void this.usageService
        .logUsage({
          organizationId,
          userId: user.sub,
          endpoint: 'stream',
          // Från profilen, inte en konstant — annars bokförs Opus-anrop till
          // Sonnet-pris och kostnadstaken räknar fel.
          model: profile.model,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: cacheWriteTokens,
          },
          isAutomated: false,
          source: 'manual_chat',
        })
        .catch(() => undefined)

      // 6. Spara — actions sparar bara user-meddelandet (svaret kommer vid bekräftelse)
      if (pendingAction) {
        await this.prisma.aiMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'user',
            content: message,
            ...(userBlocks ? { blocks: userBlocks } : {}),
          },
        })
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        })
        // Bilagan nådde modellen (den föreslog en åtgärd utifrån den) och ligger
        // nu i historiken — konsumera så cronen inte städar bort den.
        await this.attachmentsService.markConsumed(attached.ids, conversation.id)
        // SECURITY (RISK 1): persistera den föreslagna åtgärden så confirm-
        // endpointen kan binda bekräftelsen mot exakt denna åtgärd.
        await this.aiService.recordPendingAction(
          conversation.id,
          organizationId,
          user.sub,
          pendingAction.toolName,
          pendingAction.toolInput,
        )
        send('pending_action', { conversationId: conversation.id, ...pendingAction })
      } else {
        // Spara user + assistant separat så assistant-raden kan få `blocks`
        // (final-turnens Anthropic ContentBlock[]). User-raden får ingen
        // blocks-kolumn satt — backwards-compatible.
        await this.prisma.aiMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'user',
            content: message,
            ...(userBlocks ? { blocks: userBlocks } : {}),
          },
        })
        // Aldrig ett halvt par i historiken — se sanitizeBlocksForPersistence.
        // Träffas när tool-loopen tog slut på iterationer med stop_reason
        // fortfarande 'tool_use': den turen bar då tool_use utan resultat.
        const persistedBlocks = sanitizeBlocksForPersistence(assistantContent)
        await this.prisma.aiMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'assistant',
            content: assistantText || 'Inget svar.',
            ...(persistedBlocks
              ? { blocks: persistedBlocks as unknown as Prisma.InputJsonValue }
              : {}),
          },
        })
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        })
        await this.attachmentsService.markConsumed(attached.ids, conversation.id)

        // Minnesextraktion efter AVSLUTAD stream — exakt samma delade väg som non-stream
        // chat() (extractMemoriesInBackground → memory.extractAndSaveMemories). Får hela det
        // ACKUMULERADE svaret (assistantText) + användarens meddelande. Fire-and-forget:
        // körs efter att svaret strömmats färdigt och blockerar/fördröjer ALDRIG streamen;
        // ett extraktionsfel kan aldrig störa chatt-svaret. Endast på ett faktiskt textsvar
        // (denna gren) — aldrig på en pending action, precis som non-stream-vägen.
        this.aiService.extractMemoriesInBackground(
          message,
          assistantText || 'Inget svar.',
          organizationId,
          user.sub,
        )

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
    return this.aiService.chat(
      orgId,
      user.sub,
      user.role,
      dto.message,
      dto.conversationId,
      dto.attachmentIds,
    )
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
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

  /**
   * Verktygskatalogen — vad assistenten KAN, i den form användaren ska se den.
   *
   * Härledd ur TOOLS + ACTION_TOOLS vid varje anrop, så listan aldrig kan
   * drifta från den assistenten faktiskt får. Innehållet är identiskt för alla
   * organisationer (det är produktens förmågor, inte kunddata) men endpointen
   * kräver samma auth som chatten.
   *
   * OBS: katalogen visar ALLA verktyg. Att ett verktyg syns här betyder inte
   * att just den här användaren får köra det — rollgrindarna (ACTION_TOOLS,
   * ACCOUNTING_ONLY_ACTIONS) sitter kvar i tool-executorn vid exekvering.
   */
  @Get('tools')
  getToolCatalog(@OrgId() _orgId: string) {
    return buildToolCatalog()
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
