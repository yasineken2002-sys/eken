import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'

import { SKUGGFALT } from '../shadow/shadow-fields'

/**
 * VILKA FÄLT AGENTEN FÅR FRÅGA OM — och varifrån svarsalternativen kommer.
 *
 * ── HÄRLEDDA UR REGISTREN, ALDRIG SKRIVNA ──────────────────────────────────
 *
 * Alternativen är enumens värden ur Prisma-klienten. En handskriven lista hade
 * blivit fel första gången någon lade till en kategori — och felet hade varit
 * tyst: frågan ställs, men det rätta svaret finns inte bland knapparna, och
 * hyresvärden tvingas välja något annat än det hen menar.
 *
 * ── VARFÖR INTE ALLA `SKUGGFALT` ───────────────────────────────────────────
 *
 * `SKUGGFALT` är de tre fält skuggläget JÄMFÖR: kategori, prioritet, tilldelad.
 * De två första har ett register. Den tredje, `assignedToId`, är en naken
 * `String?` utan relation — planen säger uttryckligen att hantverkarmodellen är
 * etapp 10, och det finns alltså ingen mängd att bygga knappar av.
 *
 * Att ändå fråga om den hade krävt fritext som enda väg, och då är svaret inte
 * strukturerat: det går inte att jämföra med nästa förslag, och det kan inte
 * bli en maskinläsbar minnespost. Planens Del 7: *"Regler som påverkar
 * behörighet måste vara strukturerade och maskinläsbara."*
 *
 * Mängden är därför HÄRLEDD ur "har fältet ett register", inte skriven — och
 * `assignedToId` kommer med av sig självt den dag etapp 10 ger den ett.
 */
export interface Fragefalt {
  /** Nyckeln i `prediction`/`outcome`. Samma som `SKUGGFALT`. */
  nyckel: string
  /** Svensk etikett för frågan. */
  etikett: string
  /** De lagliga värdena, ur registret. */
  alternativ: readonly string[]
}

/** Register per skuggfält. Saknas ett register går fältet inte att fråga om. */
const REGISTER: Record<string, readonly string[] | undefined> = {
  category: Object.values(MaintenanceCategory),
  priority: Object.values(MaintenancePriority),
  // `assignedToId` har med FLIT inget register — se docblocket ovan.
}

export const FRAGEBARA_FALT: readonly Fragefalt[] = SKUGGFALT.flatMap((f) => {
  const alt = REGISTER[f.nyckel]
  return alt ? [{ nyckel: f.nyckel, etikett: f.etikett, alternativ: alt }] : []
})

export const FRAGEBARA_NYCKLAR: readonly string[] = FRAGEBARA_FALT.map((f) => f.nyckel)

/**
 * Frågan som den lagras i `AiAssignment.toolInput`.
 *
 * `användsTill` är inte dekoration: planens Del 11 kräver att varje fråga låser
 * upp något, och en fråga vars nytta inte går att skriva ned är en fråga som
 * inte ska ställas. Fältet gör kravet läsbart för människan som svarar.
 */
export interface FragansInnehall {
  fält: string
  alternativ: string[]
  användsTill: string
}

/** Är nyttolasten en giltig fråga? Fail-closed: allt annat är inte en fråga. */
export function ärGiltigFråga(input: unknown): input is FragansInnehall {
  if (typeof input !== 'object' || input === null) return false
  const i = input as Record<string, unknown>
  if (typeof i['fält'] !== 'string' || !FRAGEBARA_NYCKLAR.includes(i['fält'])) return false
  const alt = i['alternativ']
  if (!Array.isArray(alt)) return false
  // TVÅ TILL FYRA. Ett alternativ är inget val; fler än fyra är en lista att
  // läsa igenom, och då kostar frågan mer uppmärksamhet än den låser upp.
  if (alt.length < 2 || alt.length > 4) return false
  const lagliga = FRAGEBARA_FALT.find((f) => f.nyckel === i['fält'])!.alternativ
  if (!alt.every((a) => typeof a === 'string' && lagliga.includes(a))) return false
  return typeof i['användsTill'] === 'string' && i['användsTill'].trim() !== ''
}
