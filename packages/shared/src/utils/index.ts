import { LOCALE, CURRENCY } from '../constants'

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' }).format(new Date(date))
}

export function formatOrgNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `${digits.slice(0, 6)}-${digits.slice(6)}`
  return raw
}

export function formatPersonalNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `${digits.slice(0, 8)}-${digits.slice(8)}`
  if (digits.length === 12) return `${digits.slice(0, 8)}-${digits.slice(8)}`
  return raw
}

export function calculateVat(amount: number, vatRate: number): number {
  return Math.round(amount * (vatRate / 100) * 100) / 100
}

export function calculateTotal(subtotal: number, vatTotal: number): number {
  return Math.round((subtotal + vatTotal) * 100) / 100
}

// ─── OCR (Bankgiro-standard) ───────────────────────────────────────────────────
// OCR-numret är en numerisk sträng på 4–25 siffror där sista siffran är en
// Luhn-modulus10 kontrollsiffra. Bankgirot kräver minst 4 siffror; i praktiken
// används 8–12 hos majoriteten av svenska banker. Vi paddar därför fakturanr
// till minst 7 siffror så att OCR (med kontrollsiffra) blir minst 8 siffror.

const MIN_OCR_BASE_LENGTH = 7

function luhnChecksum(digits: string): number {
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.charAt(i), 10)
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return (10 - (sum % 10)) % 10
}

export function generateOcrNumber(invoiceNumber: number): string {
  // Padda till minst 7 siffror så total längd ≥ 8 (med kontrollsiffran).
  const base = invoiceNumber.toString().padStart(MIN_OCR_BASE_LENGTH, '0')
  const checkDigit = luhnChecksum(base)
  return `${base}${checkDigit}`
}

export function isValidOcrNumber(ocr: string): boolean {
  if (!/^\d{4,25}$/.test(ocr)) return false
  const base = ocr.slice(0, -1)
  const check = parseInt(ocr.slice(-1), 10)
  return luhnChecksum(base) === check
}

// ─── Förfallodatum för hyresavi (Hyreslagen 12 kap. 20 § JB) ──────────────────
// Hyran ska betalas senast sista vardagen i månaden FÖRE den månad hyran
// avser. T.ex. avi för april förfaller sista vardagen i mars.
//
// Svenska helgdagar (förenklad lista – täcker fasta dagar samt påsk-relaterade
// rörliga). För avi-syfte räknas lördag/söndag och röda dagar som icke-vardagar.

