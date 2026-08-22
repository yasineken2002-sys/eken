import { isValidOcrNumber } from '@eken/shared'

/**
 * REGELN: en siffra ur PROSA är inte en avsiktshandling.
 *
 * ── VAD H2 LÄMNADE ÖPPET ─────────────────────────────────────────────────────
 *
 * M2 (#492) införde en tidig retur i `matchTransaction`: bär transaktionen en
 * OCR som inte löser ut lämnas den UNMATCHED i stället för att beloppsgissas.
 * Regeln är riktig — ett explicit angivet OCR är en AVSIKTSHANDLING från
 * betalaren, och en fuzzy-gissning ovanpå ett uttryckligt men felaktigt OCR ser
 * ut som ett svar utan att vara det.
 *
 * Grinden ställer villkoret `transaction.rawOcr` är satt. Det villkoret läser
 * som "betalaren angav ett OCR". Det gör det inte.
 *
 * ── VAD `rawOcr` FAKTISKT ÄR (mätt) ──────────────────────────────────────────
 *
 * `extractOcr` tar den LÄNGSTA siffersekvensen om 4–20 tecken var som helst i
 * texten. Ingen kontrollsiffra prövas. Kör man en CSV-import med en helt vanlig
 * bankbeskrivning blir utfallet:
 *
 *     "Inbetalning 20260601"          rawOcr=20260601     fuzzy körd=NEJ
 *     "Swish 0701234567 Andersson"    rawOcr=0701234567   fuzzy körd=NEJ
 *     "Hyra juni konto 12345678"      rawOcr=12345678     fuzzy körd=NEJ
 *     "Hyra Andersson"                rawOcr=undefined    fuzzy körd=JA
 *
 * Ett datum, ett mobilnummer och ett kontonummer stänger alltså av
 * beloppsmatchningen. Före #492 föll de igenom till fuzzy och matchade; efter
 * #492 blir de UNMATCHED. Grinden fires på tre av fyra realistiska
 * beskrivningar — och den betalning som borde ha matchats ligger kvar.
 *
 * Både produktionskommentaren och `ocr-tidig-retur.spec.ts` påstod motsatsen:
 * "en enkelsiffrig felskrivning ... blir aldrig en rawOcr". Påståendet gäller
 * `isValidOcrNumber`, som `extractOcr` aldrig anropar. Det var inte belagt.
 *
 * ── DISKRIMINATORN: VILKET FÄLT NUMRET KOM UR ────────────────────────────────
 *
 * Skillnaden mellan de tre första raderna och en riktig OCR är inte formen —
 * det är PROVENIENSEN. Kom strängen ur ett fält som BÄR betalningsreferensen
 * har betalaren utfört en avsiktshandling, vad den än innehåller. Skrapades den
 * fram ur bankens egen prosa har ingen människa pekat på den.
 *
 *   AVSIKTSFÄLT   BgMax TC20/21 pos 13–37, API-payloadens `ocr`, kontoutdragets
 *                 referenskolumn. Fältet ÄR referensen. Grinden ska fires även
 *                 om värdet inte klarar Luhn — ett OCR ur ett gammalt system
 *                 (Vitec/Momentum) med annan kontrollsiffra är fortfarande en
 *                 avsiktshandling, och att beloppsgissa ovanpå det är precis den
 *                 skada M2 byggdes för att hindra.
 *
 *   PROSAFÄLT     `description`. Bankens fritext. En siffersekvens här är bara
 *                 ett OCR om den bär en giltig Luhn-kontrollsiffra — och då är
 *                 den det med, för banker skriver ofta "OCR 12345678903" rakt in
 *                 i beskrivningen. Faller Luhn är det ett datum, ett telefon-
 *                 nummer eller ett kontonummer, och då ska fuzzy köra som förr.
 *
 * Proveniensen avgörs vid INGEST, där den fortfarande är känd, och behöver
 * därför varken en ny kolumn eller en härledning i efterhand. Den kostnaden är
 * inte gratis att skjuta upp: att gissa sig till var ett värde kom ifrån är
 * samma härledning-som-invariant som H1 (#553) byggde bort.
 *
 * ── VAD SOM INTE ÄNDRAS ──────────────────────────────────────────────────────
 *
 * Regeln flyttar INTE grinden och mjukar inte upp den. En OCR ur ett avsiktsfält
 * som inte löser ut lämnas fortfarande UNMATCHED — alla tre fallen nedan:
 *
 *   OCR:t finns inte alls              → UNMATCHED (ingen gissning)
 *   OCR:t finns, beloppet stämmer inte → UNMATCHED (ingen gissning)
 *   OCR:t klarar inte Luhn             → beror på PROVENIENS: avsiktsfält
 *                                        UNMATCHED, prosa → fuzzy
 *
 * Det enda som ändras är vilka strängar som över huvud taget räknas som ett
 * angivet OCR.
 */

/**
 * Fälten som BÄR betalningsreferensen. En sträng härifrån är en avsiktshandling
 * och får bli `rawOcr` rakt av — `extractOcr` utan Luhn-krav.
 *
 * Listan läses av `check-ocr-provenance.mjs`, som fäller om ett `extractOcr*`-
 * anrop i reconciliation.service.ts läser ett argument som varken står här eller
 * i `PROSE_OCR_FIELDS`. Ett oklassat fält är precis hur `description` kunde
 * matas genom den ogrindade extraktorn utan att någon tog ställning till det.
 */
export const INTENT_OCR_FIELDS = ['raw.ocr', 'raw.reference', 'row.reference'] as const

/**
 * Fälten som bär PROSA. En sträng härifrån får bara bli `rawOcr` via
 * `extractOcrFromProse`, alltså bakom Luhn-kontrollen.
 */
export const PROSE_OCR_FIELDS = ['raw.description', 'row.description'] as const

/**
 * Den råa extraktorn: längsta siffersekvensen om 4–20 tecken.
 *
 * Flyttad hit ur reconciliation.service.ts så att båda extraktorerna bor på
 * samma ställe — en guard som ska skilja dem åt kan inte göra det om den ena är
 * en privat funktion i en 2000-raders fil.
 *
 * Får bara anropas på ett AVSIKTSFÄLT. På prosa: `extractOcrFromProse`.
 */
export function extractOcr(text: string | undefined | null): string | null {
  if (!text) return null
  const matches = text.match(/\b(\d{4,20})\b/g)
  if (!matches || matches.length === 0) return null
  // Take the longest numeric sequence (most likely to be OCR)
  return matches.reduce((a, b) => (b.length > a.length ? b : a))
}

/**
 * Extraktorn för PROSA. Samma sekvens, men bara om den bär en giltig
 * Luhn-kontrollsiffra.
 *
 * `isValidOcrNumber` kommer från @eken/shared — samma funktion som
 * `generateOcrNumber` sätter kontrollsiffran med, så det som Evenos egna
 * sekvenser delar ut passerar per konstruktion. Ingen andra implementation av
 * Luhn införs här.
 */
export function extractOcrFromProse(text: string | undefined | null): string | null {
  const kandidat = extractOcr(text)
  if (kandidat === null) return null
  return isValidOcrNumber(kandidat) ? kandidat : null
}
