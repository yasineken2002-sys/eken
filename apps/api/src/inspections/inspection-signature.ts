import { createHash } from 'node:crypto'

/**
 * VAD SIGNERINGEN FAKTISKT OMFATTAR — och varför frågan behövde ett svar.
 *
 * ── LÄGET FÖRE ──────────────────────────────────────────────────────────────
 *
 * "Signera protokoll" satte `status = SIGNED` och en tidsstämpel. Ingenting
 * annat. Signaturen band alltså INGA uppgifter: inte skickbedömningen, inte
 * reparationskostnaden, inte bilderna. Att kalla raden signerad var ett
 * påstående om en knapptryckning, inte om ett innehåll.
 *
 * Konsekvensen är inte teoretisk. `InspectionItem.repairCost` är det belopp en
 * hyresvärd läser av när ett depositionsavdrag beslutas, och protokollet är
 * huvudbeviset om hyresgästen bestrider. Ett bevis som kan skrivas om efter att
 * motparten skrivit under är inget bevis.
 *
 * ── VAD HASHEN ÄR, OCH VAD DEN INTE ÄR ──────────────────────────────────────
 *
 * `signedContentHash` är en sha256 över en KANONISK bild av protokollets
 * innehåll vid signeringsögonblicket. Den är ett INTEGRITETSSPÅR, inte en
 * kryptografisk underskrift: den bevisar att innehållet är detsamma som när
 * signeringen skedde, inte VEM som skrev under. Ingen nyckel finns, ingen
 * extern signeringstjänst är inblandad, och en angripare med skrivrättighet
 * direkt mot databasen kan räkna om både innehåll och hash.
 *
 * Det den DÄREMOT gör är att göra en avvikelse UPPTÄCKBAR om innehållet någon
 * gång ändras förbi tjänstelagrets spärr — genom rå SQL, en framtida skrivväg
 * som glömmer spärren, eller en återställd säkerhetskopia. Spärren
 * (`inspections.service.ts`) hindrar; hashen avslöjar.
 *
 * ── AVGRÄNSNINGEN ÄR MEDVETEN ───────────────────────────────────────────────
 *
 * MED i underlaget: protokollets INNEHÅLL — typ, planerat datum, slutförande,
 * övergripande omdöme, anteckning, samtliga poster (rum, föremål, skick,
 * anteckning, reparationskostnad) och samtliga bilder (filnamn, lagringsnyckel,
 * bildtext, rum, storlek).
 *
 * UTANFÖR underlaget: `status`, `signedAt`, `signedContentHash` och
 * signaturfälten. De beskriver radens LIVSCYKEL, inte vad som besiktigades, och
 * de ändras just av signeringen — hade de räknats in hade hashen behövt täcka
 * sitt eget resultat.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * Poster och bilder sorteras på `id` innan de serialiseras: Prisma garanterar
 * ingen radordning utan `orderBy`, och en hash som beror på hur Postgres råkar
 * returnera raderna hade varit falskt röd vid nästa omläsning. Belopp
 * normaliseras till två decimaler av samma skäl — `Decimal(10,2)` kan komma
 * tillbaka som "5000" eller "5000.00" beroende på väg.
 *
 * `v` är underlagets version. Ändras formen nedan måste den räknas upp, annars
 * blir gamla hashar tyst ojämförbara med nya i stället för synligt ojämförbara.
 */
export const SIGNATUR_UNDERLAG_VERSION = 1

/**
 * Felmeddelandet när någon försöker skriva i ett signerat protokoll.
 *
 * Det bor här, delat av alla fyra skrivvägarna, av samma skäl som spärren gör
 * det: fyra egna formuleringar hade blivit fyra olika besked för samma sak, och
 * det är ur sådana skillnader en anropare börjar gissa vilken väg som är öppen.
 */
export const BESIKTNING_SIGNERAD_MEDDELANDE =
  'Besiktningen är signerad och kan inte ändras. Ett signerat besiktningsprotokoll är bevisunderlag vid en depositionstvist.'

/** En besiktningspost, så mycket av den som signeringen binder. */
export type SignedContentItem = {
  id: string
  room: string
  item: string
  condition: string
  notes: string | null
  /** `Prisma.Decimal | number | null` — normaliseras nedan. */
  repairCost: unknown
}

/** En besiktningsbild, så mycket av den som signeringen binder. */
export type SignedContentImage = {
  id: string
  filename: string
  storageKey: string
  caption: string | null
  room: string | null
  size: number
}

/** Protokollets innehåll — indata till hashen. */
export type SignedContent = {
  id: string
  type: string
  scheduledDate: Date
  completedAt: Date | null
  overallCondition: string | null
  notes: string | null
  items: SignedContentItem[]
  images: SignedContentImage[]
}

/**
 * `Decimal(10, 2)` → exakt två decimaler, eller null.
 *
 * Prisma.Decimal implementerar `toFixed`. Vägen via `Number` finns för
 * anropare som redan hunnit få ett vanligt tal (AI-analysen skickar `number`),
 * och tappar precision först bortom 2^53 — långt utanför kolumnens tak.
 */
function normaliseraBelopp(värde: unknown): string | null {
  if (värde === null || värde === undefined) return null
  if (
    typeof värde === 'object' &&
    'toFixed' in värde &&
    typeof (värde as { toFixed: unknown }).toFixed === 'function'
  ) {
    return (värde as { toFixed(antal: number): string }).toFixed(2)
  }
  return Number(värde).toFixed(2)
}

function påId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Den kanoniska bilden av vad som signerades. Exporterad separat från hashen
 * därför att den är läsbar: faller ett prov går det att jämföra två underlag
 * och SE vilket fält som skiljer, i stället för två olika hexsträngar.
 */
export function buildSignedContent(besiktning: SignedContent): Record<string, unknown> {
  return {
    v: SIGNATUR_UNDERLAG_VERSION,
    inspectionId: besiktning.id,
    type: besiktning.type,
    scheduledDate: besiktning.scheduledDate.toISOString(),
    completedAt: besiktning.completedAt ? besiktning.completedAt.toISOString() : null,
    overallCondition: besiktning.overallCondition,
    notes: besiktning.notes,
    items: [...besiktning.items].sort(påId).map((post) => ({
      id: post.id,
      room: post.room,
      item: post.item,
      condition: post.condition,
      notes: post.notes,
      repairCost: normaliseraBelopp(post.repairCost),
    })),
    images: [...besiktning.images].sort(påId).map((bild) => ({
      id: bild.id,
      filename: bild.filename,
      storageKey: bild.storageKey,
      caption: bild.caption,
      room: bild.room,
      size: bild.size,
    })),
  }
}

/** sha256 över det kanoniska underlaget, hex. */
export function computeSignedContentHash(besiktning: SignedContent): string {
  return createHash('sha256')
    .update(JSON.stringify(buildSignedContent(besiktning)), 'utf8')
    .digest('hex')
}
