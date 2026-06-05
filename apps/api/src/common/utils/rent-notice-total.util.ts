import type { Decimal } from '@prisma/client/runtime/library'

// Betalbar total på en hyresavi = hyran (totalAmount) + förbrukning på avi-rader
// (consumptionAmount, IMD/PR 4) + påminnelseavgift (reminderFeeAmount, inkasso
// PR 2). amount/vatAmount/totalAmount avser ENBART hyran och bokförs av
// hyresverifikatet; förbrukningen har sitt EGNA periodiserade verifikat (PR 3);
// påminnelseavgiften sitt EGNA (1510 D / 3593 K). Detta är vad hyresgästen
// faktiskt betalar — används för OCR-rad, PDF-total, e-postbelopp,
// hyresgästportal och bankavstämning. Summan av 1510-debet (hyres- +
// förbruknings- + påminnelseverifikat) = denna betalbara total. reminderFeeAmount
// är optional med default 0 så icke-påminda avier och partiella anropare är
// oförändrade.
export function rentNoticePayableTotal(notice: {
  totalAmount: Decimal | number
  consumptionAmount: Decimal | number
  reminderFeeAmount?: Decimal | number
}): number {
  return (
    Number(notice.totalAmount) +
    Number(notice.consumptionAmount) +
    Number(notice.reminderFeeAmount ?? 0)
  )
}
