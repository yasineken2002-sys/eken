/**
 * Pure persistence-boundary proof. Run separate processes with TZ and
 * RENT_NOTICE_PERIOD_EXPECT_TZ set to Europe/Stockholm, America/Los_Angeles or UTC.
 * CI alone defaults the expected zone to UTC; changing process.env.TZ inside Jest
 * is deliberately not a substitute for a real process timezone.
 * This does not claim LA correctness for the lease calculator or a financial flow.
 */
import { rentNoticePeriodDate } from './rent-notice-period-date'

const expectedTimeZone =
  process.env.RENT_NOTICE_PERIOD_EXPECT_TZ ?? (process.env.CI === 'true' ? 'UTC' : undefined)

it('uses the explicitly selected real process timezone', () => {
  expect(['Europe/Stockholm', 'America/Los_Angeles', 'UTC']).toContain(expectedTimeZone)
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(expectedTimeZone)
})

it.each([
  { year: 2027, month: 3, day: 16, expected: '2027-03-16T00:00:00.000Z' },
  { year: 2027, month: 3, day: 31, expected: '2027-03-31T00:00:00.000Z' },
  { year: 2027, month: 11, day: 1, expected: '2027-11-01T00:00:00.000Z' },
  { year: 2028, month: 2, day: 29, expected: '2028-02-29T00:00:00.000Z' },
  { year: 2027, month: 12, day: 31, expected: '2027-12-31T00:00:00.000Z' },
])(
  'encodes local calendar $year-$month-$day as $expected without changing its input',
  ({ year, month, day, expected }) => {
    // Mirrors the calculator's INPUT representation, not its implementation or output oracle.
    // ISO expectations above are literal Gregorian days, independent of any product helper.
    const localMidnight = new Date(year, month - 1, day)
    const before = localMidnight.getTime()
    expect([
      localMidnight.getFullYear(),
      localMidnight.getMonth() + 1,
      localMidnight.getDate(),
    ]).toEqual([year, month, day])
    const result = rentNoticePeriodDate(localMidnight)
    expect(result.toISOString()).toBe(expected)
    expect(result).not.toBe(localMidnight)
    expect(localMidnight.getTime()).toBe(before)
  },
)
