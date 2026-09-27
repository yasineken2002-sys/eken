import { SWEDISH_TIME_ZONE } from '@eken/shared'

export function formatSek(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

// F7 — svensk tid, inte serverns. Mallarna som läser den här (enbart
// `templates/invoices/*`) visar fakturans `@db.Date`; utan tidszon blev
// förfallodagen i mejlet föregående dag på en server väster om UTC. Samma form
// som `formatDateSv` i mail.service.ts, som avimejlen redan använder.
export function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('sv-SE', {
    timeZone: SWEDISH_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
