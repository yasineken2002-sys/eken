/** RFC 9110 §10.2.3: integer delay-seconds or an HTTP-date; never parse arbitrary numeric dates. */
export function parseFortnoxRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined
  const field = value.trim()
  if (/^\d+$/.test(field)) {
    // A huge valid delay must stop retries, not overflow a timer into an immediate retry.
    return Math.min(Number(field) * 1000, Number.MAX_SAFE_INTEGER)
  }
  const day = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)'
  const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
  const time = '\\d{2}:\\d{2}:\\d{2}'
  const imf = new RegExp(`^${day}, \\d{2} ${month} \\d{4} ${time} GMT$`)
  const rfc850 = new RegExp(
    `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${time} GMT$`,
  )
  const asctime = new RegExp(`^${day} ${month} (?: \\d|\\d{2}) ${time} \\d{4}$`)
  if (!imf.test(field) && !rfc850.test(field) && !asctime.test(field)) return undefined
  // asctime has no explicit zone, but HTTP dates are always GMT.
  const parsed = Date.parse(asctime.test(field) ? `${field} GMT` : field)
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : undefined
}
