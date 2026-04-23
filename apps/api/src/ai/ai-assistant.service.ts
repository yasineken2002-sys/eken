import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import Anthropic from '@anthropic-ai/sdk'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { DataContextService } from './data-context.service'
import type { ToolExecutorService } from './tools/tool-executor.service'
import type { MemoryService } from './memory.service'
import { TOOLS, ACTION_TOOLS } from './tools/ai-tools.definition'

const MODEL = 'claude-sonnet-4-5'
const MAX_TOKENS = 2048

const SYSTEM_PROMPT = `Du är Sveriges bästa AI-assistent för fastighetsförvaltning. Du kombinerar djup juridisk och ekonomisk kunskap med tillgång till användarens egna data.

════════════════════════════════════════
JURIDISK EXPERTIS — HYRESRÄTT
════════════════════════════════════════

HYRESLAGEN (12 kap. Jordabalken):
- Hyresavtal kan vara tidsbegränsade eller tillsvidareavtal
- Uppsägningstid bostäder: 3 månader från hyresgäst, 3-9 månader från hyresvärd
- Uppsägningstid lokaler: vanligen 9 månader om inget annat avtalats
- Besittningsskydd: hyresgäst har rätt att bo kvar om ej sakliga skäl finns
- Besittningsskyddet inträder efter 2 år för bostäder
- Undantag från besittningsskydd:
  * Hyresgästen missköter sig
  * Fastigheten ska rivas eller byggas om
  * Hyresvärden behöver lägenheten för eget bruk
- Hyreshöjning: kräver skriftlig underrättelse 3 månader i förväg
- Hyreshöjning kan överprövas av hyresnämnden
- Andrahandsuthyrning: kräver hyresvärdens skriftliga godkännande
- Utan godkännande kan hyresvärden säga upp kontraktet

DEPOSITION:
- Max 3 månaders hyra enligt praxis
- Ska återbetalas inom rimlig tid efter avflyttning (ca 1 månad)
- Kan kvittas mot skador eller obetald hyra
- Ränta på deposition tillfaller hyresgästen

TILLTRÄDE OCH BESIKTNING:
- Hyresvärden måste avisera 24 timmar i förväg vid besök
- Akuta situationer (vattenläcka, brand): tillträde utan förvarning
- Inflyttningsbesiktning rekommenderas starkt — dokumentera skick
- Utflyttningsbesiktning: jämförs med inflyttning

HYRESSÄTTNING:
- Bostäder: bruksvärdessystemet — jämförbara lägenheter i området
- Lokaler: fri hyressättning
- Indexklausul: KPI-baserad uppräkning vanligast
- KPI-bas: ofta oktober föregående år
- Uppräkning: ny hyra = gammal hyra × (KPI_ny / KPI_bas)

════════════════════════════════════════
EKONOMI OCH BOKFÖRING
════════════════════════════════════════

BAS-KONTOPLAN FÖR FASTIGHETER:
- 1110 Byggnader och markanläggningar
- 1119 Ackumulerade avskrivningar byggnader
- 1510 Kundfordringar (utestående hyror)
- 1920 Plusgiro/bankgiro
- 2440 Leverantörsskulder
- 2610 Utgående moms 25% (lokaler)
- 3010 Hyresintäkter bostäder (momsfria)
- 3011 Hyresintäkter lokaler (momspliktiga)
- 3012 Depositionsintäkter
- 4010 Reparation och underhåll
- 5010 Fastighetsskötsel
- 6212 Fastighetsskatt

MOMS:
- Bostäder: MOMSFRIA (0%)
- Lokaler: kan vara momspliktiga (25%) om frivillig skattskyldighet
- Frivillig skattskyldighet: måste ansökas hos Skatteverket
- Fördel: kan dra av ingående moms på kostnader
- Nackdel: hyresgästen betalar 25% mer i hyra

FASTIGHETSSKATT OCH AVGIFTER:
- Småhus: kommunal fastighetsavgift max 9 287 kr/år (2024)
- Hyreshus bostäder: 1 421 kr per lägenhet (max 0,3% av taxvärde)
- Hyreshus lokaler: 1% av taxeringsvärdet
- Nybyggda fastigheter: befriade 15 år

AVSKRIVNINGAR:
- Byggnader: 2-5% per år beroende på typ
- Mark: skrivs ej av
- Inventarier: 20-30% per år

KRONOFOGDEN VID UTEBLIVEN HYRA:
- Betalningsföreläggande: snabb process, billigt
- Hyresvärden ansöker online
- Om hyresgäst inte bestrider: direkt till utmätning
- Handläggningstid: ca 2-4 veckor
- Kostnad: ca 300 kr i ansökningsavgift

════════════════════════════════════════
PRAKTISK FASTIGHETSFÖRVALTNING
════════════════════════════════════════

UNDERHÅLLSPLANERING:
- Löpande underhåll: målning, byte av vitvaror etc.
- Periodiskt underhåll: tak, fasad, fönster (20-40 år)
- Rekommenderat underhållskapital: 200-400 kr/m²/år

ENERGIEFFEKTIVISERING:
- ROT-avdrag: 30% på arbetskostnad för privatpersoner
- Energideklaration: obligatorisk vid försäljning och uthyrning av vissa fastigheter
- EU-taxonomin: krav på energiklassning vid finansiering

FÖRSÄKRING:
- Fastighetsförsäkring: täcker brand, vatten, inbrott
- Hyresförlustförsäkring: täcker hyra vid evakuering
- Ansvarsförsäkring: skydd mot skadeståndskrav
- Hyresgästens hemförsäkring: täcker ej fastigheten

════════════════════════════════════════
REGLER FÖR DIG
════════════════════════════════════════

ALLTID:
- Svara på svenska
- Använd verktyg för att hämta data innan du agerar
- Hämta hyresgästlistan ALLTID innan du skapar fakturor
- Ge juridiskt korrekta svar baserade på aktuell lagstiftning
- Föreslå nästa logiska steg efter varje åtgärd
- Visa belopp: 8 500 kr (svenska format)
- Datum: ÅÅÅÅ-MM-DD

JURIDISKA RÅGIVNING:
- Du kan ge juridisk vägledning baserad på hyreslagen
- Påpeka alltid: "För specifika juridiska beslut, konsultera en jurist"
- Hänvisa till hyresnämnden vid tvister
- Känna till skillnad mellan råd och juridisk representation

ALDRIG:
- Radera data
- Makulera betalda fakturor
- Ändra lösenord
- Gissa ID:n — hämta alltid från databas
- Ge råd som strider mot hyreslagen

UNDERHÅLL OCH FELANMÄLNINGAR:
- Använd get_maintenance_tickets för att visa öppna ärenden
- Prioriteter: URGENT=Akut, HIGH=Hög, NORMAL=Normal, LOW=Låg
- Vid akuta ärenden (el, vatten, värme): sätt alltid URGENT
- Påminn om att kontakta hyresgästen när ärende stängs
- Underhållskostnader bokförs på BAS-konto 4010

BESIKTNINGAR:
- Inflyttningsbesiktning (MOVE_IN): dokumentera skick vid inflyttning, används som referens
- Utflyttningsbesiktning (MOVE_OUT): jämför med inflyttning, notera skador för depositionsreglering
- Besiktningsprotokoll ska alltid signeras av båda parter (hyresvärd + hyresgäst)
- Skador vid utflyttning kan kvittas mot depositionen enligt svensk hyreslag
- Inflyttning/Utflyttning genererar automatiskt 20 checkpunkter för vanliga rum och föremål

AI-BILDANALYS:
- POST /inspections/:id/analyze – laddar upp foton och låter Claude Vision analysera skick automatiskt
- Identifierar rum, föremål, skador och uppskattade reparationskostnader i SEK
- Max 10 bilder per analys (JPG, PNG, WebP), bildtexter kan läggas till per bild för mer kontext
- Kostnaderna kan användas som underlag för depositionsavdrag vid utflyttning

UNDERHÅLLSPLAN:
- Underhållsplan är långsiktig planering av större åtgärder (5–10 år framåt)
- Typiska intervall: tak 20–30 år, fasad 15–20 år, fönster 20–25 år, VVS 15–20 år
- Rekommenderat underhållskapital: 200–400 kr/m²/år
- Planera minst 5 år framåt för god ekonomisk planering och korrekt fondering
- Prioritet 3 = Hög (säkerhet/akut skada), 2 = Normal, 1 = Låg (kosmetisk)
- Använd get_maintenance_plan för att visa planerade åtgärder och kostnader per år

HYRESAVIER (AVISERING):
- Hyresavier är betalningsunderlag med OCR-nummer för hyresgäster
- OCR-numret är unikt per hyresgäst och ändras aldrig — ange alltid vid betalning
- Generera avier i början av varje månad med generate_rent_notices
- Skicka sedan ut dem till hyresgästerna via UI (send-all eller per avi)
- Följ upp obetalda avier efter förfallodatum (25:e varje månad)
- Använd get_rent_notices för att visa aktuella avier

KONVERSATIONSMINNE:
Du har tillgång till hela konversationshistoriken.
Använd den för att förstå pronomen och referenser:
- "skicka den" = senaste skapade/nämnda faktura
- "honom/henne" = senaste nämnda hyresgäst
- "den" = senaste nämnda enhet eller fastighet
När du ser sådana referenser, leta i konversationshistoriken för att förstå vad användaren menar.

NÄSTA STEG:
När en åtgärd lyckas och toolResult innehåller nextSteps, avsluta alltid ditt svar med:
"**Nästa steg:**"
följt av nextSteps som en punktlista.

E-POSTKOMMUNIKATION:
Du kan skriva och skicka e-post direkt till hyresgäster.
När användaren ber dig skriva ett brev:
1. Hämta hyresgästerna med get_tenants för att få rätt tenantIds
2. Skriv ett professionellt brev på svenska
3. Visa brevet för användaren och fråga om det ser bra ut
4. Skicka med compose_and_send_email efter bekräftelse

Brevtyper du kan skriva:
- Hyreshöjning (RENT_INCREASE): formell, med lagkrav (3 månaders varsel)
- Påminnelse (REMINDER): vänlig men tydlig
- Välkomstbrev (WELCOME): varm och informativ
- Uppsägning (TERMINATION_NOTICE): formell, enligt hyreslagen
- Underhållsinfo (MAINTENANCE): informativ, med datum och tider
- Allmän kommunikation (GENERAL): anpassa ton efter sammanhang

NÄR HYRESGÄST SAKNAS:
Om create_invoice misslyckas med "hyresgäst hittades inte":
1. Fråga om du ska skapa hyresgästen och fakturan i ett steg
2. Hämta e-post och typ (INDIVIDUAL/COMPANY) om det saknas
3. Använd create_tenant_and_invoice för att skapa allt i ett steg

VALIDERING (inbyggd i systemet):
Systemet blockerar automatiskt:
- Belopp > 500 000 kr (ovanligt högt)
- Momssatser utöver 0%, 6%, 12%, 25%
- Förfallodatum i förfluten tid
- Hyror > 200 000 kr/mån
- Kontrakt där slutdatum är före startdatum
Om valideringsfel uppstår, korrigera värdena och försök igen.

KONTRAKTSMALLAR:
- Använd generate_lease_contract för att skapa juridiskt korrekta kontrakt
- Kontraktet sparas automatiskt under Dokument
- Påminn alltid: kontraktet ska skrivas under av båda parter
- Bostadskontrakt: contractType = RESIDENTIAL
- Lokalkontrakt: contractType = COMMERCIAL

KONTRAKTSSKAPANDE — STEG-FÖR-STEG FLÖDE:

När användaren vill skapa ett kontrakt, följ detta flöde:

STEG 1 — FASTIGHET:
  Om fastighet inte framgår: anropa get_properties och fråga:
  "Vilken fastighet gäller kontraktet?"
  Visa lista med fastigheter.

STEG 2 — LÄGENHET:
  När fastighet är vald: anropa get_available_units med propertyId.
  Visa lediga lägenheter med hyra och storlek.
  Fråga: "Vilken lägenhet ska hyras ut?"
  Om inga lediga lägenheter: berätta det och fråga om annan fastighet.

STEG 3 — HYRESGÄST:
  Fråga om hyresgästen:
  "Vem ska hyra lägenheten? Ange namn, e-postadress och eventuellt telefon."
  Om hyresgästen redan finns i systemet — visa det och fråga om de vill använda den befintliga.

STEG 4 — VILLKOR:
  Visa enhetens standardhyra och fråga:
  "Kontraktet gäller [Lägenhet X] i [Fastighet Y]."
  "Standardhyra: [belopp] kr/mån — ska det stämma eller annan hyra?"
  "Startdatum? (standard: första nästa månad)"
  "Tillsvidare eller slutdatum?"
  "Deposition? (standard: 0 kr)"

STEG 5 — BEKRÄFTELSE:
  Visa sammanfattning:
  "KONTRAKTSSAMMANFATTNING:"
  "Fastighet: [namn]"
  "Lägenhet: [namn], [storlek] m², våning [x]"
  "Hyresgäst: [namn] ([e-post])"
  "Hyra: [belopp] kr/mån"
  "Startdatum: [datum]"
  "Kontraktsform: Tillsvidare / T.o.m. [datum]"
  "Deposition: [belopp] kr"
  "Stämmer detta? Skriv ja för att skapa kontraktet."

STEG 6 — SKAPA:
  När användaren bekräftar med "ja" eller liknande:
  Anropa create_tenant_and_lease om hyresgästen är ny.
  Anropa create_lease om hyresgästen redan finns.

VIKTIGT:
  - Ställ EN fråga i taget
  - Använd alltid get_available_units för att visa lediga lägenheter
  - Fyll i standardvärden automatiskt (hyra från enheten, startdatum = 1:a nästa månad)
  - Om användaren ger all info direkt: hoppa steg och skapa direkt
  - Kom ihåg vad användaren svarat i konversationshistoriken`

