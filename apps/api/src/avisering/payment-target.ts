import { validateSwedishBankgiro } from '@eken/shared'

/**
 * FÖRKONTROLLEN AV BETALNINGSMÅLET — EN chokepunkt för alla avsedda utskick.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Kundprovet 2026-09-23 skickade tre avier till en hyresgäst där
 * `Organization.bankgiro` var `null`. Dokumentet bar `TILL BANKGIRO 0000-0000`,
 * ett mål produkten hittade på i renderingen
 * (`avisering.service.ts:1052` i basen: `org.bankgiro ?? '0000-0000'`).
 * Hyresgästen fick alltså ett betalningsinstrument som inte gick att betala, och
 * hyresvärden fick ett SENT som såg riktigt ut.
 *
 * ── VAD DEN HÄR FILEN MÄTER, OCH VAD DEN INTE KAN SE ────────────────────────
 *
 * Den här mäter att organisationen HAR ett giltigt betalningsmål. Den säger
 * ingenting om att målet är hyresvärdens EGET bankgiro — det kan bara
 * organisationen själv och Bankgirot svara på, och ingen kontrollsiffra i
 * världen upptäcker ett korrekt nummer som tillhör någon annan.
 *
 * Den mäter inte heller att utskicket verkligen uteblev. Att grinden är
 * PÅKOPPLAD på varje väg bärs av `avisering.payment-target.spec.ts` och
 * `rent-reminder.payment-target.spec.ts`, som räknar mejl i en fångare — inte av
 * den här filen.
 */

/** Koden är stabil och läsbar i loggar; meddelandet är för människan. */
export type PaymentTargetBlockCode = 'PAYMENT_TARGET_MISSING' | 'PAYMENT_TARGET_INVALID'

export interface PaymentTargetBlock {
  code: PaymentTargetBlockCode
  /** Svensk text, skriven för hyresvärden. Hamnar i `sendError` och i UI:t. */
  message: string
}

export type PaymentTargetVerdict =
  | { ok: true; bankgiro: string }
  | { ok: false; block: PaymentTargetBlock }

/**
 * Var hyresvärden rättar det. Står som EN sträng därför att den läses på tre
 * ställen (avins `sendError`, påminnelsens händelselogg, cron-loggen) och en
 * anvisning som pekar på olika ställen är värre än ingen anvisning.
 */
export const PAYMENT_TARGET_FIX_HINT =
  'Lägg till organisationens bankgiro under Inställningar → Betalningsinformation.'

export function checkPaymentTarget(org: { bankgiro?: string | null }): PaymentTargetVerdict {
  const result = validateSwedishBankgiro(org.bankgiro)
  if (result.valid && result.normalized) {
    return { ok: true, bankgiro: result.normalized }
  }
  // SAKNAT och OGILTIGT är två koder därför att de kräver olika handling av
  // hyresvärden: det första är ett fält som aldrig fyllts i, det andra ett värde
  // som behöver rättas. `missing` täcker även blankt/whitespace — ett fält som
  // bara innehåller mellanslag är inte ifyllt.
  const tomt = org.bankgiro == null || !String(org.bankgiro).trim()
  return {
    ok: false,
    block: {
      code: tomt ? 'PAYMENT_TARGET_MISSING' : 'PAYMENT_TARGET_INVALID',
      message: `${result.error ?? 'Betalningsmålet är ogiltigt'}. ${PAYMENT_TARGET_FIX_HINT}`,
    },
  }
}
