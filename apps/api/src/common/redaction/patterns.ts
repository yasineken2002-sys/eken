/**
 * MÖNSTREN — ETT ställe, två tillämpningar (#507).
 *
 * Reguljära uttryck som känner igen värden på FORM. De används av två syskon som
 * gör olika saker med samma träffar:
 *
 *   `AUDIT_PATTERNS`   (#508) via `maskSensitivePatterns` — maskerar vid
 *                      SKRIVNING till `AiToolExecution`. Den tabellen replayas
 *                      aldrig till modellen och läses aldrig i produkten.
 *   `DISPLAY_PATTERNS` (#507) via `maskForDisplay` — maskerar vid VISNING av
 *                      lagrade AI-samtal. Raden i databasen är orörd; modellen
 *                      får den orörd.
 *
 * Att mönstren bor här och inte i respektive fil är hela poängen: en förbättrad
 * regex ska gälla båda, och en ny betalidentifierare ska inte behöva läggas till
 * på två ställen. Att KOMPOSITIONERNA skiljer sig är däremot avsiktligt — se
 * respektive funktion.
 */

export const REPLACEMENT = '***MASKERAT***'

/**
 * Svenskt personnummer, med eller utan sekel och avskiljare.
 *
 * Fångar även samordningsnummer (dag + 60). Den är MED FLIT bred: ett tal som
 * ser ut som ett personnummer ska maskeras även om det inte är någons.
 */
export const SWEDISH_PNR = /\b(?:\d{2})?\d{6}[-+]?\d{4}\b/g

/** Organisationsnummer. Överlappar PNR-formen — därför alltid samma ersättning. */
export const SWEDISH_ORGNR = /\b\d{6}-\d{4}\b/g

export const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g

/** Svenskt mobilnummer, med eller utan landskod. */
export const SWEDISH_MOBILE = /(?:\+46[\s-]?7\d|\b07\d)(?:[\s-]?\d){7}\b/g

/**
 * Svenskt fast nummer: riktnummer 2–4 siffror + 5–8 siffror.
 *
 * Snävare än mobilmönstret med flit: utan kravet på avskiljare hade den träffat
 * varje längre siffergrupp, till exempel ett verifikationsnummer.
 */
export const SWEDISH_LANDLINE = /\b0\d{1,3}[-\s]\d{2,4}[\s-]?\d{2,4}\b/g

/**
 * OCR-nummer på en avi eller faktura (Luhn-kontrollerat i domänen, 8–25 siffror).
 *
 * Kravet på ordgräns och minst åtta siffror håller den borta från belopp och
 * årtal. Ett OCR-nummer identifierar en enskild fordran och därmed en enskild
 * hyresgäst — det är därför det maskeras.
 */
export const OCR_NUMBER = /\b\d{8,25}\b/g

/** Bankgiro: 3-4 eller 4-4 siffror med bindestreck. */
export const BANKGIRO = /\b\d{3,4}-\d{4}\b/g

/** Plusgiro: 2–7 siffror + bindestreck + kontrollsiffra. */
export const PLUSGIRO = /\b\d{2,7}-\d\b/g

/** Clearingnummer + kontonummer, t.ex. "8327-9, 123 456 789-0". */
export const CLEARING_ACCOUNT = /\b\d{4,5}(?:-\d)?[,\s]+\d[\d\s-]{5,15}\d\b/g

/** IBAN — två bokstäver, två kontrollsiffror, upp till 30 alfanumeriska. */
export const IBAN = /\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]{4}){2,7}(?:[\s-]?[A-Z0-9]{1,4})?\b/g

/**
 * DE SEX BETALIDENTIFIERARNA + de fyra personidentifierarna, i den ordning de
 * ska tillämpas.
 *
 * ORDNINGEN ÄR INTE GODTYCKLIG. De längre och mer specifika mönstren måste gå
 * först: maskeras ett personnummer efter att OCR-mönstret ätit dess siffror finns
 * ingenting kvar att känna igen. Samma sak för clearing+konto, som innehåller
 * något som ser ut som ett bankgiro.
 */
export const DISPLAY_PATTERNS: readonly RegExp[] = [
  IBAN,
  CLEARING_ACCOUNT,
  SWEDISH_PNR,
  SWEDISH_ORGNR,
  EMAIL,
  SWEDISH_MOBILE,
  SWEDISH_LANDLINE,
  BANKGIRO,
  PLUSGIRO,
  OCR_NUMBER,
]

/**
 * #508:s uppsättning, OFÖRÄNDRAD.
 *
 * Den är smalare än visningsuppsättningen och ska förbli det tills någon
 * medvetet breddar den: `AiToolExecution` är en annan fråga med ett annat
 * ärende, och att bredda den här som sidoeffekt av #507 vore att ändra #508 utan
 * att någon bett om det.
 */
export const AUDIT_PATTERNS: readonly RegExp[] = [SWEDISH_PNR, SWEDISH_ORGNR, EMAIL, SWEDISH_MOBILE]

/** Tillämpar en uppsättning mönster på en sträng. */
export function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  let ut = value
  for (const p of patterns) {
    // Regexerna är globala och bär lastIndex — nollställ, annars blir andra
    // anropet med samma regex beroende av det första.
    p.lastIndex = 0
    ut = ut.replace(p, REPLACEMENT)
  }
  return ut
}
