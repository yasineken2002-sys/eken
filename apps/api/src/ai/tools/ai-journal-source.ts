import { hashPendingAction } from '../pending-action-hash'

/**
 * IDEMPOTENSNYCKELN FÖR AI-SKAPADE VERIFIKAT.
 *
 * ── DEFEKTEN SOM MÄTTES ─────────────────────────────────────────────────────
 *
 * `JournalEntry` bär `@@unique([organizationId, source, sourceId])` — en
 * idempotensspärr på DB-nivå som är i drift och som fäller. Men de två AI-
 * verktyg som skriver verifikat (`create_journal_entry`, `record_expense`)
 * skrev `source: 'AI'` UTAN `sourceId`, och Postgres behandlar NULL som distinkt.
 * Mätt mot riktig PG 18.6:
 *
 *     source='AI', sourceId=NULL          → 3 identiska verifikat TILLÅTNA
 *     source='INVOICE', sourceId='inv-1'  → andra insert AVVISAD
 *       ERROR: duplicate key ... "JournalEntry_organizationId_source_sourceId_key"
 *
 * Spärren fanns alltså redan; AI-vägen föll utanför den. Den här modulen sätter
 * tillbaka AI-vägen innanför — inget nytt index, ingen ny mekanism.
 *
 * ── VARFÖR INNEHÅLLET OCH INTE pendingActionId ──────────────────────────────
 *
 * Den närliggande nyckeln är `ai:<pendingActionId>`. Den är FEL, och skälet är
 * mätt, inte resonerat.
 *
 * Verktygsloggens id allokeras FÖRE körningen (`tool-executor.service.ts`,
 * "Verktygsloggens id allokeras FÖRE körningen"), men själva `AiToolExecution`-
 * raden skrivs EFTERÅT och fire-and-forget. Kraschar processen mellan
 * verifikatskrivningen och auditraden finns alltså verifikatet, men ingen
 * körning som pekar på det. Användaren ser att åtgärden inte kan bekräftas och
 * ber assistenten föreslå den igen — vilket ger en NY `AiPendingAction` med ett
 * NYTT id.
 *
 * Med `ai:<pendingActionId>` hade det omtaget skapat ett ANDRA verifikat för
 * samma affärshändelse. Nyckeln måste därför vara stabil över ett omtag, och
 * det som är stabilt är ÅTGÄRDENS INNEHÅLL: samma verktyg + samma indata ger
 * samma hash, oavsett hur många gånger den föreslås.
 *
 * Det är samma hash som binder bekräftelsen (`AiPendingAction.toolInputHash`).
 * Att det är samma är ingen slump: bekräftelsen och verifikatet ska handla om
 * exakt samma åtgärd, och två olika definitioner av "samma åtgärd" hade kunnat
 * glida isär.
 *
 * ── VAD DET KOSTAR, OCH VARFÖR PRISET ÄR RÄTT ───────────────────────────────
 *
 * Nyckeln är org-scopad (indexet är `(organizationId, source, sourceId)`). Två
 * verifikat med IDENTISKT innehåll — samma datum, samma beskrivning, samma
 * konteringsrader — kan därför inte längre båda skapas i samma organisation.
 * Det andra försöket returnerar det FÖRSTA verifikatet i stället för att skapa
 * ett nytt, och svaret säger det rakt ut.
 *
 * Det är en verklig beteendeändring, och den är avsiktlig. Avvägningen:
 *
 *   • att slå ihop en ÄKTA dubblett  → synlig friktion, användaren varierar
 *     beskrivningen ("Parkering kvitto 2") och kommer vidare. Återställbart.
 *   • att släppa igenom en OÄKTA     → två identiska verifikat i huvudboken,
 *     osynliga tills någon stämmer av. Fel bokföring, tyst.
 *
 * I ett dubbel bokföringssystem är det synliga felet det billigare. Två poster
 * som är identiska i datum, belopp, konto OCH beskrivning går inte heller att
 * skilja åt för en människa som läser huvudboken — de SKA beskrivas olika.
 *
 * ── AVGRÄNSNING ────────────────────────────────────────────────────────────
 *
 * Nyckeln gäller verifikat. De andra 27 effektproducerande verktygen (e-post,
 * inkassoexport, PDF) har fortfarande ingen idempotensnyckel; deras skydd är
 * bekräftelseanspråket. Det är ett eget arbete och står i #580.
 */

/** Prefixet som skiljer AI-nycklar från övriga namnrymder i `sourceId`. */
export const AI_JOURNAL_SOURCE_PREFIX = 'ai:'

/**
 * Deterministisk `sourceId` för ett AI-skapat verifikat.
 *
 * Samma `toolName` + `toolInput` ⇒ samma nyckel, för alltid. Prefixet gör
 * namnrymden läsbar i databasen och kan inte kollidera med de befintliga
 * (`invoice-…`, `rent-notice-…`, `credit-note:…`, `entry-reversal:…`).
 */
export function aiJournalSourceId(toolName: string, toolInput: Record<string, unknown>): string {
  return `${AI_JOURNAL_SOURCE_PREFIX}${hashPendingAction(toolName, toolInput)}`
}
