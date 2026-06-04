/**
 * Deterministisk enhetsmatchning för batch-kontraktsskanning (PR2).
 *
 * REN logik — ingen AI, inga nätverksanrop, inga sidoeffekter. Givet en skannad
 * rad och en lista kandidat-Units (redan org-scopade av anroparen) returneras
 * ett FÖRSLAG på vilken Unit kontraktet gäller. Förslaget skapar ALDRIG ett
 * avtal — det kräver mänskligt godkännande i PR3.
 *
 * Matchningen är medvetet STRIKT: ett felaktigt AUTO_MATCHED är värre än ett
 * NO_MATCH (en människa hanterar NO_MATCH; ett tyst felmatchat avtal är en bugg).
 * Därför krävs att BÅDE adress och lägenhetsnummer matchar, och tvetydiga fall
 * (flera kandidater) lämnas orörda i stället för att gissa.
 */

export type MatchOutcome = 'AUTO_MATCHED' | 'AMBIGUOUS' | 'NO_MATCH' | 'NEEDS_REVIEW'

export interface MatchInput {
  propertyAddress: string | null
  unitDescription: string | null
  confidence: number
}

export interface MatchCandidateUnit {
  id: string
  unitNumber: string
  property: { street: string; postalCode: string; city: string }
}

export interface MatchResult {
  status: MatchOutcome
  unitId: string | null
}

/**
 * Strategi-gränssnitt (v2-söm). MVP är den deterministiska matchern nedan; en
 * Haiku-baserad fallback för AMBIGUOUS-rader kan implementera samma gränssnitt
 * och kopplas in senare UTAN att röra anroparen. Den anropas inte i PR2.
 */
export interface UnitMatchStrategy {
  match(input: MatchInput, candidates: MatchCandidateUnit[]): MatchResult
}

// Under denna skanningskonfidens litar vi inte på de extraherade fälten nog för
// att auto-matcha — raden går till mänsklig granskning i stället.
export const MIN_MATCH_CONFIDENCE = 0.6

// Vanliga svenska prefix framför ett lägenhets-/lokalnummer. Strippas bara när
// det följs av en siffra, så ett riktigt ord (t.ex. "Nordica") inte kapas.
const UNIT_PREFIXES = ['lagenhet', 'lägenhet', 'lokal', 'objekt', 'unit', 'apt', 'lgh', 'nr', 'no']

/**
 * Normalisera en sträng för deterministisk jämförelse: gemener, behåll bokstäver
 * (inkl. å/ä/ö) och siffror, släng allt annat — mellanslag, komma, punkt,
 * bindestreck. "Storgatan 1, 114 51 Stockholm" → "storgatan111451stockholm".
 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-zåäö]/g, '')
}

/**
 * Normalisera ett lägenhetsnummer: som normalizeText, men strippar dessutom ett
 * inledande prefix ("Lägenhet 1201" / "Lgh 1201" / "1201" → "1201").
 */
export function normalizeUnitNumber(s: string): string {
  const t = normalizeText(s)
  for (const p of UNIT_PREFIXES) {
    if (t.startsWith(p) && /\d/.test(t.charAt(p.length))) {
      return t.slice(p.length)
    }
  }
  return t
}

/**
 * En kandidat-adress matchar om den normaliserade skannade adressen innehåller
 * fastighetens gata OCH dess ort (postnummer eller stad). Att kräva ort utöver
 * gatan skyddar mot att samma gatunamn i två orter felmatchas.
 */
function addressMatches(
  normScannedAddress: string,
  property: { street: string; postalCode: string; city: string },
): boolean {
  const street = normalizeText(property.street)
  if (street === '' || !normScannedAddress.includes(street)) return false
  const postal = normalizeText(property.postalCode)
  const city = normalizeText(property.city)
  const hasLocality =
    (postal !== '' && normScannedAddress.includes(postal)) ||
    (city !== '' && normScannedAddress.includes(city))
  return hasLocality
}

/**
 * Deterministisk MVP-matcher. Exakt-EN-regeln:
 *   • saknat adress-/lägenhetsfält eller låg konfidens → NEEDS_REVIEW
 *   • exakt 1 kandidat (adress + lägenhetsnummer) → AUTO_MATCHED
 *   • >1 kandidat → AMBIGUOUS (lämnas orörd)
 *   • 0 kandidater → NO_MATCH
 */
export const deterministicUnitMatcher: UnitMatchStrategy = {
  match(input, candidates) {
    const addr = input.propertyAddress?.trim() ?? ''
    const unit = input.unitDescription?.trim() ?? ''

    // Saknat fält eller låg konfidens → mänsklig granskning (ingen gissning).
    if (addr === '' || unit === '' || input.confidence < MIN_MATCH_CONFIDENCE) {
      return { status: 'NEEDS_REVIEW', unitId: null }
    }

    const normAddr = normalizeText(addr)
    const normUnit = normalizeUnitNumber(unit)
    // Lägenhetsfältet saknade ett användbart nummer (t.ex. bara "Lägenhet" eller
    // tomt efter normalisering) → mänsklig granskning hellre än tyst NO_MATCH.
    if (normUnit === '' || !/\d/.test(normUnit)) {
      return { status: 'NEEDS_REVIEW', unitId: null }
    }

    const matches = candidates.filter(
      (c) => normalizeUnitNumber(c.unitNumber) === normUnit && addressMatches(normAddr, c.property),
    )

    if (matches.length === 1) return { status: 'AUTO_MATCHED', unitId: matches[0]!.id }
    if (matches.length > 1) return { status: 'AMBIGUOUS', unitId: null }
    return { status: 'NO_MATCH', unitId: null }
  },
}
