import { REMINDER_FEE_MAX_SEK } from '@eken/shared'
import { isReminderFeeContractuallyAllowed, type DebtOriginDate } from './debt-origin'

/**
 * VAD SOM FAKTISKT FÅR KRÄVAS — en beräkning, ett ställe.
 *
 * Två regler avgör beloppet på en påminnelseavgift, och båda måste vara
 * besvarade INNAN något skrivs:
 *
 *   1. AVTALSGRUNDEN (2 § lagen 1981:739). Får avgiften tas ut alls?
 *      Regeln bor i `isReminderFeeContractuallyAllowed` och uttrycks bara där.
 *   2. TAKET (4 § och 6 § 1 st samma lag). Hur mycket får krävas?
 *      Talet bor i `REMINDER_FEE_MAX_SEK` och uttrycks bara där.
 *
 * ── VARFÖR BÅDA MÅSTE SVARA FÖRE ANSPRÅKET ────────────────────────────────
 *
 * Avgiften skrivs på FLER ställen än verifikatet, och reskontrasidan skrivs
 * FÖRST:
 *
 *   RentNotice.reminderFeeAmount      (avi-vägens anspråk)
 *   PaymentReminder.feeAmount         (fakturavägens anspråk — summeras rakt in
 *                                      i inkassounderlagets avgiftskolumn)
 *   Invoice.total + avgiftsraden      (det hyresgästen ser och ska betala)
 *   verifikatet 1510/3593             (huvudboken)
 *
 * Regel 1 flyttades hit av G2 av exakt det skälet. Regel 2 låg kvar i
 * `bookReminderFee` och nådde därför BARA verifikatet: ett belopp över taket
 * som kom in förbi DTO:t (direkt SQL, ett skript, en framtida importväg) gav
 * hyresgästen kravet på hela beloppet medan huvudboken bokförde 60 kr.
 * Reskontra ≠ huvudbok — samma divergensform som #357 stängde, i en ny
 * riktning, och den var mätt i en bevisrigg innan den här filen fanns.
 *
 * Att låta båda reglerna svara på ETT ställe före anspråket gör att alla
 * skrivare per konstruktion bär samma tal. Det är den enda formen som håller:
 * en klampning hos den sista skrivaren är ingen klampning för de tre andra.
 *
 * ── TAKET STANNAR I KONSTANTEN ────────────────────────────────────────────
 *
 * Beloppet ägs av lagstiftaren, inte av oss (50 → 60 kr genom SFS 2013:56).
 * Därför står talet i `REMINDER_FEE_MAX_SEK` och ingen annanstans — en ändring
 * ska vara en kodrad, inte ett schemaingrepp. Frågan om databasen dessutom bör
 * bära en CHECK är medvetet obesvarad och lever i #403.
 *
 * ── KLAMPAS, VÄGRAS INTE ──────────────────────────────────────────────────
 *
 * Ett för högt konfigurerat belopp tar inte bort avgiften. De 60 kronorna är
 * hyresvärden faktiskt berättigad till; bara det överskjutande är ogiltigt
 * (6 § 1 st — utan konsumentavgränsning, taket är tvingande också mot
 * näringsidkare). Avtalsgrunden är den enda regeln som nollar hela avgiften.
 */
export interface ReminderFeeDecision {
  /** Beloppet som får krävas. Det ENDA tal som ska nå en skrivning. */
  readonly amount: number
  /** Vad organisationen hade konfigurerat, för loggen. Kan vara ogiltigt. */
  readonly requested: number
  /**
   * Begärt belopp låg över det lagstadgade taket. Sant OBEROENDE av
   * avtalsgrunden: flaggan beskriver konfigurationen, inte det här kravet.
   * En sann flagga betyder att någon skrivit in ett olagligt belopp och att
   * den som gjort det bör få veta varför det blev 60.
   */
  readonly cappedByLaw: boolean
  /**
   * Avtalsgrunden tillåter avgiften. Falskt är ett NORMALT utfall — det är
   * tillståndet för varje avtal utan villkor — och ska inte larmas om.
   */
  readonly contractual: boolean
}

export function resolveReminderFee(
  requested: number,
  debtOrigin: DebtOriginDate | null,
  termsFrom: Date | null,
): ReminderFeeDecision {
  // Ogiltiga och negativa belopp behandlas som "ingen avgift". Ett negativt
  // belopp hade minskat fakturans total och skrivit en negativ avgiftsrad —
  // spärrat av `@Min(0)` i DTO:n, men samma sidodörrar som taket har.
  const begärd = Number.isFinite(requested) && requested > 0 ? requested : 0
  const cappedByLaw = begärd > REMINDER_FEE_MAX_SEK
  const inomTaket = Math.min(begärd, REMINDER_FEE_MAX_SEK)
  const contractual = isReminderFeeContractuallyAllowed(debtOrigin, termsFrom)

  return {
    amount: contractual ? inomTaket : 0,
    requested,
    cappedByLaw,
    contractual,
  }
}

/**
 * Loggraden för ett klampat belopp — en formulering, båda anroparna.
 *
 * Klampningen är INTE tyst, till skillnad från avtalsgrundens vägran. En
 * vägran är ett normalt utfall; en klampning betyder att någon konfigurerat
 * ett olagligt belopp, och det är en konfiguration som behöver rättas.
 */
export function reminderFeeCapMessage(
  organizationId: string,
  decision: ReminderFeeDecision,
  context: string,
): string {
  return (
    `Påminnelseavgift klampad till det lagstadgade taket för organisation ` +
    `${organizationId} (${context}): ${decision.requested} kr konfigurerat, ` +
    `${REMINDER_FEE_MAX_SEK} kr är taket (4 § lagen 1981:739 — tvingande, 6 § 1 st). ` +
    `Kravet skrivs på ${decision.amount} kr.`
  )
}
