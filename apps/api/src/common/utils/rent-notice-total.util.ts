import type { Decimal } from '@prisma/client/runtime/library'

// Betalbar total på en hyresavi = hyran (totalAmount) + förbrukning på avi-rader
// (consumptionAmount, IMD/PR 4). amount/vatAmount/totalAmount avser ENBART hyran
// och bokförs av hyresverifikatet; förbrukningen har sitt EGNA periodiserade
// verifikat (PR 3). Detta är vad hyresgästen faktiskt betalar — används för
// OCR-rad, PDF-total, e-postbelopp, hyresgästportal och bankavstämning. Summan
// av 1510-debet (hyresverifikat + förbrukningsverifikat) = denna betalbara total.
export function rentNoticePayableTotal(notice: {
  totalAmount: Decimal | number
  consumptionAmount: Decimal | number
}): number {
  return Number(notice.totalAmount) + Number(notice.consumptionAmount)
}