function easterSunday(year: number): Date {
  // Anonymous Gregorian Algorithm
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function isoDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function isSwedishHoliday(date: Date): boolean {
  const year = date.getFullYear()
  const easter = easterSunday(year)
  const fixed: string[] = [
    `${year}-01-01`, // Nyårsdagen
    `${year}-01-06`, // Trettondedag jul
    `${year}-05-01`, // Första maj
    `${year}-06-06`, // Sveriges nationaldag
    `${year}-12-24`, // Julafton (banker stängda)
    `${year}-12-25`, // Juldagen
    `${year}-12-26`, // Annandag jul
    `${year}-12-31`, // Nyårsafton (banker stängda)
  ]
  const movable: string[] = [
    isoDateKey(addDays(easter, -2)), // Långfredag
    isoDateKey(easter), // Påskdagen
    isoDateKey(addDays(easter, 1)), // Annandag påsk
    isoDateKey(addDays(easter, 39)), // Kristi himmelsfärds dag
    isoDateKey(addDays(easter, 49)), // Pingstdagen
  ]
  // Midsommarafton: fredag mellan 19–25 juni. Midsommardagen: lördag därefter.
  const june19 = new Date(year, 5, 19)
  const dow = june19.getDay()
  const fridayOffset = (5 - dow + 7) % 7
  const midsummerEve = addDays(june19, fridayOffset)
  movable.push(isoDateKey(midsummerEve))
  movable.push(isoDateKey(addDays(midsummerEve, 1)))
  // Alla helgons dag: lördag mellan 31 okt – 6 nov.
  const oct31 = new Date(year, 9, 31)
  const dow2 = oct31.getDay()
  const satOffset = (6 - dow2 + 7) % 7
  movable.push(isoDateKey(addDays(oct31, satOffset)))

  const key = isoDateKey(date)
  return fixed.includes(key) || movable.includes(key)
}

export function isSwedishBusinessDay(date: Date): boolean {
  const dow = date.getDay()
  if (dow === 0 || dow === 6) return false
  return !isSwedishHoliday(date)
}

/**
 * Returnerar förfallodatum för hyresavi för en viss månad, dvs. sista
 * vardagen i månaden FÖRE den hyresperiod avin avser. Följer Hyreslagen
 * 12 kap. 20 § JB.
 *
 * @param year Hyresperiodens år
 * @param month Hyresperiodens månad (1–12)
 */
export function rentDueDateForMonth(year: number, month: number): Date {
  // Sista dagen i månaden före (månad–1, dag 0 = sista i månad–2 → vi vill
  // sista dagen i månad-1 så använder vi `new Date(year, month-1, 0)` som
  // ger "dag 0 i month-1" = sista dagen i month-2 + 1, dvs sista i month-1).
  // Konkret: för avi-månad 4 (april) vill vi sista vardagen i mars (månad 3).
  let d = new Date(year, month - 1, 0)
  while (!isSwedishBusinessDay(d)) {
    d = addDays(d, -1)
  }
  return d
}

// ─── Svenskt personnummer / organisationsnummer (Luhn) ───────────────────────
// Skatteverket använder modulus-10 där VARANNAN siffra dubblas med start
// från VÄNSTER (positioner 0,2,4,6,8). Detta skiljer sig från kreditkorts-
// Luhn där 2:a-från-höger dubblas. Måste därför ha egen implementation.

function personalNumberChecksum(nineDigits: string): number {
  let sum = 0
  for (let i = 0; i < nineDigits.length; i++) {
    let n = parseInt(nineDigits.charAt(i), 10)
    // Vikt 2 på position 0,2,4,... (jämn) — vikt 1 på 1,3,5,... (udda)
    if (i % 2 === 0) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return (10 - (sum % 10)) % 10
}

export function isValidSwedishPersonalNumber(raw: string): boolean {
  if (!raw) return false
  const cleaned = raw.replace(/[\s+-]/g, '')
  if (!/^(\d{10}|\d{12})$/.test(cleaned)) return false

  let body: string
  let yearFull: number
  if (cleaned.length === 12) {
    yearFull = parseInt(cleaned.slice(0, 4), 10)
    body = cleaned.slice(2) // YYMMDD-NNNK för Luhn
  } else {
    body = cleaned
    const yy = parseInt(cleaned.slice(0, 2), 10)
    const currentYY = new Date().getFullYear() % 100
    yearFull = yy <= currentYY ? 2000 + yy : 1900 + yy
  }

  if (yearFull > new Date().getFullYear()) return false

  const month = parseInt(body.slice(2, 4), 10)
  const day = parseInt(body.slice(4, 6), 10)
  // Samordningsnummer: dag + 60 (61–91) är giltigt.
  const isCoordination = day > 60 && day <= 91
  const realDay = isCoordination ? day - 60 : day
  if (month < 1 || month > 12) return false
  if (realDay < 1 || realDay > 31) return false

  const check = parseInt(body.slice(9, 10), 10)
  return personalNumberChecksum(body.slice(0, 9)) === check
}

export function isValidSwedishOrgNumber(raw: string): boolean {
  if (!raw) return false
  const cleaned = raw.replace(/[\s-]/g, '')
  if (!/^\d{10}$/.test(cleaned)) return false
  const check = parseInt(cleaned.slice(9, 10), 10)
  return personalNumberChecksum(cleaned.slice(0, 9)) === check
}

// ─── Lösenordspolicy ───────────────────────────────────────────────────────────
// Krav: minst 10 tecken, minst en stor bokstav, minst en liten, minst en
// siffra. Specialtecken är rekommenderat men inte krav (användarstudier visar
// att längd > komplexitet, men vi tar med stor/liten/siffra som baseline).

export const PASSWORD_MIN_LENGTH = 10

export function validatePasswordStrength(password: string): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Lösenordet måste vara minst ${PASSWORD_MIN_LENGTH} tecken`)
  }
  if (!/[a-z]/.test(password)) errors.push('Lösenordet måste innehålla en liten bokstav')
  if (!/[A-Z]/.test(password)) errors.push('Lösenordet måste innehålla en stor bokstav')
  if (!/[0-9]/.test(password)) errors.push('Lösenordet måste innehålla en siffra')
  return { valid: errors.length === 0, errors }
}
