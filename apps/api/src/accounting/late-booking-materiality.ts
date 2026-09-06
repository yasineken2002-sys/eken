import { Prisma } from '@prisma/client'

/**
 * VÄSENTLIGHETSGRÄNSEN FÖR EN SENT BOKFÖRD BETALNING — EN läsare, inget tal.
 *
 * ── VAD GRÄNSEN FAKTISKT STYR (mätt på main, dc70c3ab) ──────────────────────
 *
 * Exakt EN sak: om `LateFiscalYearPosting.materialityFlagged` blir true.
 * Uppräkningen av vad som läser flaggan gav NOLL träffar utanför skrivningen
 * själv och två assertions i dess egen spec — ingen vy, ingen rapport, ingen
 * spärr och ingen varning.
 *
 * Den är alltså inte ett hinder och inte ett extra krav på operatören.
 * Betalningen bokförs likadant över som under gränsen. Flaggan MARKERAR posten
 * för mänsklig efterhandsbedömning: ett väsentligt belopp som bokförs i ett
 * senare år kan kräva justering av ingående eget kapital i stället för att bara
 * löpa genom årets resultat (BFN, fel hänförliga till ett fastställt
 * räkenskapsår). Bedömningen tillhör en människa.
 *
 * Det är viktigt att texten ovan inte glider: hjälptexten i inställningarna är
 * skriven mot den här beskrivningen, och en hjälptext som lovar en spärr som
 * inte finns är värre än ingen hjälptext.
 *
 * ── VARFÖR EN FUNKTION OCH INTE ETT TAL ─────────────────────────────────────
 *
 * Gränsen bor i `Organization.lateBookingMaterialityThreshold` (ören). Varje
 * läsare går genom `arVasentligtBelopp` nedan, så det finns ingen andra kopia
 * av vare sig talet eller jämförelsen. I dag finns en enda anropare —
 * `createNumberedEntry` — och det är just därför formen ska sättas nu: nästa
 * läsare (en rapport, en vy) ska ärva jämförelsen i stället för att skriva om
 * den.
 *
 * ── ÖREN MOT KRONOR, OCH VARFÖR JÄMFÖRELSEN GÖRS I DECIMAL ──────────────────
 *
 * Kolumnen är ören (heltal); beloppet är kronor i `Prisma.Decimal`. Talen
 * konverteras därför i Decimal och aldrig via `Number` — en gräns som passerar
 * en float jämförs inte längre exakt mot ett tvådecimaligt belopp, och exakt på
 * gränsen är det skillnaden mellan flaggad och oflaggad.
 */

/** Kolumnens default, i ören. Samma tal som den gamla hårdkodade gränsen. */
export const SEN_BOKFORING_VASENTLIGHET_DEFAULT_ORE = 1_000_000

/** Minsta Prisma-yta läsningen behöver — strukturellt oförmögen att skriva. */
export type MaterialityClient = {
  organization: {
    findUnique(args: {
      where: { id: string }
      select: { lateBookingMaterialityThreshold: true }
    }): Promise<{ lateBookingMaterialityThreshold: number } | null>
  }
}

/**
 * Är beloppet väsentligt för den här organisationen?
 *
 * `belopp` är KRONOR (samma enhet som verifikatets rader). Gränsen läses i ören
 * ur organisationen och konverteras här — anroparen ska inte behöva veta att
 * kolumnen har en annan enhet än beloppet.
 *
 * Saknas organisationen faller vi tillbaka på defaulten i stället för att kasta.
 * Skälet är att den här funktionen kallas MITT I en betalningstransaktion: att
 * fälla en bokföring på att en policy-kolumn inte gick att läsa vore att låta en
 * markering stoppa en affärshändelse. Fallbacken är dessutom det gamla
 * beteendet, alltså inte en gissning utan den dokumenterade defaulten.
 */
export async function arVasentligtBelopp(
  client: MaterialityClient,
  organizationId: string,
  belopp: Prisma.Decimal,
): Promise<boolean> {
  const org = await client.organization.findUnique({
    where: { id: organizationId },
    select: { lateBookingMaterialityThreshold: true },
  })
  const gransOre = org?.lateBookingMaterialityThreshold ?? SEN_BOKFORING_VASENTLIGHET_DEFAULT_ORE
  return belopp.greaterThanOrEqualTo(oreTillKronor(gransOre))
}

/** Ören → kronor, i Decimal. Aldrig via `Number` — se filens docblock. */
export function oreTillKronor(ore: number): Prisma.Decimal {
  return new Prisma.Decimal(ore).dividedBy(100)
}
