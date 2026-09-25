import type { Prisma } from '@prisma/client'

import { checkPaymentTarget, type PaymentTargetBlock } from '../avisering/payment-target'
import { invoiceOutstanding, type CreditNoteAmount } from './invoice-debt'

/**
 * F8 — BETALNINGSMÅLET PÅ FAKTURAVÄGEN.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Avivägen fick sin grind i K2 (`avisering/payment-target.ts`). Fakturavägen
 * fick ingen: `sendInvoiceEmail`, PDF-workern och den manuella statusövergången
 * DRAFT→SENT skickade eller bokförde en faktura som skickad fast
 * `Organization.bankgiro` var `null`, och PDF:en skrev då `Bankgiro: –` på ett
 * dokument som begär betalning.
 *
 * ── EN REGEL OM MÅLET, INTE TVÅ ─────────────────────────────────────────────
 *
 * Vad ett giltigt betalningsmål ÄR avgörs uteslutande av `checkPaymentTarget` —
 * samma funktion, samma koder (`PAYMENT_TARGET_MISSING`/`…_INVALID`), samma
 * rättelseanvisning. Den här filen lägger bara till den fråga som är fakturans
 * egen: BEGÄR dokumentet betalning över huvud taget?
 *
 * ── VAD SOM INTE BEGÄR BETALNING ────────────────────────────────────────────
 *
 *   KREDITNOTA   minskar en fordran, ber ingen betala något.
 *   NOLLSALDO    restskulden (efter allokeringar och krediteringar) är 0 — en
 *                faktura på 0 kr, eller en som redan är betald/krediterad.
 *
 * De blockeras ALDRIG av ett saknat mål. Att stoppa ett dokument som inte ber om
 * pengar vore en spärr utan grund.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Att grinden är PÅKOPPLAD på varje väg bärs av `invoice-payment-target*.spec.ts`
 * som räknar köade jobb, mejl och statusrader — inte av den här filen.
 */

export interface InvoicePaymentInput {
  isCreditNote: boolean
  total: Prisma.Decimal
  payments: Array<{ amount: Prisma.Decimal }>
  creditNotes: CreditNoteAmount[]
}

/** Ber fakturan mottagaren betala något? */
export function invoiceRequestsPayment(invoice: InvoicePaymentInput): boolean {
  if (invoice.isCreditNote) return false
  return invoiceOutstanding(invoice) > 0
}

export type InvoicePaymentTargetVerdict =
  | { ok: true; requestsPayment: boolean }
  | { ok: false; block: PaymentTargetBlock }

/**
 * Får den här fakturan skickas med organisationens NUVARANDE betalningsmål?
 *
 * `org` ska vara läst så sent som möjligt — i workern och i transaktionen — så
 * att ett mål som rensats efter köandet fångas.
 */
export function checkInvoicePaymentTarget(
  invoice: InvoicePaymentInput,
  org: { bankgiro?: string | null },
): InvoicePaymentTargetVerdict {
  if (!invoiceRequestsPayment(invoice)) return { ok: true, requestsPayment: false }
  const target = checkPaymentTarget(org)
  if (target.ok) return { ok: true, requestsPayment: true }
  return {
    ok: false,
    block: {
      code: target.block.code,
      message: `Fakturan kan inte skickas: ${target.block.message}`,
    },
  }
}
