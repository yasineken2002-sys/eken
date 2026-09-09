import type { ReadingRate } from './reading-review'

type Fraction = { n: bigint; d: bigint }

/**
 * Anropas bara för redan validerade, ändliga värden. DB:s Decimal(14,3)
 * ryms i Number.toString(): decimalerna kan sedan jämföras utan binär division.
 * Exponentformat hanteras också. Ingen avrundning eller tolerans vid gränsen.
 */
function decimal(value: number): Fraction {
  const [coefficient, exponent = '0'] = value.toString().split('e')
  const [whole, fraction = ''] = coefficient!.split('.')
  const scale = fraction.length - Number(exponent)
  const digits = BigInt(whole! + fraction)
  return scale >= 0
    ? { n: digits, d: 10n ** BigInt(scale) }
    : { n: digits * 10n ** BigInt(-scale), d: 1n }
}

function subtract(a: Fraction, b: Fraction): Fraction {
  return { n: a.n * b.d - b.n * a.d, d: a.d * b.d }
}

export function readingValueDifference(current: number, previous: number): number {
  const difference = subtract(decimal(current), decimal(previous))
  // d är en tiopotens. Konvertera hela decimalen i ett steg; stora mellanled
  // får inte bli Infinity/Infinity trots att differensen är ändlig.
  return Number(`${difference.n}e-${difference.d.toString().length - 1}`)
}

function exactRate(rate: ReadingRate): Fraction {
  const current = decimal(Number(rate.reading.value))
  const quantity = rate.previousReading
    ? subtract(current, decimal(Number(rate.previousReading.value)))
    : current
  const start = rate.previousReading?.periodEnd ?? rate.reading.periodStart
  const milliseconds =
    BigInt(Date.parse(rate.reading.periodEnd)) -
    BigInt(Date.parse(start)) +
    (rate.previousReading ? 0n : 86400000n)
  // Samma tidsenhet på båda sidor; dygnsfaktorn tar ut sig i jämförelsen.
  return { n: quantity.n, d: quantity.d * milliseconds }
}

export function compareReadingRates(a: ReadingRate, b: ReadingRate, factor = 1): number {
  const left = exactRate(a)
  const right = exactRate(b)
  const difference = left.n * right.d - right.n * left.d * BigInt(factor)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

/** Visningstal avrundas först från det förkortade, exakta dygnsbråket. */
export function readingRatePerDay(rate: ReadingRate, factor = 1): number {
  const exact = exactRate(rate)
  const numerator = exact.n * 86400000n * BigInt(factor)
  let a = numerator
  let b = exact.d
  while (b !== 0n) [a, b] = [b, a % b]
  const n = Number(numerator / a)
  const d = Number(exact.d / a)
  // DB-värden ryms; för extrema ändliga tal utanför DB-formatet behålls
  // det tidigare visningstalet om ett bråks mellanled inte ryms i Number.
  return Number.isFinite(n) && Number.isFinite(d) ? n / d : rate.perDay * factor
}
