/**
 * LEVERANTÖRSFAKTURANS TILLSTÅND — BERÄKNAT, ALDRIG EN FLAGGA.
 *
 * ── VARFÖR INGEN `status`-KOLUMN ────────────────────────────────────────────
 *
 * Huset har en princip och den gäller här: skuld är ett beräknat tillstånd
 * (CLAUDE.md). En kolumn hade kunnat säga `PAID` om en faktura vars
 * betalningsverifikat rullades tillbaka, och då är balansräkningen och listan
 * oense utan att något blir rött. Tillståndet härleds därför ur HÄNDELSERNA:
 * `paidAt` och `cancelledAt` säger NÄR något skedde, och verifikaten är
 * beviset.
 *
 * ── DE TRE TILLSTÅNDEN ──────────────────────────────────────────────────────
 *
 *   OPEN       mottagen, obetald. Skulden står på 2440.
 *   PAID       betald. 2440 nettar till noll för den här fakturan.
 *   CANCELLED  makulerad innan betalning. Ingen skuld kvar.
 *
 * En BETALD faktura kan inte makuleras — den rättas med ett motverifikat. Det
 * är inte en artighetsregel: makulering nollar ingenting i huvudboken, så en
 * "makulerad" betald faktura hade lämnat både kostnaden och betalningen kvar
 * medan listan påstod att posten inte finns.
 *
 * ── VAD MODULEN INTE KAN SE ─────────────────────────────────────────────────
 *
 * Att verifikaten FAKTISKT finns. Funktionerna läser fakturaraden, inte
 * huvudboken. Kopplingen bärs av att `paidAt` bara sätts i samma transaktion
 * som betalningsverifikatet skrivs (`AccountingService`), och av
 * `supplier-invoice.db.spec.ts`, som bokför båda stegen mot riktig Postgres och
 * kräver att 2440 nettar till noll.
 */

export type SupplierInvoiceStatus = 'OPEN' | 'PAID' | 'CANCELLED'

export interface SupplierInvoiceState {
  paidAt: Date | null
  cancelledAt: Date | null
}

export function supplierInvoiceStatus(faktura: SupplierInvoiceState): SupplierInvoiceStatus {
  // ORDNINGEN ÄR LASTBÄRANDE. Betalning vinner över makulering därför att en
  // betald faktura inte FÅR vara makulerad — står båda fälten satta är det ett
  // datafel, och att då svara CANCELLED hade dolt pengar som faktiskt lämnat
  // kontot. `assertMayCancel` hindrar kombinationen i skrivvägen; den här
  // ordningen är andra lagret.
  if (faktura.paidAt) return 'PAID'
  if (faktura.cancelledAt) return 'CANCELLED'
  return 'OPEN'
}

/** En öppen post är den enda som fortfarande står som skuld på 2440. */
export function isOpen(faktura: SupplierInvoiceState): boolean {
  return supplierInvoiceStatus(faktura) === 'OPEN'
}

/**
 * Är en ÖPPEN faktura förfallen?
 *
 * Bara öppna kan förfalla. En betald faktura som betalades sent är inte
 * "förfallen" — den är betald, och att färga den röd i listan hade gjort en
 * åtgärdslista till en historikbok.
 *
 * Jämförelsen sker på DATUM, inte tidpunkt: `dueDate` är `@db.Date`, och en
 * faktura som förfaller i dag är inte försenad förrän i morgon.
 */
export function isOverdue(
  faktura: SupplierInvoiceState & { dueDate: Date },
  nu: Date = new Date(),
): boolean {
  if (!isOpen(faktura)) return false
  const förfaller = Date.UTC(
    faktura.dueDate.getUTCFullYear(),
    faktura.dueDate.getUTCMonth(),
    faktura.dueDate.getUTCDate(),
  )
  const idag = Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth(), nu.getUTCDate())
  return idag > förfaller
}

/**
 * Får fakturan makuleras?
 *
 * Returnerar ett SKÄL eller null. En boolean hade tvingat anroparen att hitta på
 * ett felmeddelande, och två anropare hade hittat på olika.
 */
export function cancelBlockedReason(faktura: SupplierInvoiceState): string | null {
  if (faktura.paidAt) {
    return 'Fakturan är redan betald och kan inte makuleras. Rätta den i stället med ett motverifikat.'
  }
  if (faktura.cancelledAt) return 'Fakturan är redan makulerad.'
  return null
}

// ── IDEMPOTENSNYCKLARNA ─────────────────────────────────────────────────────
//
// TVÅ nycklar, inte en. Mottagandet och betalningen är två affärshändelser vid
// två tidpunkter; en gemensam nyckel hade gjort betalningen till en
// idempotensträff på mottagandet — alltså tyst ingen bokföring alls, och en
// skuld som aldrig regleras i huvudboken.

export const receiptSourceId = (id: string) => `supplier-invoice:${id}`
export const paymentSourceId = (id: string) => `supplier-invoice-payment:${id}`

/**
 * Makuleringens namnrymd — SKILD från mottagningens och betalningens.
 *
 * Tre nycklar, tre verifikat, och det är avsiktligt: en delad nyckel hade gjort
 * det andra steget till en idempotensträff på det första, alltså tyst ingen
 * bokföring alls. Att namnrymderna skiljer sig betyder samtidigt att INGET
 * skydd finns mot att båda reverseringarna körs på samma fordran, och den
 * spärren måste därför finnas explicit i BÅDA riktningarna:
 *
 *   betala en makulerad faktura   spärras av `markPaid` (cancelledAt satt)
 *   makulera en betald faktura    spärras av `cancelBlockedReason` (paidAt satt)
 *
 * Utan båda hade utfallet blivit ett dubbelräknat belopp där varje enskilt
 * verifikat balanserar — se CLAUDE.md, "Spärrar är riktade".
 */
export const cancellationSourceId = (invoiceId: string) => `supplier-invoice-cancel:${invoiceId}`
