import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Anthropic from '@anthropic-ai/sdk'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { DataContextService } from './data-context.service'
import { ToolExecutorService } from './tools/tool-executor.service'
import { MemoryService } from './memory.service'
import { AiUsageService } from './usage/ai-usage.service'
import { AiQuotaService } from './usage/ai-quota.service'
import { AiAuditService } from './audit/ai-audit.service'
import { TOOLS, ACTION_TOOLS } from './tools/ai-tools.definition'
import { AI_MODELS } from './ai.config'

const MAX_TOKENS = 2048

// ─── Sliding window för långa konversationer ─────────────────────────────────
// För korta konversationer (≤ SLIDING_WINDOW_THRESHOLD) skickas hela historiken
// till Claude som tidigare — ingen beteendeförändring. Vid längre konversationer
// behålls de senaste SLIDING_WINDOW_KEEP_RECENT meddelandena i sin helhet, och
// allt äldre sammanfattas av Haiku till en kort svensk briefing som injiceras
// som ett (user, assistant)-par i början. Sammanfattningen cachas på
// AiConversation.summary och regenereras först när ≥ SUMMARY_CACHE_THRESHOLD
// nya meddelanden hamnat i "old"-tiern. Detta sparar både tokens och tid på
// power-user-konversationer (200 meddelanden: ~100k → ~8k tokens per turn).
const SLIDING_WINDOW_THRESHOLD = 30
const SLIDING_WINDOW_KEEP_RECENT = 20
const SUMMARY_CACHE_THRESHOLD = 10
const SUMMARY_MAX_TOKENS = 500
const SUMMARY_ACK_TEXT = 'Förstått, jag har sammanhanget från tidigare. Fortsätter samtalet.'

