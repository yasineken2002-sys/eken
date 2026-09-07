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
 * ── ALLA TRE `SKUGGFALT` ÄR FRÅGEBARA SEDAN ETAPP 10 ───────────────────────
 *
 * Stycket nedan förklarade varför det bara var TVÅ: `assignedToId` var en naken
 * `String?` utan relation, och det fanns ingen mängd att bygga knappar av.
 *
 * #833 gav fältet en riktig relation (`assignedContractorId` → `Contractor`) med
 * yrkeskategorier ur samma enum som ärendet. Mängden finns alltså nu — den är
 * bara DYNAMISK, per organisation och per kategori, i stället för statisk. Och
 * det var precis vad det gamla stycket förutsåg: *"assignedToId kommer med av
 * sig självt den dag etapp 10 ger den ett [register]."*
 *
 * ── DET GAMLA SKÄLET, BEVARAT ──────────────────────────────────────────────
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
  /** De lagliga värdena, ur registret. Tom när `dynamiskt` är sant. */
  alternativ: readonly string[]
  /** Sant när mängden kommer med frågan i stället för ur den här filen. */
  dynamiskt?: true
}

/**
 * ── TVÅ SORTERS REGISTER SEDAN ETAPP 10 ────────────────────────────────────
 *
 * `category` och `priority` har STATISKA register: enumens värden, lika för
 * varje organisation, kända vid kompilering.
 *
 * `assignedContractorId` har ett DYNAMISKT: organisationens egna hantverkare,
 * filtrerade på ärendets kategori. Mängden kan inte stå här — den är olika för
 * varje kund och varje ärende — men den FINNS, och det är hela skillnaden mot
 * före #833, då fältet var en naken sträng utan mängd alls och därför inte gick
 * att fråga om.
 *
 * `DYNAMISKT` är därför inte "inget register". Det är "registret följer med
 * frågan", och `ärGiltigFråga` kräver då att anroparen lämnar det —
 * FAIL-CLOSED: utan mängd finns inget att pröva svaret mot, och en fråga som
 * inte går att pröva ska inte gå igenom.
 */
export const DYNAMISKT = Symbol('dynamiskt register')

const REGISTER: Record<string, readonly string[] | typeof DYNAMISKT | undefined> = {
  category: Object.values(MaintenanceCategory),
  priority: Object.values(MaintenancePriority),
  assignedContractorId: DYNAMISKT,
}

export const FRAGEBARA_FALT: readonly Fragefalt[] = SKUGGFALT.flatMap((f) => {
  const alt = REGISTER[f.nyckel]
  if (alt === undefined) return []
  return [
    {
      nyckel: f.nyckel,
      etikett: f.etikett,
      // TOM LISTA för ett dynamiskt fält, och `dynamiskt: true` bredvid. Utan
      // flaggan hade tomheten betytt två saker — "inga lagliga värden" och
      // "mängden kommer utifrån" — och den första hade gjort varje fråga om
      // fältet ogiltig utan att någon sett varför.
      alternativ: alt === DYNAMISKT ? [] : alt,
      ...(alt === DYNAMISKT ? { dynamiskt: true as const } : {}),
    },
  ]
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

/**
 * Är nyttolasten en giltig fråga? Fail-closed: allt annat är inte en fråga.
 *
 * @param dynamisktRegister de lagliga värdena för ett DYNAMISKT fält
 *   (`assignedContractorId`). Utelämnas den för ett sådant fält avvisas frågan
 *   — utan mängd finns inget att pröva svaret mot, och en oprövbar fråga är
 *   värre än ingen fråga: hyresvärden svarar, och svaret betyder ingenting.
 */
export function ärGiltigFråga(
  input: unknown,
  dynamisktRegister?: readonly string[],
): input is FragansInnehall {
  if (typeof input !== 'object' || input === null) return false
  const i = input as Record<string, unknown>
  if (typeof i['fält'] !== 'string' || !FRAGEBARA_NYCKLAR.includes(i['fält'])) return false
  const alt = i['alternativ']
  if (!Array.isArray(alt)) return false
  // TVÅ TILL FYRA. Ett alternativ är inget val; fler än fyra är en lista att
  // läsa igenom, och då kostar frågan mer uppmärksamhet än den låser upp.
  //
  // Regeln gäller ÄVEN det dynamiska fältet, och det kostade ingenting: ett tomt
  // register ger två alternativ ("lägg till en hantverkare" / "jag gör det
  // själv"), och båda är riktiga svar som leder till olika saker. Att i stället
  // göra ett undantag för ett ensamt alternativ hade urholkat regeln för alla
  // fält — se `TOMT_REGISTER_ALTERNATIV`.
  if (alt.length < 2 || alt.length > 4) return false
  const fält = FRAGEBARA_FALT.find((f) => f.nyckel === i['fält'])!
  const lagliga = fält.dynamiskt ? dynamisktRegister : fält.alternativ
  // FAIL-CLOSED på ett dynamiskt fält utan register.
  if (!lagliga) return false
  if (!alt.every((a) => typeof a === 'string' && lagliga.includes(a))) return false
  return typeof i['användsTill'] === 'string' && i['användsTill'].trim() !== ''
}
