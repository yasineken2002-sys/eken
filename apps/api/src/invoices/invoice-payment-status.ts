import type { InvoiceStatus } from '@prisma/client'
import { isValidTransition } from '@eken/shared'

/**
 * #307 C — MÅLSTATUSEN FÖR EN BETALNING. EN KÄLLA, TVÅ ANVÄNDNINGAR.
 *
 * Funktionen finns för att valideringen och skrivningen ska tvingas avse SAMMA
 * övergång. Felet den ersätter var inte att fel status skrevs — det var att de
 * två räknades ut på var sitt håll:
 *
 *   invoices.service.ts (före):
 *     if (!isValidTransition(invoice.status, 'PAID')) throw …        ← validerar → PAID
 *     const newStatus = completesInvoice ? 'PAID' : 'PARTIAL'        ← skriver PARTIAL
 *
 * Från `SENT_TO_COLLECTION` passerade kontrollen (→ PAID ÄR en giltig kant) och
 * koden skrev `PARTIAL`, som inte är det. En validering som mäter en annan sak än
 * den som utförs säger ingenting om det som faktiskt händer — den blir en
 * bekräftelse på fel fråga. Att utfallet numera råkar bli rätt vore inte nog:
 * så länge målstatusen räknas ut på två ställen kan de glida isär igen.
 *
 * Samma princip som `COLLECTION_SOURCE_STATUSES` i #307 PR 2b: härled, duplicera inte.
 */

/**
 * Vilken status en faktura ska ha EFTER att en betalning allokerats.
 *
 * `settlesInvoice` = betalningen reglerar hela restskulden (beräknat tillstånd via
 * `computeInvoiceDebt`, aldrig en lagrad flagga).
 *
 * DELBETALNING MOT EN INKASSOFAKTURA BEHÅLLER STATUSEN. En faktura som lämnats
 * till inkasso och sedan delbetalas är fortfarande överlämnad — pengarna ändrar
 * skuldens STORLEK, inte var ärendet ligger. Flippades den till PARTIAL blev raden
 * internt motsägelsefull: `remindersPaused` stod kvar `true` och
 * `sentToCollectionAt` orörd, medan statusen sa något annat. Följden var att
 * fordran försvann ur BÅDA vyerna — inkassovyn (`getOverdueStatus`) kräver OVERDUE
 * eller SENT_TO_COLLECTION, och påminnelsecronen kräver OVERDUE med
 * `remindersPaused = false`. Invoice har ingen `collectionStage`-stege som
 * RentNotice, alltså ingen tredje mekanism som fångar upp den. Skulden slutade
 * helt enkelt jagas, tyst. (FAR-granskning, #307 fynd 3.)
 */
export function paymentTargetStatus(
  current: InvoiceStatus,
  settlesInvoice: boolean,
): InvoiceStatus {
  if (settlesInvoice) return 'PAID'
  return current === 'SENT_TO_COLLECTION' ? 'SENT_TO_COLLECTION' : 'PARTIAL'
}

/**
 * Är övergången `current → target` tillåten för en betalning?
 *
 * SJÄLVÖVERGÅNGEN ÄR INGEN ÖVERGÅNG. `INVOICE_TRANSITIONS` beskriver kanter mellan
 * OLIKA statusar; `SENT_TO_COLLECTION → SENT_TO_COLLECTION` finns inte där och ska
 * inte finnas där. Att låta statusen stå kvar ändrar ingenting i statusmaskinen och
 * kräver därför ingen kant — men det får inte förväxlas med att kringgå tabellen:
 * varje övergång som FAKTISKT byter status valideras mot `isValidTransition`.
 */
export function isPaymentTransitionAllowed(current: InvoiceStatus, target: InvoiceStatus): boolean {
  if (target === current) {
    // SJÄLVÖVERGÅNGEN ÄR HÄRLEDD, INTE GENERELL. Ett rakt `return true` här hade
    // släppt igenom VILKEN status som helst mot sig själv — också DRAFT→DRAFT och
    // PAID→PAID, som ingen betalningsväg får producera. Att i stället fråga
    // `paymentTargetStatus` binder regeln till samma källa som räknar ut målet:
    // exakt de självövergångar en betalning faktiskt kan landa på tillåts, och
    // listan kan inte glida isär från uträkningen.
    //
    // Idag är det två: PARTIAL (andra delbetalningen på en redan delbetald
    // faktura) och SENT_TO_COLLECTION (delbetalning mot inkassofaktura).
    // (Påpekat av både FAR- och säkerhetsgranskningen av #307 C.)
    return paymentTargetStatus(current, false) === current
  }
  return isValidTransition(current, target)
}
