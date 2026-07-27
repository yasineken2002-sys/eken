/**
 * MODELLVALET FÖR OPERATÖRSCHATTEN: Sonnet för text, Opus 5 för bilagor.
 *
 * Chatten körde först `claude-sonnet-4-5`, byttes sedan till Opus 5 för ALLT
 * (spår B, bilagor), och delas nu per meddelande. Skälet till Opus finns kvar
 * men gäller bara bilagefallet: Sonnet 4.5 skalar bilder till 1568 px, Opus 5
 * till 2576 px — skillnaden mellan att läsa en rad på ett inskannat kontoutdrag
 * och att gissa. Vision-upplösning är en egenskap hos modellnivån, inte något
 * som går att kompensera med prompt eller effort.
 *
 * Men det mesta som skrivs i chatten är text, och Opus 5 kostar ~11× mer per
 * anrop (uppmätt i AiUsageLog: 0,71 kr/anrop mot Sonnets 0,06). Att betala
 * vision-pris för "hur mycket är Anderssons skuld?" är ren förlust.
 *
 * VAD SOM GAVS UPP: den delade prompt-cachen. Två modeller = två cacheprefix,
 * så en konversation som växlar modell betalar en cache-write i stället för en
 * cache-read vid växlingen. Det är ett medvetet byte — en cache-write kostar
 * 1,25× input, medan Opus-uppgraderingen kostade 11× hela anropet.
 *
 * VAD SOM INTE ÄR MODELLBEROENDE (viktigt vid framtida byten):
 *  • `max_tokens` och `effort` hör till PROFILEN, inte till koden. Opus 5 lägger
 *    en del av budgeten på ett thinking-block och gav TOMT SVAR vid 2048 (mätt:
 *    stop_reason=max_tokens, 0 tecken). Sonnet 4.5 har inget thinking-block alls
 *    och klarar samma fråga på 794 tokens. Ett gemensamt tak hade antingen
 *    svultit Opus eller slösat på Sonnet.
 *  • `output_config.effort` FÅR INTE skickas till Sonnet 4.5 — parametern finns
 *    inte på den modellnivån och avvisas. Profilen utelämnar den därför helt i
 *    textläget; `chatRequestOptions()` spreadar in den bara när den finns.
 *
 * VAD SOM INTE BYTTE, och varför:
 *  • TENANT_CHAT — hyresgästportalens AI. Egen väg, egen nyckel, står redan på
 *    Sonnet. Den har max_tokens 1024, vilket Opus 5:s resonemang ensamt äter upp.
 *  • VISION_CONTRACT — batch-kontraktsskanning och PDF-bankparsern. Egna
 *    kostnads- och volymkalkyler, eget beslut.
 *  • MEMORY / ANALYSIS — orörda.
 */
export const AI_MODELS = {
  /** Operatörschatten i TEXTLÄGE. Samma modellsträng som portalens TENANT_CHAT. */
  CHAT: 'claude-sonnet-4-5',
  /** Operatörschatten i BILAGELÄGE — vision kräver Opus 5:s upplösning. */
  CHAT_VISION: 'claude-opus-5',
  ANALYSIS: 'claude-sonnet-4-5',
  MEMORY: 'claude-haiku-4-5-20251001',
  /** Hyresgästportalens assistent — se kommentaren ovan, rörs inte. */
  TENANT_CHAT: 'claude-sonnet-4-5',
  VISION_CONTRACT: 'claude-sonnet-4-5',
  VISION_INSPECTION: 'claude-sonnet-4-5',
} as const

export type AiModel = (typeof AI_MODELS)[keyof typeof AI_MODELS]

/**
 * En komplett anropsprofil för operatörschatten: modell + tokentak + effort.
 *
 * De tre hör IHOP och får aldrig sättas var för sig. Mätningen som ligger bakom
 * (samma hyresskuld-fråga, max_tokens 2048):
 *
 *   Sonnet 4.5, ingen effort → stop=end_turn,   794 tokens, 1734 tecken svar
 *   Opus 5, default-effort   → stop=max_tokens, 2048 tokens, 0 TECKEN SVAR
 *   Opus 5, effort=low       → stop=max_tokens, 2048 tokens, 2303 tecken svar
 *
 * Opus 5 utan explicit effort lade alltså HELA budgeten på resonemang och
 * användaren fick ett tomt svar. Det är därför `effort` och `maxTokens` bor i
 * samma objekt som `model`: höjer man effort måste taket följa med, och byter
 * man modell måste båda omprövas.
 */
