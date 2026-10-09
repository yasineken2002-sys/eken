/**
 * TESTKUND-016 (KRITERIER-H4-016 K1): Fortnox textkontrakt för verifikatets fritextfält.
 *
 * KÄLLA [K]: Fortnox «Formats & Encoding», avsnitt «Valid characters»
 *   https://www.fortnox.se/developer/guides-and-good-to-know/formats-and-encoding
 *   hämtad 2026-10-09; teckenklassen ordagrant (sha256 b18d69cb4530a39fc408c93d7bccaf059ae2e4ff44293f0518a8659793e72c7):
 *   [\p{L}\’\\\x{0308}\x{030a}a-zåäöéáœæøüA-ZÅÄÖÉÁÜŒÆØ0-9 –:\.`´’,;\^¤#%§£$€¢¥©™°&\/\(\)=\+\-\*_\!?²³®½\@\x{00a0}\n\r]*
 * Nedan är samma klass i JS u-läge: \x{..} skrivs \u{..}, och escapes som är ogiltiga i u-läge
 * (\! \@ \’) skrivs som tecknet självt — samma kodpunkter (kontrollerat U+0000–U+2FFF, 0 skillnader).
 * \p{L} = Unicode General Category Letter. Av kombinationstecken ingår ENDAST U+0308 och U+030A;
 * t.ex. NFD-é (e + U+0301) ligger utanför och stoppas — ingen tyst NFC-normalisering.
 *
 * OBSERVERAT [O] (H3H4-REAL-002 svar-0112): Description med U+2014 avvisades 400/2000359. U+2014 är
 * det enda tecknet i den texten som ligger utanför klassen; felmeddelandet bevisar inte vilket.
 *
 * Kodning: texten skickas som UTF-8 JSON (JSON.stringify), utan HTML-kodning — oförändrat från
 * tidigare. Att t.ex. «&» godtas så av Fortnox är INTE externt provat (KRITERIER K1.5).
 *
 * Regeln: exakt EN mappning (produktens egen U+2014 → U+2013, ett tecken mot ett, omgivande
 * mellanslag bevaras). Allt annat utanför klassen → TEXT_NOT_EXPORTABLE före POST. Ingen
 * borttagning, ingen avkortning. Eveno-verifikatets egen text skrivs aldrig om.
 */
export const TEXT_REGEL_VERSION = 'fortnox-valid-characters/2026-10-09+U2014-U2013'

const GILTIGT_TECKEN =
  /^[\p{L}’\\\u{0308}\u{030a}a-zåäöéáœæøüA-ZÅÄÖÉÁÜŒÆØ0-9 –:.`´’,;^¤#%§£$€¢¥©™°&/()=+\-*_!?²³®½@\u{00a0}\n\r]$/u

/** Fryst mappningstabell: [från, till]. */
export const TEXT_MAPPNINGAR: ReadonlyArray<readonly [string, string]> = [['—', '–']]

export type FortnoxTextFalt = 'Description' | 'TransactionInformation' | 'Comments'

export interface FortnoxTextMappning {
  fran: string
  till: string
  antal: number
}

export type FortnoxTextResultat =
  | { ok: true; export: string; mappningar: FortnoxTextMappning[] }
  | { ok: false; tecken: Array<{ kodpunkt: string; tecken: string; position: number }> }

const kodpunkt = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

export function arGiltigtFortnoxTecken(c: string): boolean {
  return GILTIGT_TECKEN.test(c)
}

/**
 * Exporttext för ett fält. Comments är produktgenererad: den valideras men mappas inte (K1.4).
 */
export function fortnoxText(ra: string, falt: FortnoxTextFalt): FortnoxTextResultat {
  let ut = ra
  const mappningar: FortnoxTextMappning[] = []
  if (falt !== 'Comments') {
    for (const [fran, till] of TEXT_MAPPNINGAR) {
      const antal = ut.split(fran).length - 1
      if (antal > 0) {
        ut = ut.split(fran).join(till)
        mappningar.push({ fran: kodpunkt(fran), till: kodpunkt(till), antal })
      }
    }
  }
  const fel: Array<{ kodpunkt: string; tecken: string; position: number }> = []
  let position = 0
  for (const c of ut) {
    if (!arGiltigtFortnoxTecken(c)) fel.push({ kodpunkt: kodpunkt(c), tecken: c, position })
    position++
  }
  if (fel.length) return { ok: false, tecken: fel }
  return { ok: true, export: ut, mappningar }
}

/** Kundläsbart stoppskäl: fält, rad och kodpunkt i klartext. */
export function textStoppMeddelande(
  falt: FortnoxTextFalt,
  rad: number | null,
  tecken: Array<{ kodpunkt: string; tecken: string }>,
): string {
  const unika = [...new Map(tecken.map((t) => [t.kodpunkt, t])).values()]
  const lista = unika
    .map((t) =>
      /[\p{L}\p{N}\p{P}\p{S}]/u.test(t.tecken) ? `«${t.tecken}» (${t.kodpunkt})` : t.kodpunkt,
    )
    .join(', ')
  const var_ = rad === null ? falt : `${falt} på rad ${rad}`
  return `Texten i ${var_} innehåller tecken som Fortnox inte tar emot: ${lista}. Ändra texten i Eveno före export.`
}
