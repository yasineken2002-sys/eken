/**
 * KUNDSTART-001 §12.8 (BYGGLEDARE-003 p2): beständig ogiltigförklaring av en
 * Fortnox-kundaktivering.
 *
 * Anropas i SAMMA transaktion som den materiella ändringen: exportinställningar (serie,
 * dimensionsval), mappningar, återanslutning/ny generation, nytt brytdatum, nytt
 * verkställt öppningspaket — och av send() när en avvikelse upptäcks. En aktivering som
 * en gång blivit SUPERSEDED eller REVOKED blir ALDRIG ACTIVE igen, även om samma hash
 * återkommer (A→B→A). Ett nytt kundgodkännande skapar en ny rad.
 *
 * Effektgräns: detta stoppar NYA anspråk. Ett anspråk som redan är SENDING fullföljs
 * eller blir UNKNOWN enligt befintlig regel; en redan utförd extern skrivning tas inte
 * tillbaka av en statusändring.
 */
import type { Prisma } from '@prisma/client'

export async function ogiltigforklaraAktiveringar(
  db: Prisma.TransactionClient,
  organizationId: string,
  skal: string,
): Promise<number> {
  const r = await db.fortnoxCustomerActivation.updateMany({
    where: { organizationId, status: 'ACTIVE' },
    data: { status: 'SUPERSEDED', supersededAt: new Date(), invalidatedReason: skal.slice(0, 500) },
  })
  return r.count
}