export interface ChatModelProfile {
  readonly model: AiModel
  readonly maxTokens: number
  /**
   * Utelämnad = parametern skickas INTE alls.
   *
   * Det är inte en stilfråga: `output_config.effort` finns inte på Sonnet 4.5
   * och avvisas av API:t. Textprofilen måste därför sakna fältet — inte sätta
   * det till något "neutralt" värde.
   */
  readonly effort?: 'low' | 'medium' | 'high'
}

/**
 * TEXTLÄGE — inga bilagor. Sonnet 4.5, samma modell som portalen.
 *
 * 2048 var produktionsvärdet före Opus-bytet och mätningen ovan visar att
 * Sonnet landar på 794 tokens för en typisk fråga, alltså med god marginal.
 * Ingen effort-parameter (finns inte på modellnivån).
 */
export const CHAT_PROFILE_TEXT: ChatModelProfile = {
  model: AI_MODELS.CHAT,
  maxTokens: 2048,
}

/**
 * BILAGELÄGE — meddelandet bär bild eller dokument. Opus 5 för vision.
 *
 * 4096 och effort=low är exakt de värden som löste det tomma svaret vid
 * Opus-bytet: effort=low håller resonemanget kring ~2000 tokens, och 4096 ger
 * marginal utan att bli ett tak som aldrig binder. Höjs effort måste taket
 * höjas med — annars flyttas bara trunkeringen.
 */
export const CHAT_PROFILE_VISION: ChatModelProfile = {
  model: AI_MODELS.CHAT_VISION,
  maxTokens: 4096,
  effort: 'low',
}

/**
 * Modellvalet för ETT meddelande. Bilaga med → Opus 5, annars Sonnet.
 *
 * Anropas EN gång per användarmeddelande och resultatet följer med genom hela
 * tool-loopen. Att välja om mitt i loopen vore fel på två sätt: det byter modell
 * mellan en tur och dess egen fortsättning, och det slår sönder prompt-cachen
 * för varje iteration.
 *
 * Argumentet ska vara "har meddelandet FAKTISKT bilageinnehåll", dvs.
 * `attached.contentBlocks.length > 0` — inte `attachmentIds.length`. Id-listan
 * är användarens påstående; contentBlocks är vad som faktiskt gick till modellen.
 */
export function pickChatProfile(hasAttachments: boolean): ChatModelProfile {
  return hasAttachments ? CHAT_PROFILE_VISION : CHAT_PROFILE_TEXT
}

/**
 * Profilen → de fält som ska in i `messages.create()` / `messages.stream()`.
 *
 * Finns för att BÅDA chattvägarna (icke-strömmande och SSE) ska bygga anropet
 * likadant. Divergens mellan de två vägarna har redan orsakat en
 * produktionsbugg en gång (par-invarianten, PR #245) — modellval, tokentak och
 * effort är nästa sak som hade drivit isär.
 *
 * `output_config` spreadas in bara när profilen har en effort. Med
 * `exactOptionalPropertyTypes` är det skillnad på "saknas" och "undefined", och
 * här måste den vara HELT frånvarande för Sonnet.
 */
export function chatRequestOptions(profile: ChatModelProfile): {
  model: AiModel
  max_tokens: number
  output_config?: { effort: 'low' | 'medium' | 'high' }
} {
  return {
    model: profile.model,
    max_tokens: profile.maxTokens,
    ...(profile.effort ? { output_config: { effort: profile.effort } } : {}),
  }
}

/**
 * Voyage-embeddings för juridik-RAG:ens semantiska sökning (Etapp 3).
 *
 * `voyage-4`: nyaste generella/flerspråkiga flaggskeppet, 1024-dim. VALT EFTER
 * MÄTNING (2026-06-10): den domänspecifika `voyage-law-2` är engelsk/US-lag-
 * centrerad och presterade SÄMST på svensk hyresrätt (besittningsskydd §46 på
 * rank #53/560 för den vardagliga flaggskeppsfrågan). voyage-4 rankar samma §46
 * på #1 och lyfter besittningsskydd in i topp-3 — det BM25 missade.
 *
 * DIM måste matcha vector(1024)-kolumnen i LegalChunkEmbedding (PR 3.1) — byter
 * man modell till en annan dimension krävs en ny migration på vektorkolumnen.
 */
export const VOYAGE_EMBEDDINGS = {
  MODEL: 'voyage-4',
  DIM: 1024,
} as const