export const SYSTEM_PROMPT = `Du är Sveriges bästa AI-assistent för fastighetsförvaltning. Du kombinerar djup juridisk och ekonomisk kunskap med tillgång till användarens egna data.

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
- 2611 Utgående moms 25% (lokaler)
- 2621 Utgående moms 12%
- 2631 Utgående moms 6%
- 3911 Hyresintäkter, bostäder (momsfria, ML 3 kap 2 §)
- 3912 Hyresintäkter, parkeringsplatser
- 3913 Hyresintäkter, lokaler (momspliktiga vid frivillig skattskyldighet)
- 3914 Hyresintäkter, övriga (förråd m.m.)
- 2890 Mottagna depositioner (skuld till hyresgäst)
- 4010 Reparation och underhåll
- 5010 Fastighetsskötsel
- 6212 Fastighetsskatt

MOMS:
- Bostäder: MOMSFRIA (0%)
- Lokaler: kan vara momspliktiga (25%) om frivillig skattskyldighet
- Lokaler kan vara momspliktiga om uthyraren är frivilligt momsregistrerad enligt Mervärdesskattelagen 9 kap. 1 §
- Frivillig skattskyldighet: måste ansökas hos Skatteverket
- Fördel: kan dra av ingående moms på kostnader
- Nackdel: hyresgästen betalar 25% mer i hyra

FASTIGHETSSKATT OCH AVGIFTER:
- Småhus: kommunal fastighetsavgift max 9 525 kr/år (2026)
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
- Förfallodatum: sista vardagen FÖRE den månad hyran avser, enligt Hyreslagen 12:20 JB. Helger och röda dagar hoppas över automatiskt.
- Följ upp obetalda avier efter förfallodatum
- Använd get_rent_notices för att visa aktuella avier

## Bokföring och bankavstämning
Du har nu verktyg för att hantera bankavstämning och bokföring direkt. När
användaren ber om hjälp med betalningar:
- Använd get_unmatched_transactions för att se vad som är omatchat
- Föreslå match_bank_transaction för uppenbara matchningar (samma OCR/belopp)
- Importera BgMax-filer med import_bgmax_file när användaren skickar dem
- Använd get_reconciliation_summary för en snabb statusbild

För bokföring:
- Använd get_profit_loss_report för månads/årsanalys
- get_vat_report för momsrapportering inför Skatteverket-deklaration
- get_balance_sheet för aktuell ekonomisk ställning
- get_account_balance vid frågor om saldon på enskilda BAS-konton
- Föreslå create_journal_entry för manuella verifikat (kräver att debet = kredit)
- Använd record_expense för enkla utgifter (bokar mot kostnadskonto + bank)
- close_period för att stänga en bokföringsmånad — varna att den inte kan
  återöppnas via systemet

VIKTIGT: All bokföring följer BAS-2026 kontoplanen. Alla momsberäkningar
följer svensk Mervärdesskattelag. Bostäder är alltid momsfria.

VANLIGA BAS-KONTON FÖR FASTIGHETSFÖRVALTNING:
- 1510 Kundfordringar
- 1930 Företagskonto / Bank
- 2611 Utgående moms 25%
- 2621 Utgående moms 12%
- 2631 Utgående moms 6%
- 2641 Ingående moms
- 3911 Hyresintäkter, bostäder (momsfri, ML 3 kap 2 §)
- 3912 Hyresintäkter, parkeringsplatser
- 3913 Hyresintäkter, lokaler (momspliktiga vid frivillig skattskyldighet)
- 3914 Hyresintäkter, övriga (förråd m.m.)
- 3593 Påminnelseavgifter (intäkt vid formell påminnelse)
- 5070 Reparation och underhåll
- 5080 Försäkring fastighet
- 6212 Fastighetsskatt
- 8410 Räntekostnader

## Påminnelser och inkasso
Eveno hanterar automatiska påminnelser:
- Dag 1-7: Vänlig påminnelse (ingen avgift)
- Dag 14: Formell påminnelse + 60 kr avgift enligt lag (1981:739) om
  ersättning för inkassokostnader. Avgiften bokförs på BAS 3593 och
  läggs på fakturan som ny rad.
- Dag 30: Markeras som "redo för inkasso" — fastighetsägaren får notis
  i appen, men hyresgästen får INGET nytt mejl från Eveno

Eveno är INTE ett inkassobolag. Vid dag 30 förbereder systemet ett
inkasso-underlag (PDF + CSV) som fastighetsägaren skickar till sitt
valda inkassobolag (t.ex. Visma Collectors, Intrum, Lindorff).

Verktyg:
- get_overdue_status — översikt av alla förfallna fakturor
- pause_reminders — pausa när hyresgästen avtalat avbetalningsplan
- resume_reminders — återuppta om planen bryts
- export_for_collection — skapa PDF + CSV-underlag
- mark_sent_to_collection — om fastighetsägaren använt externt verktyg

VIKTIGT: Lova ALDRIG hyresgästen att avgift kan tas bort. Lova ALDRIG på
fastighetsägarens vägnar att inkassoärendet kan stoppas — det hanteras
av inkassobolaget. Föreslå pause_reminders när det är meningsfullt
(avbetalningsplan, dialog pågår), men exekvera bara efter användarens
explicita godkännande.

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
Hyresgäster kan inte skapas fristående – varje hyresgäst måste registreras
mot en enhet via ett kontrakt. Om create_invoice misslyckas med
"hyresgäst hittades inte":
1. Be användaren först skapa kontraktet med create_tenant_and_lease
2. Återkom sedan med fakturan när kontraktet är på plats

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

export function requiresDoubleConfirmation(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // Large single invoice (>50 000 kr)
  if (toolName === 'create_invoice') {
    const raw = String(toolInput.amount ?? '0').replace(/[^\d.]/g, '')
    const amount = parseFloat(raw)
    if (!isNaN(amount) && amount > 50000) return true
  }
  // Bulk invoices always require double confirmation
  if (toolName === 'create_bulk_invoices') return true
  // Lease termination
  if (toolName === 'transition_lease_status' && toolInput.newStatus === 'TERMINATED') return true
  // Stora manuella verifikat (> 100 000 kr)
  if (toolName === 'create_journal_entry') {
    const lines = toolInput.lines as Array<{ debit?: number; credit?: number }> | undefined
    if (Array.isArray(lines)) {
      const sum = lines.reduce((acc, l) => {
        const debit = typeof l.debit === 'number' && l.debit > 0 ? l.debit : 0
        return acc + debit
      }, 0)
      if (sum > 100000) return true
    }
  }
  // Stora utgiftsbokningar (> 100 000 kr)
  if (toolName === 'record_expense') {
    const amount =
      typeof toolInput.amount === 'number'
        ? toolInput.amount
        : parseFloat(String(toolInput.amount ?? '0').replace(/[^\d.]/g, ''))
    if (!isNaN(amount) && amount > 100000) return true
  }
  // Period-stängning är irreversibel — kräv alltid dubbelbekräftelse
  if (toolName === 'close_period') return true
  // Inkasso-export skickar fakturan till externt inkassobolag — irreversibel
  // status och hyresgästen kan få inkassokrav. Kräv dubbelbekräftelse.
  if (toolName === 'export_for_collection') return true
  if (toolName === 'mark_sent_to_collection') return true
  // Avmatchning av äldre transaktioner — om matchningen är gammal kan det
  // krocka med redan stängda perioder eller bokslutsarbete.
  if (toolName === 'unmatch_transaction') {
    const matchedAt = toolInput.matchedAt
    if (typeof matchedAt === 'string') {
      const matched = new Date(matchedAt)
      const days = (Date.now() - matched.getTime()) / (24 * 60 * 60 * 1000)
      if (Number.isFinite(days) && days > 30) return true
    }
  }
  // Bulk-mejl till > 10 mottagare kräver dubbelbekräftelse för att skydda
  // mot oavsiktliga massutskick. Hård gräns (>50) och cooldown (1/15 min
  // för bulk-utskick > 5 mottagare) hanteras separat i tool-executor.
  if (toolName === 'compose_and_send_email') {
    const ids = toolInput.tenantIds
    if (Array.isArray(ids) && ids.length > 10) return true
  }
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
    private readonly usage: AiUsageService,
    private readonly quota: AiQuotaService,
    private readonly audit: AiAuditService,
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

    // 0. Kvot-kontroll innan vi spenderar pengar.
    //    checkQuota() täcker plan-räknaren + org-wide daglig kostnadscap.
    //    checkUserDailyCostCap() lägger till per-user daglig cap för
    //    manuella anrop (50 SEK/dag default).
    await this.quota.checkQuota(organizationId)
    await this.quota.checkUserDailyCostCap(organizationId, userId)

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

    // 3. Build message history via gemensam helper som hanterar både
    //    blocks-fallback (FAS 3) och sliding window för långa konversationer
    //    (FAS 4). Korta konversationer (≤30 meddelanden) returnerar
    //    historiken oförändrad — ingen beteendeskillnad.
    const history = await this.buildMessageHistoryForClaude(conversation)
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user' as const, content: message },
    ]

    // 4. Call Claude — tool loop with iteration cap
    const MAX_TOOL_ITERATIONS = 3
    let iterations = 0
    let currentMessages = messages
    let response = await this.callClaude(
      currentMessages,
      dataCtx,
      memoriesCtx,
      organizationId,
      userId,
    )

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
        await this.enrichDoubleConfirmContext(toolName, toolInput, organizationId)
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
          { conversationId: conversation.id },
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

      response = await this.callClaude(
        currentMessages,
        dataCtx,
        memoriesCtx,
        organizationId,
        userId,
      )
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
    // Verify conversation exists. SECURITY (AI-IDOR): scope även på userId —
    // annars kunde en användare inom samma org bekräfta en annan användares
    // pending action (exekvera en åtgärd i den andras namn) genom att gissa/
    // läcka ett conversationId. Samma ägarskapskontroll som deleteConversation.
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, organizationId, userId },
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

    // Execute — märker att åtgärden krävde och fick bekräftelse av användaren
    let result
    try {
      result = await this.toolExecutor.executeTool(
        toolName,
        toolInput,
        organizationId,
        userId,
        userRole,
        { conversationId, confirmedAt: new Date() },
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
      // SECURITY (AI-IDOR): scope på userId så att en användare inte kan
      // fortsätta (eller läsa historik ur) en annan användares konversation
      // inom samma org. Samma kontroll som getConversation/deleteConversation.
      const conv = await this.prisma.aiConversation.findFirst({
        where: { id: conversationId, organizationId, userId },
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
    organizationId: string,
    userId: string,
  ): Promise<Anthropic.Message> {
    const memorySection = memoriesCtx ? `\n\n${memoriesCtx}` : ''
    const dateContext = this.dataContext.getCurrentDateContext()
    try {
      const response = await this.client.messages.create({
        model: AI_MODELS.CHAT,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: `${SYSTEM_PROMPT}\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}${memorySection}`,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: dateContext,
          },
        ],
        tools: TOOLS,
        messages,
      })
      // Logga kostnad — fire-and-forget. Loggning får aldrig blockera AI:n.
      void this.usage
        .logUsage({
          organizationId,
          userId,
          endpoint: 'chat',
          model: AI_MODELS.CHAT,
          usage: response.usage,
          isAutomated: false,
          source: 'manual_chat',
        })
        .catch((err: unknown) => this.logger.warn('logUsage(chat) failed', err))
      return response
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Okänt fel'
      throw new ServiceUnavailableException(`Kunde inte nå Claude API: ${msg}`)
    }
  }

  /**
   * Bygger meddelandehistoriken som skickas till Claude. För korta
   * konversationer (≤ SLIDING_WINDOW_THRESHOLD meddelanden) returneras
   * hela historiken direkt — IDENTISKT beteende som tidigare.
   *
   * För längre konversationer aktiveras sliding window:
   *  - de senaste SLIDING_WINDOW_KEEP_RECENT meddelandena behålls i sin helhet
   *  - allt äldre ersätts av en Haiku-genererad sammanfattning (cachad i DB)
   *  - sammanfattningen levereras som ett (user, assistant)-par för att hålla
   *    konversationsflödet välformat
   *
   * Returnerar HISTORIK utan det nya user-meddelandet — caller appendar det
   * själv (samma mönster som tidigare).
   */
  async buildMessageHistoryForClaude(conversation: {
    id: string
    organizationId: string
    summary: string | null
    summarizedUpToMessageId: string | null
    messages: Array<{ id: string; role: string; content: string; blocks: Prisma.JsonValue | null }>
  }): Promise<Anthropic.MessageParam[]> {
    const allMessages = conversation.messages

    const toClaude = (m: {
      role: string
      content: string
      blocks: Prisma.JsonValue | null
    }): Anthropic.MessageParam => ({
      role: m.role as 'user' | 'assistant',
      content: Array.isArray(m.blocks)
        ? (m.blocks as unknown as Anthropic.ContentBlockParam[])
        : m.content,
    })

    // Kort konversation → ingen window, samma beteende som idag.
    if (allMessages.length <= SLIDING_WINDOW_THRESHOLD) {
      return allMessages.map(toClaude)
    }

    // Lång konversation → splittra i recent + old.
    const recentMessages = allMessages.slice(-SLIDING_WINDOW_KEEP_RECENT)
    const oldMessages = allMessages.slice(0, allMessages.length - SLIDING_WINDOW_KEEP_RECENT)
    const lastOldId = oldMessages[oldMessages.length - 1]?.id ?? null

    // Avgör om vi behöver regenerera sammanfattningen.
    // Stale om: ingen cachad summary, ingen pekare, eller ≥ THRESHOLD meddelanden
    // har lagts till efter den senast cachade.
    let summaryIsStale = !conversation.summary || !conversation.summarizedUpToMessageId
    if (!summaryIsStale && conversation.summarizedUpToMessageId) {
      const idx = oldMessages.findIndex((m) => m.id === conversation.summarizedUpToMessageId)
      const messagesSinceCache = idx < 0 ? oldMessages.length : oldMessages.length - 1 - idx
      if (messagesSinceCache >= SUMMARY_CACHE_THRESHOLD) {
        summaryIsStale = true
      }
    }

    let summary = conversation.summary
    if (summaryIsStale && lastOldId) {
      summary = await this.summarizeOldMessages(oldMessages, conversation.organizationId)
      await this.prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { summary, summarizedUpToMessageId: lastOldId },
      })
    }

    // Bygg upp sliding-window-historiken. Summary injiceras som ett
    // (user, assistant)-par så Claude ser flödet som naturligt.
    const summaryText = summary ?? '(Ingen sammanfattning tillgänglig.)'
    return [
      {
        role: 'user' as const,
        content: `[Tidigare i detta samtal (sammanfattning):]\n${summaryText}\n\n[Slutet av tidigare kontext. Fortsätt samtalet nedan.]`,
      },
      {
        role: 'assistant' as const,
        content: SUMMARY_ACK_TEXT,
      },
      ...recentMessages.map(toClaude),
    ]
  }

  /**
   * Sammanfattar gamla meddelanden via Haiku (billig, snabb modell).
   * Returnerar en kort svensk briefing som behåller viktiga fakta,
   * beslut och referenser till fastigheter/hyresgäster/fakturor.
   */
  private async summarizeOldMessages(
    oldMessages: Array<{ role: string; content: string }>,
    organizationId: string,
  ): Promise<string> {
    const transcript = oldMessages
      .map((m) => `${m.role === 'user' ? 'Användare' : 'AI'}: ${m.content}`)
      .join('\n\n')

    try {
      const response = await this.client.messages.create({
        model: AI_MODELS.MEMORY,
        max_tokens: SUMMARY_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: `Sammanfatta följande konversation mellan en fastighetsförvaltare och en AI-assistent. Skriv på svenska, koncist (max 200 ord), som en briefing till en AI som tar över samtalet. Behåll viktiga fakta, beslut och referenser till specifika fastigheter, hyresgäster, fakturor och belopp. Använd punkter eller korta meningar.\n\nKONVERSATION:\n${transcript}\n\nSAMMANFATTNING:`,
          },
        ],
      })

      void this.usage
        .logUsage({
          organizationId,
          endpoint: 'memory',
          model: AI_MODELS.MEMORY,
          usage: response.usage,
          isAutomated: true,
          source: 'sliding_window_summary',
        })
        .catch(() => undefined)

      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
      return textBlock?.text.trim() ?? '(Sammanfattning kunde inte genereras.)'
    } catch (err) {
      this.logger.warn(
        `Sliding-window summary failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return '(Sammanfattning kunde inte genereras — fortsätt med försiktighet.)'
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

    // Spara user + assistant separat så assistant-raden kan få `blocks`
    // (Anthropic ContentBlock[] från final-turn). Backwards-compatible:
    // user-raden får ingen blocks-kolumn satt, gamla rader får NULL.
    await this.prisma.aiMessage.create({
      data: { conversationId, role: 'user', content: userMessage },
    })
    await this.prisma.aiMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: reply,
        blocks: response.content as unknown as Prisma.InputJsonValue,
      },
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

  /**
   * Slå upp DB-fält som requiresDoubleConfirmation behöver men som AI:n inte
   * själv vet (t.ex. när en bank-match faktiskt skedde). Muterar toolInput
   * in-place så pendingAction får dessa fält tillgängliga.
   */
  async enrichDoubleConfirmContext(
    toolName: string,
    toolInput: Record<string, unknown>,
    organizationId: string,
  ): Promise<void> {
    if (toolName === 'unmatch_transaction' && typeof toolInput.transactionId === 'string') {
      const tx = await this.prisma.bankTransaction.findFirst({
        where: { id: toolInput.transactionId, organizationId },
        select: { matchedAt: true, date: true },
      })
      const reference = tx?.matchedAt ?? tx?.date ?? null
      if (reference) {
        toolInput.matchedAt = reference.toISOString()
      }
    }
  }

  buildConfirmation(
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

      case 'match_bank_transaction':
        return {
          confirmationMessage: `Matcha banktransaktion mot faktura och bokför betalningen`,
          details: {
            'Transaktion-ID': String(input.transactionId ?? ''),
            'Faktura-ID': String(input.invoiceId ?? ''),
          },
        }

      case 'import_bgmax_file': {
        const fileContent = String(input.fileContent ?? '')
        const sizeKb = fileContent
          ? (Buffer.byteLength(fileContent, 'utf8') / 1024).toFixed(1)
          : '0'
        return {
          confirmationMessage: `Importera BgMax-fil och auto-matcha mot fakturor`,
          details: {
            Filnamn: String(input.fileName ?? 'okänd'),
            Storlek: `${sizeKb} kB (base64)`,
          },
        }
      }

      case 'unmatch_transaction': {
        const matchedAt = typeof input.matchedAt === 'string' ? input.matchedAt : null
        return {
          confirmationMessage: `Ångra matchning av banktransaktion (motverifikat skapas)`,
          details: {
            'Transaktion-ID': String(input.transactionId ?? ''),
            Anledning: String(input.reason ?? '–'),
            ...(matchedAt ? { 'Matchad sedan': matchedAt.slice(0, 10) } : {}),
          },
        }
      }

      case 'create_journal_entry': {
        const lines = (input.lines as Array<{ debit?: number; credit?: number }> | undefined) ?? []
        const totalDebit = lines.reduce(
          (acc, l) => acc + (typeof l.debit === 'number' && l.debit > 0 ? l.debit : 0),
          0,
        )
        return {
          confirmationMessage: `Skapa manuellt verifikat: ${String(input.description ?? '')}`,
          details: {
            Datum: String(input.date ?? ''),
            Beskrivning: String(input.description ?? ''),
            'Antal rader': String(lines.length),
            Summa: `${totalDebit.toLocaleString('sv-SE')} kr`,
          },
        }
      }

      case 'record_expense':
        return {
          confirmationMessage: `Bokför utgift: ${String(input.description ?? '')}`,
          details: {
            Datum: String(input.date ?? ''),
            Belopp: `${safeAmountStr(input.amount)} kr`,
            'Varav moms':
              input.vatAmount !== undefined ? `${safeAmountStr(input.vatAmount)} kr` : '0 kr',
            Konto: String(input.accountNumber ?? ''),
            Beskrivning: String(input.description ?? ''),
          },
        }

      case 'close_period':
        return {
          confirmationMessage: `Stäng bokföringsperioden ${String(input.year ?? '')}-${String(input.month ?? '').padStart(2, '0')} (kan inte återöppnas via systemet)`,
          details: {
            Period: `${String(input.year ?? '')}-${String(input.month ?? '').padStart(2, '0')}`,
            Effekt: 'Inga nya verifikat kan skapas med datum inom perioden',
          },
        }

      case 'pause_reminders': {
        const reason = typeof input.reason === 'string' ? input.reason : '–'
        return {
          confirmationMessage: `Pausa automatiska påminnelser för faktura ${String(input.invoiceNumber ?? '–')}`,
          details: {
            Faktura: String(input.invoiceNumber ?? input.invoiceId ?? ''),
            Anledning: reason,
            Effekt: 'Inga nya påminnelser skickas tills du återupptar dem',
          },
        }
      }

      case 'resume_reminders':
        return {
          confirmationMessage: `Återuppta påminnelser för faktura ${String(input.invoiceNumber ?? input.invoiceId ?? '–')}`,
          details: {
            Faktura: String(input.invoiceNumber ?? input.invoiceId ?? ''),
            Effekt: 'Påminnelser återupptas vid nästa cron kl 09:00',
          },
        }

      case 'export_for_collection':
        return {
          confirmationMessage: `Skapa inkassounderlag för faktura ${String(input.invoiceNumber ?? input.invoiceId ?? '–')}`,
          details: {
            Faktura: String(input.invoiceNumber ?? input.invoiceId ?? ''),
            Resultat: 'PDF + CSV-underlag att skicka till ditt inkassobolag',
            Status: 'Fakturan markeras SENT_TO_COLLECTION och påminnelser pausas',
          },
        }

      case 'mark_sent_to_collection':
        return {
          confirmationMessage: `Markera faktura ${String(input.invoiceNumber ?? input.invoiceId ?? '–')} som skickad till externt inkassobolag`,
          details: {
            Faktura: String(input.invoiceNumber ?? input.invoiceId ?? ''),
            ...(input.note ? { Notering: String(input.note) } : {}),
            Effekt: 'Påminnelser pausas, status sätts till SENT_TO_COLLECTION',
          },
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
    // Kostnadscap-kontroll: morgonrapporten är ett automatiskt anrop men kostar
    // fortfarande pengar. Hoppa över generering om organisationen redan nått sin
    // dagliga AI-budget. Additivt — orgs under cap påverkas inte. Anroparen
    // (sendMorningInsights) hanterar tom sträng via `if (!insights) continue`.
    try {
      await this.quota.checkOrgDailyCostCap(organizationId)
    } catch {
      this.logger.warn(
        `Hoppar över morgonrapport för org ${organizationId}: daglig kostnadscap nådd`,
      )
      return ''
    }

    const dataCtx = await this.dataContext.buildContext(organizationId)
    const response = await this.client.messages.create({
      model: AI_MODELS.ANALYSIS,
      max_tokens: 1024,
      system: `Du är Eveno AI – en intelligent fastighetsassistent för svenska fastighetsförvaltare.\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}`,
      messages: [
        {
          role: 'user',
          content: [
            'Skriv en personlig morgonbriefing till fastighetsägaren.',
            'Använd portföljdatan i kontexten för att producera en rik översikt.',
            '',
            'STRUKTUR (använd dessa rubriker):',
            '',
            '🚨 KRITISKT (handla idag) — högst 3 punkter',
            'Bara saker som måste hanteras NU: förfallna fakturor, akuta',
            'felanmälningar, kontrakt som går ut inom 14 dagar.',
            '',
            '📊 INSIKTER — högst 3 punkter',
            'Mönster, jämförelser, anomalier: betalningsbeteende,',
            'intäktsförändringar, beläggningsgrad.',
            '',
            '🎯 SMARTA FÖRSLAG — högst 3 punkter',
            'Möjligheter att tjäna mer eller spara: hyror som kan justeras,',
            'lediga lägenheter att marknadsföra, kostnadsbesparingar.',
            '',
            'REGLER:',
            '- Var KONKRET med siffror (kr-belopp, datum, antal)',
            '- Skriv NAMN på hyresgäster/fastigheter där relevant',
            '- Om en kategori är tom, hoppa över den (skriv inte "inget att rapportera")',
            '- Maximalt 9 punkter totalt',
            '- Skriv på svenska',
            '- Inga generiska floskler ("kolla din portfölj") — bara konkreta actions eller insikter',
            '',
            'Använd portföljdatan som finns i kontexten. Hitta inte på siffror.',
          ].join('\n'),
        },
      ],
    })
    void this.usage
      .logUsage({
        organizationId,
        endpoint: 'daily-insights',
        model: AI_MODELS.ANALYSIS,
        usage: response.usage,
        isAutomated: true,
        source: 'morning_insights',
      })
      .catch((err: unknown) => this.logger.warn('logUsage(daily-insights) failed', err))

    const content = response.content[0]
    return content?.type === 'text' ? content.text : ''
  }

  async generateWeeklySummary(organizationId: string): Promise<string> {
    // Samma kostnadscap-logik som generateDailyInsights — automatiskt anrop,
    // hoppa över om orgen nått dagsbudgeten. Anroparen (sendWeeklySummary)
    // hanterar tom sträng via `if (!summary) continue`.
    try {
      await this.quota.checkOrgDailyCostCap(organizationId)
    } catch {
      this.logger.warn(
        `Hoppar över veckosammanfattning för org ${organizationId}: daglig kostnadscap nådd`,
      )
      return ''
    }

    const dataCtx = await this.dataContext.buildContext(organizationId)
    const response = await this.client.messages.create({
      model: AI_MODELS.ANALYSIS,
      max_tokens: 1280,
      system: `Du är Eveno AI – en intelligent fastighetsassistent för svenska fastighetsförvaltare.\n\nAKTUELL PORTFÖLJDATA:\n${dataCtx}`,
      messages: [
        {
          role: 'user',
          content: [
            'Skriv en personlig veckosammanfattning till fastighetsägaren inför',
            'kommande vecka. Använd portföljdatan i kontexten.',
            '',
            'STRUKTUR (använd dessa rubriker):',
            '',
            '📅 KOMMANDE VECKAN — högst 5 punkter',
            'Saker som händer denna vecka: hyresavier som ska skickas, kontrakt',
            'som löper ut, bokade besiktningar, planerade åtgärder.',
            '',
            '💰 FINANSIELL ÖVERSIKT — högst 3 punkter',
            'Förväntade inbetalningar denna vecka, förväntade utgifter,',
            'kassaflödesprognosen.',
            '',
            '⚠️ RISKER ATT BEVAKA — högst 3 punkter',
            'Saker som behöver hållas under uppsikt: hyresgäster med',
            'betalningsproblem, kontrakt nära förfall, akuta ärenden.',
            '',
            'REGLER:',
            '- Var KONKRET med dagar (måndag, tisdag) och belopp',
            '- Skriv NAMN på personer/fastigheter',
            '- Om en kategori är tom, hoppa över den',
            '- Maximalt 11 punkter totalt',
            '- Skriv på svenska',
            '- Inga generiska floskler — bara konkreta actions eller insikter',
            '',
            'Använd portföljdatan som finns i kontexten. Hitta inte på siffror.',
          ].join('\n'),
        },
      ],
    })
    void this.usage
      .logUsage({
        organizationId,
        endpoint: 'weekly-summary',
        model: AI_MODELS.ANALYSIS,
        usage: response.usage,
        isAutomated: true,
        source: 'weekly_summary',
      })
      .catch((err: unknown) => this.logger.warn('logUsage(weekly-summary) failed', err))

    const content = response.content[0]
    return content?.type === 'text' ? content.text : ''
  }

  /**
   * Genererar AI-insikter för den månatliga PDF-rapporten. Tar emot en
   * färdigaggregerad textsammanfattning av månadens data (byggd av
   * MonthlyReportService) och returnerar fritext i tre rubriker. Returnerar
   * tom sträng om kostnadscapet är nått — PDF:en renderar då en fallback-text.
   */
  async generateMonthlyInsights(organizationId: string, monthSummary: string): Promise<string> {
    try {
      await this.quota.checkOrgDailyCostCap(organizationId)
    } catch {
      this.logger.warn(
        `Hoppar över månadsrapport-insikter för org ${organizationId}: daglig kostnadscap nådd`,
      )
      return ''
    }

    const response = await this.client.messages.create({
      model: AI_MODELS.ANALYSIS,
      max_tokens: 2048,
      system: `Du är Eveno AI – en intelligent fastighetsassistent för svenska fastighetsförvaltare. Du skriver den analytiska delen av en månadsrapport till fastighetsägaren.`,
      messages: [
        {
          role: 'user',
          content: [
            'Analysera månadens data nedan och skriv rapportens analytiska del.',
            '',
            'STRUKTUR (använd exakt dessa tre rubriker, var för sig på egen rad,',
            'utan numrering och utan emoji):',
            '',
            'Insikter från denna månad',
            'Tre konkreta, data-drivna observationer om vad som faktiskt hände.',
            '',
            'Rekommendationer för nästa månad',
            'Tre konkreta åtgärder, var och en med förväntat resultat.',
            '',
            'Trender att bevaka',
            'Tre trender (positiva eller negativa) med kort förklaring.',
            '',
            'REGLER:',
            '- Var KONKRET med siffror (kr-belopp, procent, antal)',
            '- Varje punkt på egen rad, inled med "- "',
            '- Skriv rubrikraderna exakt som ovan, utan emoji eller siffror',
            '- Skriv på svenska',
            '- Inga generiska floskler — bara konkreta insikter och åtgärder',
            '- Hitta inte på siffror; använd enbart datan nedan',
            '',
            'MÅNADSDATA:',
            monthSummary,
          ].join('\n'),
        },
      ],
    })
    void this.usage
      .logUsage({
        organizationId,
        endpoint: 'monthly-report',
        model: AI_MODELS.ANALYSIS,
        usage: response.usage,
        isAutomated: true,
        source: 'monthly_report',
      })
      .catch((err: unknown) => this.logger.warn('logUsage(monthly-report) failed', err))

    const content = response.content[0]
    return content?.type === 'text' ? content.text : ''
  }
}
