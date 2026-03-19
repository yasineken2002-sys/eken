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
  return raw
}

export function calculateVat(amount: number, vatRate: number): number {
  return Math.round(amount * (vatRate / 100) * 100) / 100
}

export function calculateTotal(subtotal: number, vatTotal: number): number {
  return Math.round((subtotal + vatTotal) * 100) / 100
}

export function generateOcrNumber(invoiceNumber: number): string {
  // Luhn algorithm for OCR number generation (Swedish standard)
  const num = invoiceNumber.toString()
  let sum = 0
  let alternate = false
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num.charAt(i), 10)
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  const checkDigit = (10 - (sum % 10)) % 10
  return `${num}${checkDigit}`
}