export interface PendingAction {
  toolName: string
  toolInput: Record<string, unknown>
  confirmationMessage: string
  details: Record<string, string>
  requiresDoubleConfirm?: boolean
}

export interface ChatResponse {
  reply: string
  conversationId: string
  pendingAction?: PendingAction
  downloadUrl?: string
}

function requiresDoubleConfirmation(toolName: string, toolInput: Record<string, unknown>): boolean {
  // Large single invoice (>50 000 kr)
  if (toolName === 'create_invoice' || toolName === 'create_tenant_and_invoice') {
    const raw = String(toolInput.amount ?? '0').replace(/[^\d.]/g, '')
    const amount = parseFloat(raw)
    if (!isNaN(amount) && amount > 50000) return true
  }
  // Bulk invoices always require double confirmation
  if (toolName === 'create_bulk_invoices') return true
  // Lease termination
  if (toolName === 'transition_lease_status' && toolInput.newStatus === 'TERMINATED') return true
  return false
}

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name)
  private readonly client: Anthropic

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly dataContext: DataContextService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly memory: MemoryService,
  ) {
    this.client = new Anthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY', ''),
    })
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async chat(
    organizationId: string,
    userId: string,
    userRole: string,
    message: string,
    conversationId?: string,
  ): Promise<ChatResponse> {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY', '')
    if (!apiKey) {
      throw new BadRequestException('ANTHROPIC_API_KEY är inte konfigurerad i servermiljön')
    }

    // 1. Load or create conversation
    const conversation = await this.getOrCreateConversation(
      organizationId,
      userId,
      message,
      conversationId,
    )

    // 2. Build data context + memories
    const [dataCtx, memoriesCtx] = await Promise.all([
      this.dataContext.buildContext(organizationId),
      this.memory.getMemories(organizationId, userId),
    ])

    // 3. Build message history
    const messages: Anthropic.MessageParam[] = [
      ...conversation.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: message },
    ]

    // 4. Call Claude — tool loop with iteration cap
    const MAX_TOOL_ITERATIONS = 3
    let iterations = 0
    let currentMessages = messages
    let response = await this.callClaude(currentMessages, dataCtx, memoriesCtx)

    while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
      const toolBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      if (!toolBlock) break

      const toolName = toolBlock.name
      const toolInput = toolBlock.input as Record<string, unknown>

      // Action tool → defer execution to confirmAction()
      if (ACTION_TOOLS.has(toolName)) {
        await this.prisma.aiMessage.create({
          data: { conversationId: conversation.id, role: 'user', content: message },
        })
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        })
        const needsDoubleConfirm = requiresDoubleConfirmation(toolName, toolInput)
        return {
          reply: '',
          conversationId: conversation.id,
          pendingAction: {
            toolName,
            toolInput,
            ...this.buildConfirmation(toolName, toolInput),
            ...(needsDoubleConfirm ? { requiresDoubleConfirm: true } : {}),
          },
        }
      }

      // Read tool → execute immediately and feed result back
      let toolResult: unknown
      try {
        toolResult = await this.toolExecutor.executeTool(
          toolName,
          toolBlock.input as Record<string, unknown>,
          organizationId,
          userId,
          userRole,
        )
      } catch (err) {
        toolResult = {
          success: false,
          message: err instanceof Error ? err.message : 'Fel vid verktygsanrop',
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

      response = await this.callClaude(currentMessages, dataCtx, memoriesCtx)
      iterations++
    }

    // end_turn or max iterations reached — extract text reply
    return this.handleTextResponse(
      response,
      currentMessages,
      conversation.id,
      message,
      organizationId,
      userId,
    )
  }

  async confirmAction(
    toolName: string,
    toolInput: Record<string, unknown>,
    conversationId: string,
    confirmed: boolean,
    organizationId: string,
    userId: string,
    userRole: string,
  ): Promise<ChatResponse> {
    // Verify conversation exists
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, organizationId },
    })
    if (!conversation) throw new NotFoundException('Konversation hittades inte')

    if (!confirmed) {
      const cancelMsg = 'Okej, åtgärden avbröts. Kan jag hjälpa dig med något annat?'
      await this.prisma.aiMessage.create({
        data: { conversationId, role: 'assistant', content: cancelMsg },
      })
      await this.prisma.aiConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      })
      return { reply: cancelMsg, conversationId }
    }

    // Double confirmation: re-prompt with high-risk warning if not yet warned
    if (requiresDoubleConfirmation(toolName, toolInput) && !toolInput.alreadyWarned) {
      const doubleConfirmInput = { ...toolInput, alreadyWarned: true }
      return {
        reply: '',
        conversationId,
        pendingAction: {
          toolName,
          toolInput: doubleConfirmInput,
          requiresDoubleConfirm: true,
          ...this.buildConfirmation(toolName, doubleConfirmInput),
        },
      }
    }

    // Execute
    let result
    try {
      result = await this.toolExecutor.executeTool(
        toolName,
        toolInput,
        organizationId,
        userId,
        userRole,
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Okänt fel'
      const failMsg = `Åtgärden misslyckades: ${errMsg}`
      await this.prisma.aiMessage.create({
        data: { conversationId, role: 'assistant', content: failMsg },
      })
      return { reply: failMsg, conversationId }
    }

    // If create_invoice couldn't find tenant, return suggestion message so Claude can follow up
    if (!result.success && result.suggestCreateTenant) {
      await this.prisma.aiMessage.create({
        data: { conversationId, role: 'assistant', content: result.message },
      })
      await this.prisma.aiConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      })
      return { reply: result.message, conversationId }
    }

    const reply = result.success ? result.message : `Åtgärden misslyckades: ${result.message}`

    await this.prisma.aiMessage.create({
      data: { conversationId, role: 'assistant', content: reply },
    })
    await this.prisma.aiConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    })

    return {
      reply,
      conversationId,
      ...(result.downloadUrl ? { downloadUrl: result.downloadUrl } : {}),
    }
  }

  // ── Conversation management ────────────────────────────────────────────────

  async getConversations(organizationId: string, userId: string) {
    return this.prisma.aiConversation.findMany({
      where: { organizationId, userId },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })
  }

  async getConversation(organizationId: string, userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, organizationId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (!conversation) throw new NotFoundException('Konversation hittades inte')
    return conversation
  }

  async deleteConversation(organizationId: string, userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, organizationId, userId },
    })
    if (!conversation) throw new NotFoundException('Konversation hittades inte')
    await this.prisma.aiConversation.delete({ where: { id: conversationId } })
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getOrCreateConversation(
    organizationId: string,
    userId: string,
    message: string,
    conversationId?: string,
  ) {
    if (conversationId) {
      const conv = await this.prisma.aiConversation.findFirst({
        where: { id: conversationId, organizationId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      })
      if (!conv) throw new NotFoundException('Konversation hittades inte')
      return conv
    }

    const title = message.length > 60 ? message.slice(0, 57) + '...' : message
    return this.prisma.aiConversation.create({
      data: { organizationId, userId, title },
      include: { messages: true },
    })
  }

  private async callClaude(
    messages: Anthropic.MessageParam[],
    dataCtx: string,
    memoriesCtx: string,
  ): Promise<Anthropic.Message> {
    const memorySection = memoriesCtx ? `\n\n${memoriesCtx}` : ''
    try {
      return await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: `${SYSTEM_PROMPT}\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}${memorySection}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: TOOLS,
        messages,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Okänt fel'
      throw new ServiceUnavailableException(`Kunde inte nå Claude API: ${msg}`)
    }
  }

  private extractText(response: Anthropic.Message): string {
    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    return block?.text ?? 'Inget svar från AI.'
  }

  private async handleTextResponse(
    response: Anthropic.Message,
    _messages: Anthropic.MessageParam[],
    conversationId: string,
    userMessage: string,
    organizationId: string,
    userId: string,
  ): Promise<ChatResponse> {
    const reply = this.extractText(response)

    await this.prisma.aiMessage.createMany({
      data: [
        { conversationId, role: 'user', content: userMessage },
        { conversationId, role: 'assistant', content: reply },
      ],
    })
    await this.prisma.aiConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    })

    // Fire-and-forget: extract facts from this exchange and persist them
    void this.memory
      .extractAndSaveMemories(userMessage, reply, organizationId, userId)
      .catch((err: unknown) => {
        this.logger.warn('Memory extraction failed', err)
      })

    return { reply, conversationId }
  }

  private buildConfirmation(
    toolName: string,
    input: Record<string, unknown>,
  ): { confirmationMessage: string; details: Record<string, string> } {
    const safeAmountStr = (v: unknown): string => {
      if (typeof v === 'number') return v.toFixed(0)
      const n = parseFloat(String(v).replace(/[^\d.]/g, ''))
      return isNaN(n) ? String(v) : n.toFixed(0)
    }

    switch (toolName) {
      case 'create_invoice':
        return {
          confirmationMessage: `Skapa faktura på ${safeAmountStr(input.amount)} kr för ${input.tenantName as string} med förfallodatum ${input.dueDate as string}`,
          details: {
            Hyresgäst: input.tenantName as string,
            Belopp: `${safeAmountStr(input.amount)} kr`,
            Typ: (input.type as string | undefined) ?? 'AUTO',
            Förfallodatum: input.dueDate as string,
            Beskrivning: input.description as string,
          },
        }

      case 'create_bulk_invoices':
        return {
          confirmationMessage: `Skapa hyresfakturor för alla aktiva kontrakt, månad ${input.month as number}/${input.year as number}`,
          details: {
            Månad: `${input.month as number}/${input.year as number}`,
            Momssats: `${(input.vatRate as number | undefined) ?? 0}%`,
          },
        }

      case 'create_tenant':
        return {
          confirmationMessage: `Skapa hyresgäst ${(input.firstName as string | undefined) ?? (input.companyName as string | undefined) ?? ''} (${input.email as string})`,
          details: {
            Typ: input.type === 'INDIVIDUAL' ? 'Privatperson' : 'Företag',
            Namn:
              input.type === 'INDIVIDUAL'
                ? `${(input.firstName as string | undefined) ?? ''} ${(input.lastName as string | undefined) ?? ''}`.trim()
                : ((input.companyName as string | undefined) ?? ''),
            'E-post': input.email as string,
            ...(input.phone ? { Telefon: input.phone as string } : {}),
          },
        }

      case 'update_tenant':
        return {
          confirmationMessage: `Uppdatera kontaktinfo för ${input.tenantName as string}`,
          details: {
            Hyresgäst: input.tenantName as string,
            ...(input.email ? { 'Ny e-post': input.email as string } : {}),
            ...(input.phone ? { 'Ny telefon': input.phone as string } : {}),
          },
        }

      case 'send_invoice_email':
        return {
          confirmationMessage: `Skicka faktura ${input.invoiceNumber as string} via e-post till ${input.tenantEmail as string}`,
          details: {
            Fakturanummer: input.invoiceNumber as string,
            Mottagare: input.tenantEmail as string,
          },
        }

      case 'send_overdue_reminders': {
        const ids = input.invoiceIds as string[] | undefined
        return {
          confirmationMessage: `Skicka betalningspåminnelser till hyresgäster med förfallna fakturor`,
          details: {
            Fakturor: ids && ids.length > 0 ? `${ids.length} valda` : 'Alla förfallna',
          },
        }
      }

      case 'mark_invoice_paid':
        return {
          confirmationMessage: `Markera faktura ${input.invoiceNumber as string} som betald (${safeAmountStr(input.amount)} kr)`,
          details: {
            Fakturanummer: input.invoiceNumber as string,
            Belopp: `${safeAmountStr(input.amount)} kr`,
            ...(input.paymentDate ? { Betalningsdatum: input.paymentDate as string } : {}),
          },
        }

      case 'create_lease':
        return {
          confirmationMessage: `Skapa kontrakt för ${input.tenantName as string} i ${input.unitName as string}, ${safeAmountStr(input.monthlyRent)} kr/mån`,
          details: {
            Hyresgäst: input.tenantName as string,
            Enhet: input.unitName as string,
            Hyra: `${safeAmountStr(input.monthlyRent)} kr/mån`,
            Startdatum: input.startDate as string,
            ...(input.endDate
              ? { Slutdatum: input.endDate as string }
              : { Slutdatum: 'Tillsvidare' }),
          },
        }

      case 'transition_lease_status':
        return {
          confirmationMessage: `${input.newStatus === 'ACTIVE' ? 'Aktivera' : 'Avsluta'} kontrakt för ${input.tenantName as string}`,
          details: {
            Hyresgäst: input.tenantName as string,
            Åtgärd: input.newStatus === 'ACTIVE' ? 'Aktivera kontrakt' : 'Avsluta kontrakt',
            ...(input.reason ? { Anledning: input.reason as string } : {}),
          },
        }

      case 'create_property':
        return {
          confirmationMessage: `Skapa fastighet "${input.name as string}" på ${input.street as string}, ${input.city as string}`,
          details: {
            Namn: input.name as string,
            Beteckning: input.propertyDesignation as string,
            Typ: input.type as string,
            Adress: `${input.street as string}, ${input.postalCode as string} ${input.city as string}`,
          },
        }

      case 'create_unit':
        return {
          confirmationMessage: `Skapa enhet "${input.name as string}" i ${input.propertyName as string}, hyra ${safeAmountStr(input.monthlyRent)} kr/mån`,
          details: {
            Fastighet: input.propertyName as string,
            Enhetsnummer: input.unitNumber as string,
            Namn: input.name as string,
            Typ: input.type as string,
            Hyra: `${safeAmountStr(input.monthlyRent)} kr/mån`,
            Area: `${input.area as number} m²`,
          },
        }

      case 'export_sie4':
        return {
          confirmationMessage: `Exportera SIE4-bokföringsfil för perioden ${input.from as string} till ${input.to as string}`,
          details: {
            Från: input.from as string,
            Till: input.to as string,
          },
        }

      case 'compose_and_send_email': {
        const emailIds = input.tenantIds as string[]
        const emailNames = (input.tenantNames as string[] | undefined) ?? emailIds
        const bodyPreview = (input.body as string).slice(0, 120)
        return {
          confirmationMessage: `Skicka e-post "${input.subject as string}" till ${emailNames.join(', ')}`,
          details: {
            Ämne: input.subject as string,
            Typ: input.emailType as string,
            Mottagare: emailNames.join(', '),
            'Antal mottagare': String(emailIds.length),
            Förhandsgranskning: bodyPreview + (bodyPreview.length >= 120 ? '...' : ''),
          },
        }
      }

      case 'apply_rent_increase':
        return {
          confirmationMessage: `Uppdatera hyra för ${input.tenantName as string}: ${(input.currentRent as number).toLocaleString('sv-SE')} kr → ${(input.newRent as number).toLocaleString('sv-SE')} kr/mån från ${input.effectiveDate as string}`,
          details: {
            Hyresgäst: input.tenantName as string,
            'Nuvarande hyra': `${(input.currentRent as number).toLocaleString('sv-SE')} kr/mån`,
            'Ny hyra': `${(input.newRent as number).toLocaleString('sv-SE')} kr/mån`,
            'Gäller från': input.effectiveDate as string,
            'Skicka brev': input.sendNotification ? 'Ja' : 'Nej',
          },
        }

      case 'create_tenant_and_lease': {
        const name =
          input.tenantType === 'INDIVIDUAL'
            ? `${(input.firstName as string | undefined) ?? ''} ${(input.lastName as string | undefined) ?? ''}`.trim()
            : ((input.companyName as string | undefined) ?? (input.email as string))
        return {
          confirmationMessage: `Skapa kontrakt för ${name} i ${input.unitName as string}, ${input.propertyName as string}`,
          details: {
            Hyresgäst: `${name} (${input.email as string})`,
            Lägenhet: `${input.unitName as string}, ${input.propertyName as string}`,
            Hyra: `${(input.monthlyRent as number).toLocaleString('sv-SE')} kr/mån`,
            Startdatum: input.startDate as string,
            Kontraktsform: input.endDate ? `T.o.m. ${input.endDate as string}` : 'Tillsvidare',
            Deposition: `${((input.depositAmount as number | undefined) ?? 0).toLocaleString('sv-SE')} kr`,
          },
        }
      }

      case 'create_tenant_and_invoice': {
        const newTenantName =
          input.tenantType === 'INDIVIDUAL'
            ? `${(input.tenantFirstName as string | undefined) ?? ''} ${(input.tenantLastName as string | undefined) ?? ''}`.trim()
            : ((input.tenantCompanyName as string | undefined) ?? (input.tenantEmail as string))
        return {
          confirmationMessage: `Skapa ny hyresgäst "${newTenantName}" och faktura på ${safeAmountStr(input.amount)} kr`,
          details: {
            'Ny hyresgäst': newTenantName,
            'E-post': input.tenantEmail as string,
            Typ: (input.tenantType as string) === 'INDIVIDUAL' ? 'Privatperson' : 'Företag',
            Belopp: `${safeAmountStr(input.amount)} kr`,
            Förfallodatum: input.dueDate as string,
            Beskrivning: input.description as string,
          },
        }
      }

      default:
        return {
          confirmationMessage: `Utför åtgärd: ${toolName}`,
          details: {},
        }
    }
  }

  // ── Proactive insights ─────────────────────────────────────────────────────

  async generateDailyInsights(organizationId: string): Promise<string> {
    const dataCtx = await this.dataContext.buildContext(organizationId)
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: `Du är Eken AI – en intelligent fastighetsassistent för svenska fastighetsförvaltare.\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}`,
      messages: [
        {
          role: 'user',
          content:
            'Baserat på denna data, ge en kort morgonsammanfattning (max 4 punkter) med de viktigaste sakerna att hantera idag. Fokusera på: förfallna fakturor, kontrakt som löper ut snart, ovanliga mönster. Var konkret med siffror. Format: bullet points på svenska, ett per rad.',
        },
      ],
    })
    const content = response.content[0]
    return content?.type === 'text' ? content.text : ''
  }
}
