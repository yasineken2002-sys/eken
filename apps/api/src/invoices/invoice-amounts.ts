/**
 * Fakturabeloppens aritmetik — öresavrundning och totaler.
 *
 * EGEN MODUL, inte en hjälpare inuti InvoicesService (#517). Skälet är
 * praktiskt: `CreditNoteService` måste räkna med EXAKT samma avrundning som
 * originalfakturan — en andra kopia av formeln ger den öresdrift som gjorde
 * verifikat obalanserade förut — men en import från `invoices.service` drar in
 * hela tjänstekedjan (mail, PDF, S3-klienten). Ren aritmetik ska gå att
 * importera utan att en AWS-klient laddas.
 */

// Öresavrundning i beräkningslagret. Belopp lagras till ören (2 decimaler) och
// totalerna HÄRLEDS ur de avrundade radvärdena, så att invarianten
// "Σ rader = total" och "subtotal + moms = total" alltid håller exakt — inte
// bara matematiskt vid full float-precision, utan även efter avrundning på
// utskriften. Tidigare lagrades full precision och visningen rundade varje
// belopp för sig, vilket kunde göra att raderna inte summerade till totalen.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

interface InvoiceLineInput {
  description: string
  quantity: number
  unitPrice: number
  vatRate: number
}

interface ComputedInvoiceAmounts {
  subtotal: number
  vatTotal: number
  total: number
  lines: Array<InvoiceLineInput & { total: number }>
}

// Per rad: netto och bruttobelopp (inkl. moms) öresavrundas. Radens moms tas som
// (brutto − netto) så ingen separat avrundningsdrift uppstår. subtotal/vatTotal
// summeras ur de avrundade radvärdena och total = subtotal + moms. Då gäller
// alltid total = Σ radbelopp (eftersom netto + moms = brutto per rad).
// Exporterad för CreditNoteService (#517): kreditnotans belopp måste räknas med
// EXAKT samma öresavrundning som originalfakturan, annars kan speglingen bli en
// öre fel och verifikatet obalanserat. En andra kopia av formeln är precis det
// som gav den obalans som beskrivs i createJournalEntryForInvoice.
export function computeInvoiceAmounts(lines: InvoiceLineInput[]): ComputedInvoiceAmounts {
  let subtotal = 0
  let vatTotal = 0
  const computed = lines.map((l) => {
    const net = round2(l.quantity * l.unitPrice)
    const gross = round2(l.quantity * l.unitPrice * (1 + l.vatRate / 100))
    const vat = round2(gross - net)
    subtotal = round2(subtotal + net)
    vatTotal = round2(vatTotal + vat)
    return {
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      vatRate: l.vatRate,
      total: gross,
    }
  })
  return { subtotal, vatTotal, total: round2(subtotal + vatTotal), lines: computed }
}
