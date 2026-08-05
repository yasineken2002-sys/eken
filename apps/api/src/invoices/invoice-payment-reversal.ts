import type { InvoiceStatus } from '@prisma/client'

/**
 * #326 B — STATUSÅTERSTÄLLNING VID AVMATCHNING. EN NAMNGIVEN RÄTTELSEVÄG.
 *
 * ── VARFÖR INTE EN NY KANT I `INVOICE_TRANSITIONS` ──────────────────────────
 *
 * Den uppenbara fixen vore att lägga in `PARTIAL → SENT` i statusmaskinen. Den
 * valdes bort, och skälet är inte kosmetiskt:
 *
 * `INVOICE_TRANSITIONS` beskriver AFFÄRSHÄNDELSER — vad som kan hända en faktura
 * i normal drift. En avmatchning är ingen affärshändelse. Den är en RÄTTELSE AV
 * ETT MISSTAG: betalningen hörde aldrig till den här fakturan.
 *
 * Läggs `PARTIAL → SENT` in i tabellen påstår systemet att fakturor kan gå BAKÅT
 * i normalt flöde — och då kan vilken kodväg som helst göra det. `transitionStatus`
 * skulle släppa igenom den, DTO-enumet skulle kunna utökas, och nästa skrivare
 * som konsulterar tabellen får ett ja utan att någon tagit ställning till om det
 * är en rättelse. En tillåtlista som är för vid är precis den felriktning
 * #307 PR 2b bytte bort (förbudslista → tillåtlista härledd ur tabellen).
 *
 * Rättelsevägen ligger därför HÄR, utanför tabellen, och är explicit om vad den
 * är. Den har exakt en anropare (`unmatchTransaction`), skriver en `PAYMENT_REVERSED`
 * i den append-only-loggen och kan inte nås av en generisk statusskrivare.
 *
 * ── VAD DEN FÅR ÅTERSTÄLLA TILL ────────────────────────────────────────────
 *
 * `PARTIAL` är den enda BETALNINGSHÄRLEDDA statusen. Försvinner den sista
 * allokeringen är fakturan inte längre delbetald och statusen måste tillbaka
 * till det den var innan betalningen kom in.
 *
 * Allt annat lämnas orört, och det är avsiktligt:
 *   • `OVERDUE` är förfallo-härledd, inte betalnings-härledd. En OVERDUE faktura
 *     med en allokering är fortfarande förfallen när allokeringen tas bort.
 *   • `SENT_TO_COLLECTION` når aldrig hit — #326 A spärrar avmatchningen.
 *   • `PAID` når aldrig hit — PAID-spärren i `unmatchTransaction`.
 *   • `DRAFT`/`VOID` kan per konstruktion inte bära en allokering.
 */

/**
 * De enda statusar en rättelse får återställa TILL.
 *
 * HANDSKRIVEN MED FLIT — och det är ett undantag från "härled, duplicera inte".
 * Listan är inte en spegel av en kant i `INVOICE_TRANSITIONS`; den finns just
 * för att den INTE ska vara det. Att härleda den ur tabellen vore att återinföra
 * kopplingen den här modulen bryter.
 *
 * `SENT` och `OVERDUE` är de enda statusar en faktura kan ha stått i när den
 * tog emot sin första delbetalning (`applyMatchToInvoice` och
 * `markAsPaidManually` läser båda ur `paymentTargetStatus`, som bara producerar
 * PARTIAL från dessa två plus SENT_TO_COLLECTION — och den sista är spärrad).
 */
export const PAYMENT_REVERSAL_RESTORE_TARGETS: readonly InvoiceStatus[] = ['SENT', 'OVERDUE']

export function isReversalRestoreTarget(status: InvoiceStatus): boolean {
  return PAYMENT_REVERSAL_RESTORE_TARGETS.includes(status)
}

/** Beslutet: lämna statusen, eller återställ den till ett bestämt värde. */
export type ReversalStatusDecision =
  | { action: 'keep'; reason: 'not-partial' | 'allocations-remain' }
  | { action: 'restore'; target: InvoiceStatus }

/**
 * Vilken status fakturan ska ha EFTER att en allokering rättats bort.
 *
 * `statusBeforePartial` = den status fakturan stod i när den gick IN i PARTIAL,
 * läst ur append-only-loggen (se `statusBeforePartialPayment`). Den GISSAS ALDRIG:
 * saknas den kastar anroparen hellre än att skriva en påhittad status. En
 * felaktig status i räkenskaperna är värre än ett nekat anrop (BFL 5 kap 11 § —
 * behandlingshistoriken ska gå att följa, inte rekonstrueras på känsla).
 */
export function paymentReversalTargetStatus(input: {
  current: InvoiceStatus
  hasRemainingAllocations: boolean
  statusBeforePartial: InvoiceStatus | null
}): ReversalStatusDecision {
  // Bara PARTIAL är betalningshärledd. Se modulhuvudet.
  if (input.current !== 'PARTIAL') return { action: 'keep', reason: 'not-partial' }

  // #307 C:s princip, spegelvänd: pengar ändrar skuldens STORLEK, inte var
  // ärendet ligger. Finns en allokering kvar är fakturan fortfarande delbetald.
  if (input.hasRemainingAllocations) return { action: 'keep', reason: 'allocations-remain' }

  if (input.statusBeforePartial == null || !isReversalRestoreTarget(input.statusBeforePartial)) {
    // Anroparen fail-closar. Vi returnerar inte ett gissat värde.
    return { action: 'keep', reason: 'not-partial' }
  }

  return { action: 'restore', target: input.statusBeforePartial }
}

/**
 * Den status fakturan stod i när den gick IN i PARTIAL, ur append-only-loggen.
 *
 * VARFÖR INTE BARA "ÄLDSTA PAYMENT_PARTIAL". En faktura kan ha gått in i och ur
 * PARTIAL flera gånger, och kan ha hunnit bli OVERDUE emellan:
 *
 *   SENT → del 1 (previousStatus SENT) → rättelse → SENT → cron: OVERDUE
 *        → del 2 (previousStatus OVERDUE)
 *
 * Äldsta posten säger `SENT`; rätt svar är `OVERDUE`. Den post som faktiskt
 * FLYTTADE fakturan in i PARTIAL är den SENASTE vars `previousStatus` inte redan
 * var PARTIAL — självövergången PARTIAL → PARTIAL (andra delbetalningen, #307 C)
 * flyttade ingenting och bär därför inte utgångsläget.
 *
 * `events` ska vara PAYMENT_PARTIAL-poster sorterade NYAST FÖRST.
 */
export function statusBeforePartialPayment(
  events: ReadonlyArray<{ payload: unknown }>,
): InvoiceStatus | null {
  for (const event of events) {
    const payload = event.payload
    if (typeof payload !== 'object' || payload === null) continue
    const previous = (payload as Record<string, unknown>).previousStatus
    if (typeof previous !== 'string') continue
    if (previous === 'PARTIAL') continue // självövergång — flyttade ingenting
    return isReversalRestoreTarget(previous as InvoiceStatus) ? (previous as InvoiceStatus) : null
  }
  return null
}
