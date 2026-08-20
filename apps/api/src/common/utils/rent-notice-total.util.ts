import type { Decimal } from '@prisma/client/runtime/library'

import { rentNoticeOcrComponents } from '../../avisering/rent-debt.service'

/**
 * Betalbar total på en hyresavi — vad hyresgästen faktiskt betalar med avins OCR.
 *
 * = hyran (`totalAmount`) + förbrukning på avi-rader (`consumptionAmount`, IMD)
 * + övriga debiterbara poster (`miscChargeAmount`, teknisk förvaltning Spår A)
 * + påminnelseavgift (`reminderFeeAmount`) − krediteringar (`credits`, #518).
 *
 * `amount`/`vatAmount`/`totalAmount` avser ENBART hyran och bokförs av
 * hyresverifikatet; förbrukningen har sitt EGNA periodiserade verifikat;
 * övriga debiteringar sitt EGNA (1510 D / 3990 K); påminnelseavgiften sitt EGNA
 * (1510 D / 3593 K); krediteringen sitt EGNA (39xx D / 1510 K). Summan av
 * 1510-rörelserna = den här betalbara totalen.
 *
 * ── RÄKNAR INTE SJÄLV (#518) ────────────────────────────────────────────────
 *
 * Kroppen delegerar till `rentNoticeOcrComponents`, som är den ENDA definitionen
 * av avins OCR-bärande poster i kodbasen. Före #518 fanns uttrycket på tre
 * ställen: här, i `computeRentDebt` och som en inline-dubblett i
 * bankavstämningens fuzzy-matchning. Den tredje var den farliga — missar en av
 * dem krediteringen matchar en KORREKT inbetalning inte längre mot avin, och
 * pengarna blir liggande omatchade medan avin ser reglerad ut.
 *
 * ── `credits` ÄR OBLIGATORISK ───────────────────────────────────────────────
 *
 * Samma spärr som `payments` på `rentNoticeOutstanding`, och av samma skäl: en
 * default `[]` hade gjort varje befintlig anropare tyst blind för krediteringar
 * och skickat bruttot i ett betalningsunderlag till en hyresgäst vars avi satts
 * ned. Att fältet är obligatoriskt tvingar TypeScript att peka ut varje sådan
 * yta, en gång, vid införandet. Tom array är ett giltigt och vanligt värde —
 * skillnaden mot en default är att den som skriver `[]` har SETT frågan.
 *
 * KLAMPAD VID 0: det här talet trycks i dokument och mejl. En överkreditering
 * (spärrad på skrivvägen) får aldrig bli ett negativt krav i ett brev. Behöver
 * du den signerade signalen finns den i `rentNoticeOcrComponents(...).net`.
 */
export function rentNoticePayableTotal(notice: {
  totalAmount: Decimal | number
  consumptionAmount: Decimal | number
  miscChargeAmount?: Decimal | number
  reminderFeeAmount?: Decimal | number
  credits: Array<{ amount: Decimal | number }>
}): number {
  const { net } = rentNoticeOcrComponents({
    ...notice,
    credits: notice.credits.map((c) => c.amount),
  })
  return Math.max(0, net.toNumber())
}
