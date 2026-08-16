/**
 * GALLRINGSFRISTER FÖR AI-LAGRET — en per tabell, satt av tabellens SYFTE.
 *
 * ── VARFÖR INTE ETT GEMENSAMT N ─────────────────────────────────────────────
 *
 * Ett tal hade varit bekvämt och fel. Tabellerna gör olika saker: en är ett
 * minne som ska bestå, en är ett kvotunderlag, en är ett revisionsspår. Ett
 * gemensamt N hade antingen tagit sönder minnesfunktionen eller lämnat
 * revisionsspåret utan skäl.
 *
 * ── VARFÖR GALLRING ÖVER HUVUD TAGET ────────────────────────────────────────
 *
 * AI-lagret bär personuppgifter i fritext — namn, adresser, e-post — och rörs
 * av NOLL av avidentifieringens skrivningar. Uppmätt i produktion (en användare,
 * knappt använt system): 2 e-postadresser, 1 gatuadress och 5 namnliknande
 * förekomster i `AiMessage`; 1, 1 och 3 i `AiMemory`. `AiMessage` och `AiMemory`
 * maskerar dessutom INGENTING vid skrivning — sanering finns bara i auditen,
 * och den täcker bara person- och organisationsnummer.
 *
 * Före den här cronen fanns ingen gallring alls: enda `deleteMany` i hela
 * AI-lagret var den användarinitierade `clearMemories`. Prod nollställdes
 * 2026-07-13 och äldsta raden i varje tabell var från just det datumet.
 *
 * ── DEN HÄR CRONEN ÄR EN MITIGERING, INTE FIXEN ─────────────────────────────
 *
 * Den tidsbegränsar exponeringen. Den uppfyller INTE en raderingsbegäran som
 * kommer i dag — en hyresgäst ska inte behöva vänta ut en frist på att en cron
 * hinner ikapp. Per-hyresgäst-frågan står kvar öppen i GDPR-ärendet.
 */

/**
 * Samtal och deras meddelanden: **365 dagar** på `updatedAt`.
 *
 * SYFTE: användaren ska kunna bläddra bakåt. Frågan "hur långt" är ett
 * produktbeslut, inte en teknisk gräns — och i dag finns ingen gräns alls:
 * `ConversationSidebar` listar varje samtal som någonsin funnits, och
 * `aiConversation.findMany` (ai-assistant.service.ts:1095) har varken `take`
 * eller filter.
 *
 * Ett år valt så att "vad sa vi om det där i våras" fortfarande går att slå
 * upp, medan tillväxten får en bortre gräns. Fristen räknas på `updatedAt`, så
 * ett samtal som fortfarande används åldras aldrig ut — samma grepp som
 * bilagestädningen redan använder.
 *
 * Det här är det tal som mest sannolikt kommer att revideras, och det ska
 * revideras av ett produktbeslut och inte av den som råkar läsa filen.
 */
export const CONVERSATION_RETENTION_DAYS = 365

/**
 * AI-minnet: **365 dagar** på `updatedAt` — inte på `createdAt`.
 *
 * SYFTE: tabellen är designad för att MINNAS över samtal. En frist på
 * skapandetidpunkten hade tagit sönder just den funktionen: ett sant och
 * användbart faktum hade fallit bort på sin ettårsdag.
 *
 * `memory.service.ts:158` gör `upsert` — varje gång samma nyckel extraheras på
 * nytt uppdateras `updatedAt`. Fristen mäter alltså "har inte bekräftats på ett
 * år", inte "är gammal". Ett faktum som fortsätter vara relevant förnyas av
 * användningen och gallras aldrig; ett som aldrig nämns igen är per definition
 * inte längre ett minne som används.
 *
 * Det är svaret på "kanske är rätt frist inte en frist alls här": fristen finns,
 * men den mäter inaktivitet i stället för ålder.
 */
export const MEMORY_RETENTION_DAYS = 365

/**
 * Förbruknings-/kostnadsloggen: **730 dagar** (två år) på `createdAt`.
 *
 * SYFTE: kvot och fakturering. Uppmätt: VARJE läsning av tabellen använder
 * innevarande kalendermånad — `getMonthStart()` i `ai-usage.service.ts:39`,
 * `monthStart` i `ai/usage/ai-usage.service.ts:113` och `:139` och `:155`, och
 * `platform-ai-usage.service.ts` på båda ställena. Ingenting läser längre bak.
 *
 * Funktionellt hade alltså en månad räckt. Två år är satt för TVIST, inte för
 * funktion: en kund som ifrågasätter en faktura ska kunna få underlaget, och
 * plattformsfakturorna löper per månad.
 *
 * OSÄKERHET, uttryckligen: `AiUsageLog.costSek` ligger till grund för
 * plattformsfakturering och gränsar därmed till samma fråga som ställdes om
 * `AiToolExecution` — se ärendet. Två år är valt konservativt i väntan på svar,
 * inte som ett avgjort tal.
 */
export const USAGE_LOG_RETENTION_DAYS = 730

/** Hur många rader en tabell tar per körning. Speglar bilagestädningen. */
export const RETENTION_BATCH_SIZE = 500

/**
 * Läget cronen körs i.
 *
 * `dry-run` är DEFAULT, och det är avsiktligt. En gallring som börjar radera i
 * samma sekund den deployas ger ingen chans att mäta först. Cronen kör alltså
 * nattligt och RAPPORTERAR vad den skulle ta, tills någon uttryckligen sätter
 * `AI_RETENTION_MODE=enforce`.
 *
 * Samma ordning som `rotate-pii-secrets`: mätning före verkställighet.
 */
export type RetentionMode = 'dry-run' | 'enforce'

export function retentionModeFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionMode {
  return env['AI_RETENTION_MODE'] === 'enforce' ? 'enforce' : 'dry-run'
}
