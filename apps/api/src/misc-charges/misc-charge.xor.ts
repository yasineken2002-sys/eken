import { BadRequestException } from '@nestjs/common'

/**
 * XOR-invariant för RentNoticeLine: exakt EN av consumptionChargeId/miscChargeId
 * får vara satt på en charge-rad (en rad är antingen en förbruknings- ELLER en
 * övrig debiteringspost, aldrig båda och aldrig ingen).
 *
 * Tvingas i service-lagret — Prisma kan inte uttrycka ett villkorligt XOR-
 * constraint i schemat (se kommentaren på RentNoticeLine.miscChargeId).
 *
 * PR 3 levererar guarden + test. PR 4:s radskapande (attach-flödet, som även
 * sätter ATTACHED) anropar den FÖRE en RentNoticeLine skapas. PR 3 sätter aldrig
 * ATTACHED och skapar aldrig rader själv.
 */
export function assertRentNoticeLineChargeXor(
  consumptionChargeId: string | null | undefined,
  miscChargeId: string | null | undefined,
): void {
  const hasConsumption = consumptionChargeId != null
  const hasMisc = miscChargeId != null
  // XOR: precis en ska vara satt. Lika (båda satta ELLER ingen satt) → brott.
  if (hasConsumption === hasMisc) {
    throw new BadRequestException(
      'En avi-rad måste ha exakt en av förbruknings- eller övrig debiteringspost (XOR).',
    )
  }
}
