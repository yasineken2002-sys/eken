import type { Prisma, PrismaClient } from '@prisma/client'

// Accepterar både den vanliga klienten och en transaktionsklient så att synken
// kan köras INOM samma transaktion som leaseändringen (atomiskt) eller fristående
// (t.ex. radvis import utan omslutande transaktion).
type PrismaLike = PrismaClient | Prisma.TransactionClient

/**
 * ENDA platsen som håller Unit.status i synk med kontraktens status (I1/#62).
 *
 * Regel:
 *   • Har enheten minst ETT ACTIVE-kontrakt → OCCUPIED.
 *   • Saknas aktivt kontrakt → återgå till VACANT, men ENDAST om enheten just nu
 *     är OCCUPIED. Manuella tillstånd (UNDER_RENOVATION/RESERVED) klobbras aldrig
 *     — de är medvetna val och ska inte nollställas av en leaseändring.
 *
 * updateMany med statusfilter gör synken idempotent: skriver bara när något
 * faktiskt ändras (ingen onödig write, inga tomma audit-rader).
 *
 * Anropas EFTER att leaseraden skrivits (så count() ser det nya tillståndet),
 * helst inom samma transaktion. Tidigare gjordes detta inline på fem olika
 * ställen — och importen glömde det helt, vilket var roten till I1.
 */
export async function syncUnitStatusFromLeases(db: PrismaLike, unitId: string): Promise<void> {
  const activeCount = await db.lease.count({
    where: { unitId, status: 'ACTIVE' },
  })

  if (activeCount > 0) {
    await db.unit.updateMany({
      where: { id: unitId, status: { not: 'OCCUPIED' } },
      data: { status: 'OCCUPIED' },
    })
  } else {
    await db.unit.updateMany({
      where: { id: unitId, status: 'OCCUPIED' },
      data: { status: 'VACANT' },
    })
  }
}
