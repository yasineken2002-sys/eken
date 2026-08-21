import { applyPatterns, DISPLAY_PATTERNS } from './patterns'

/**
 * MASKERING VID VISNING — inte vid lagring (#507).
 *
 * ── PRINCIPEN, som är hela konstruktionen ───────────────────────────────────
 *
 *   Lagrad rad orörd. Modellen får den orörd. Människan får den maskerad.
 *
 * Maskering är ett VISNINGSLAGER, aldrig en transformation av det som sparas.
 * Maskerar man vid skrivning förlorar man data man inte får tillbaka — och i
 * det här fallet vore förlusten värre än så: `AiMessage` replayas som historik
 * och `AiMemory` injiceras i systemprompten, så en maskering vid skrivning är
 * inte en loggåtgärd utan en ändring av assistentens arbetsminne. Det var
 * precis därför förslag 3a i #494 avslogs, och därför den här funktionen ligger
 * på läsvägen i stället.
 *
 * Följden att vara tydlig med: **personuppgiften ligger kvar i databasen.** Det
 * här är ingen raderingsåtgärd och ska inte redovisas som en. Den som begär
 * radering får sitt svar av beslut 2 i #494 eller av gallringsfristen.
 *
 * ── VAD SOM MASKERAS ────────────────────────────────────────────────────────
 *
 * Bara det som går att matcha ENTYDIGT på form: personnummer, organisationsnummer,
 * e-post, telefon (mobil och fast), OCR-nummer, bankgiro, plusgiro,
 * clearing + kontonummer och IBAN. Mönstren bor i `patterns.ts` och delas med
 * #508:s maskering vid skrivning.
 *
 * ── VAD SOM INTE MASKERAS: NAMN ─────────────────────────────────────────────
 *
 * Namn maskeras INTE, och det är ett beslut — inte en lucka.
 *
 * En mönstermatchning på namn träffar antingen för brett eller för smalt, och
 * BÅDA utfallen är sämre än att inte maskera alls:
 *
 *   För brett — ett mönster som fångar "Anna Karlsson" fångar också "Stora
 *     Torget", "Hyra Januari" och varje ortnamn, gatunamn och rubrik i texten.
 *     Resultatet är ett underlag där hälften av orden är ***MASKERAT***, och en
 *     operatör som ska kunna lita på det kan inte läsa det. Vi förstör alltså
 *     precis det som gör historiken användbar.
 *
 *   För smalt — en lista över vanliga förnamn fångar "Anna" men inte "Zerihun",
 *     och ger då ett gränssnitt som SER maskerat ut. Det är falsk trygghet, och
 *     falsk trygghet är farligare än ingen maskering: den som ser ***MASKERAT***
 *     på skärmen slutar tänka på att resten står i klartext.
 *
 * Prod-mätningen 2026-08-19 fann noll personnummer i `AiMessage` men fem
 * namnliknande förekomster — så namnfrågan är den kvarvarande exponeringen, och
 * den ska lösas av något annat än reguljära uttryck. Den som vill maskera namn
 * behöver en mekanism som VET vilka namnen är (t.ex. de faktiska hyresgäst- och
 * kontaktnamnen i organisationen, slagna mot texten) — inte ett mönster. Det är
 * en egen fråga med en egen kostnad, och den ska ställas som en sådan.
 */

/** Maskerar en enskild sträng. Tom eller icke-sträng returneras oförändrad. */
export function maskForDisplay(value: string): string {
  if (!value) return value
  return applyPatterns(value, DISPLAY_PATTERNS)
}

/**
 * Maskerar varje sträng i ett godtyckligt JSON-värde.
 *
 * Rekursionen speglar `redactSensitive` i formen men är ett SYSKON, inte en
 * kopia: den arbetar på INNEHÅLL (mönster i fritext) medan `redactSensitive`
 * arbetar på FÄLTNAMN. De löser olika halvor av samma problem och tillämpas på
 * olika vägar — den här på läsvägar mot en människa, den andra på verktygssvar
 * mot modellen.
 *
 * `Date` och `Buffer` lämnas orörda, och djupet är begränsat på samma sätt.
 */
export function maskAiContentForDisplay<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return maskForDisplay(value) as unknown as T
  if (Array.isArray(value)) {
    return value.map((v) => maskAiContentForDisplay(v, depth + 1)) as unknown as T
  }
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskAiContentForDisplay(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}
