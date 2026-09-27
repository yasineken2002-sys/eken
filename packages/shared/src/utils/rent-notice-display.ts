import type { RentNoticeStatusValue } from '../schemas'
import { swedishDaysBetween } from './swedish-calendar'

/** Visningsstatus för hyresavier; ändrar aldrig lagrad status eller betalningshistorik. */
export function rentNoticeDisplayStatus(
  notice: { status: RentNoticeStatusValue; dueDate: Date | string; payableTotal: number },
  now: Date = new Date(),
): RentNoticeStatusValue {
  if (notice.status !== 'SENT' && notice.status !== 'OVERDUE') return notice.status
  // Samma restskuld som portalen, inte totalAmount eller paidAmount-cachen.
  return notice.payableTotal > 0 && swedishDaysBetween(new Date(notice.dueDate), now) > 0
    ? 'OVERDUE'
    : 'SENT'
}
