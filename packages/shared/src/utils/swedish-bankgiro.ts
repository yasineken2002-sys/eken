// Validering av mottagarens BANKGIRONUMMER — betalningsmålet på en hyresavi.
//
// Exporteras från @eken/shared så att webben kan ställa exakt samma fråga i
// formuläret som API:et ställer före ett utskick. En regel, ett ställe (samma
// skäl som `swedish-org-number.ts` finns här och inte i respektive app).
//
// ── VAD DET HÄR INTE ÄR ─────────────────────────────────────────────────────
//
// Det här är MOTTAGARENS bankgiro, alltså vart hyresgästen betalar. Det är inte
// `BankAccount`, som är bankimportens MÅLKONTO i bokföringen. De två blandas
// lätt ihop därför att båda "är ett bankkonto", men de svarar på olika frågor:
//
//     bankgiro (Organization)   vart betalar hyresgästen?
//     BankAccount              vilket konto stämmer vi av importerade rader mot?
//
// En avi kan inte skickas utan det första. Den bryr sig inte om det andra.

/** Samma form som `OrgNumberValidationResult` — avsiktligt, så anroparen känner igen den. */
export interface BankgiroValidationResult {
  valid: boolean
  /** Normaliserad visningsform: `XXX-XXXX` (7 siffror) eller `XXXX-XXXX` (8). */
  normalized?: string
  /** Svenskt felmeddelande. Sätts bara när `valid` är falskt. */
  error?: string
}

/**
 * Bankgirots modulus-10 (Luhn) över HELA numret, kontrollsiffran inräknad.
 *
 * ── VARFÖR DEN INTE ÅTERANVÄNDER `luhnChecksum` FRÅN SAMMA PAKET ────────────
 *
 * Det ser ut som en dubblett och är det inte. `luhnChecksum` i `utils/index.ts`
 * dubblar INTE basens högraste siffra, och är därmed en annan funktion än
 * standard-Luhn. Mätt 2026-09-23:
 *
 *   klassiskt Luhn-facit   bas 7992739871 → kontrollsiffra 3
 *   luhnChecksum           bas 7992739871 → kontrollsiffra 4
 *
 * Och mätt mot sex bankgironummer som går att kontrollera utifrån
 * (5050-1055 Skatteverket, 900-8004, 901-9514, 902-0900, 900-8046, 902-0033):
 *
 *   standard-Luhn (nedan)  6 av 6 giltiga
 *   luhnChecksum           0 av 6 giltiga
 *
 * De två svarar alltså på olika frågor. `luhnChecksum` svarar "vilken
 * kontrollsiffra sätter Evenos EGEN OCR-generator på ett fakturanummer" — den
 * genererar och validerar med samma funktion och är internt konsistent. Den
 * svarar INTE "är det här ett bankgironummer utgivet av Bankgirot". Att låna den
 * hade avvisat varje verkligt bankgiro, vilket är en värre defekt än den som
 * lagades: den blockerar giltiga utskick.
 *
 * Byt alltså inte ut den här mot `luhnChecksum` i en förenkling. Provet
 * `swedish-bankgiro.spec.ts` fäller det.
 */
function bankgiroLuhnOk(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits.charAt(i))
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Bankgironummer är 7 eller 8 siffror (XXX-XXXX respektive XXXX-XXXX). */
const BANKGIRO_MIN_DIGITS = 7
const BANKGIRO_MAX_DIGITS = 8

export function validateSwedishBankgiro(raw: string | null | undefined): BankgiroValidationResult {
  if (raw == null || !raw.trim()) {
    return {
      valid: false,
      error: 'Bankgiro saknas — hyresgästen har ingen betalningsmottagare att betala till',
    }
  }

  const cleaned = raw.replace(/[\s-]/g, '')

  if (!/^\d+$/.test(cleaned)) {
    return { valid: false, error: 'Bankgiro får bara innehålla siffror och bindestreck' }
  }

  if (cleaned.length < BANKGIRO_MIN_DIGITS || cleaned.length > BANKGIRO_MAX_DIGITS) {
    return {
      valid: false,
      error: `Bankgiro måste ha ${BANKGIRO_MIN_DIGITS} eller ${BANKGIRO_MAX_DIGITS} siffror (XXX-XXXX eller XXXX-XXXX) — du angav ${cleaned.length}`,
    }
  }

  // ── ENBART NOLLOR ÄR EN EGEN REGEL, INTE EN KONTROLLSIFFREFRÅGA ───────────
  //
  // `0000-0000` var det värde produkten själv hittade på när bankgirot fattades
  // (kundprovet 2026-09-23), och det passerar BÅDA modulus-10-varianterna:
  // summan är noll, och noll modulo tio är noll. Kontrollsiffran kan alltså
  // aldrig avvisa det. Raden nedan är inte en bankregel — den avvisar en
  // platshållare, och det är hela dess uppgift.
  if (/^0+$/.test(cleaned)) {
    return {
      valid: false,
      error: 'Bankgiro kan inte bestå av enbart nollor — ange organisationens riktiga bankgiro',
    }
  }

  if (!bankgiroLuhnOk(cleaned)) {
    return {
      valid: false,
      error: 'Bankgiro: kontrollsiffran stämmer inte (Bankgirots modulus-10)',
    }
  }

  const split = cleaned.length - 4
  return { valid: true, normalized: `${cleaned.slice(0, split)}-${cleaned.slice(split)}` }
}
