/**
 * T1.4 / #44 — rena datum-/preskriptionshelprar (@eken/shared).
 * backfillRentDueDate: framåtklampad ≥30 dagars frist, aldrig historiskt, svensk
 * vardag. monthsBetween: åldersmått för preskriptionsgrinden.
 */
import {
  backfillRentDueDate,
  monthsBetween,
  BACKFILL_MIN_DAYS_UNTIL_DUE,
  BACKFILL_HARD_CAP_MONTHS,
  BACKFILL_WARNING_MONTHS,
  isSwedishBusinessDay,
} from '@eken/shared'

describe('T1.4 · backfillRentDueDate', () => {
  it('ligger minst 30 dagar framåt och aldrig i det förflutna', () => {
    const from = new Date('2026-03-15T00:00:00.000Z')
    const due = backfillRentDueDate(from)
    const minMs = from.getTime() + (BACKFILL_MIN_DAYS_UNTIL_DUE - 1) * 86_400_000
    expect(due.getTime()).toBeGreaterThanOrEqual(minMs)
    expect(due.getTime()).toBeGreaterThan(from.getTime())
  })

  it('landar alltid på en svensk vardag (klampar framåt)', () => {
    // Testa flera startdatum → resultatet är aldrig helg/röd dag.
    for (const iso of ['2026-01-05', '2026-06-10', '2026-11-20', '2026-04-01']) {
      const due = backfillRentDueDate(new Date(iso))
      expect(isSwedishBusinessDay(due)).toBe(true)
    }
  })

  it('ett historiskt periodstart-datum ger ändå en framtida förfallodag', () => {
    const now = new Date()
    const due = backfillRentDueDate(now)
    expect(due.getTime()).toBeGreaterThan(now.getTime())
  })
})

describe('T1.4 · monthsBetween + preskriptionskonstanter', () => {
  it('mäter hela kalendermånader (positivt framåt)', () => {
    expect(monthsBetween({ year: 2026, month: 7 }, { year: 2026, month: 7 })).toBe(0)
    expect(monthsBetween({ year: 2026, month: 1 }, { year: 2026, month: 7 })).toBe(6)
    expect(monthsBetween({ year: 2023, month: 1 }, { year: 2026, month: 7 })).toBe(42)
    expect(monthsBetween({ year: 2025, month: 1 }, { year: 2026, month: 7 })).toBe(18)
  })

  it('preskriptionskonstanter: 36 mån hård spärr, 12 mån varning', () => {
    expect(BACKFILL_HARD_CAP_MONTHS).toBe(36)
    expect(BACKFILL_WARNING_MONTHS).toBe(12)
    expect(BACKFILL_MIN_DAYS_UNTIL_DUE).toBe(30)
  })
})
