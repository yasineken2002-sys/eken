/**
 * MODELLVALET FÖR OPERATÖRSCHATTEN: Opus 5 för allt.
 *
 * Chatten (både den strömmande och den icke-strömmande vägen) körde tidigare
 * `claude-sonnet-4-5`. Bytet gjordes för att chatten ska kunna läsa bilagor
 * (spår B): Sonnet 4.5 skalar bilder till 1568 px, Opus 5 till 2576 px — och
 * skillnaden är just den mellan att kunna läsa en rad på ett inskannat
 * kontoutdrag och att gissa. Vision-upplösning är en egenskap hos modellnivån,
 * inte något som går att kompensera med prompt eller effort.
 *
 * "Opus 5 för allt" är ett MEDVETET val: varje operatörsmeddelande går till
 * Opus 5, även ett rent textmeddelande som Sonnet klarat lika bra. Alternativet
 * — Opus bara när meddelandet bär en bilaga, Sonnet annars — sänker kostnaden
 * men gör svarskvaliteten beroende av om användaren råkade bifoga något, och
 * delar prompt-cachen i två (två modeller = två cacheprefix = ingen delad
 * cachevinst). Vill kostnaden ned senare är den växeln liten att bygga:
 * `model` blir en funktion av `attachmentIds.length`.
 *
 * VAD SOM INTE BYTTE, och varför:
 *  • TENANT_CHAT — hyresgästportalens AI. Den delade tidigare nyckel med
 *    operatörschatten (`AI_MODELS.CHAT`), så ett byte här hade TYST dragit med
 *    portalen. Den har dessutom max_tokens 1024, vilket Opus 5:s resonemang
 *    ensamt äter upp (uppmätt: vid 2048 gick HELA budgeten till thinking och
 *    svaret blev tomt).
 *  • VISION_CONTRACT — batch-kontraktsskanning och PDF-bankparsern. Egna
 *    kostnads- och volymkalkyler, eget beslut.
 *  • MEMORY / ANALYSIS — orörda.
 */
export const AI_MODELS = {
  CHAT: 'claude-opus-5',
  STREAM: 'claude-opus-5',
  ANALYSIS: 'claude-sonnet-4-5',
  MEMORY: 'claude-haiku-4-5-20251001',
  /** Hyresgästportalens assistent — se kommentaren ovan, byttes MEDVETET inte. */
  TENANT_CHAT: 'claude-sonnet-4-5',
  VISION_CONTRACT: 'claude-sonnet-4-5',
  VISION_INSPECTION: 'claude-sonnet-4-5',
} as const

export type AiModel = (typeof AI_MODELS)[keyof typeof AI_MODELS]

/**
 * Resonemangsnivå för operatörschatten (`output_config.effort`).
 *
 * SATT EXPLICIT, inte lämnad till API:ts default. Uppmätt på samma
 * hyresskuld-fråga med max_tokens 2048 (produktionsvärdet före detta byte):
 *
 *   Sonnet 4.5, default   → stop=end_turn,   794 tokens, 1734 tecken svar
 *   Opus 5, default       → stop=max_tokens, 2048 tokens, 0 TECKEN SVAR
 *   Opus 5, effort=low    → stop=max_tokens, 2048 tokens, 2303 tecken svar
 *
 * Med default-effort gick alltså hela tokenbudgeten till resonemang och
 * användaren fick ett TOMT svar. Vid 8192 tokens svarade default-effort fullt
 * ut men förbrukade 5245 output-tokens — mot Sonnets 794 för samma fråga.
 *
 * `low` valdes för att chatten är interaktiv: den ger fortfarande ett
 * thinking-block (Sonnet 4.5 gav inget alls), landar på ~2000 output-tokens och
 * håller latens och kostnad i samma storleksordning som förut. Höj till
 * 'medium' om svarskvaliteten på svåra frågor visar sig otillräcklig — men höj
 * då tokentaken med, annars flyttar man bara trunkeringen.
 */
export const CHAT_EFFORT = 'low' as const

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
