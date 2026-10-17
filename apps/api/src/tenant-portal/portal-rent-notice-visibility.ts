import type { Prisma } from '@prisma/client'

/**
 * Gemensam synlighet för portalens avilistor och PDF-nedladdning.
 * PENDING kan bli OVERDUE vid en adminläsning utan att avin har skickats;
 * därför kräver OVERDUE en utskicksstämpel.
 *
 * SENT utan sentAt behålls för äldre portalvisning, inte som utskicksbevis.
 * PAID får vara synlig även om betalningen skedde utan föregående utskick.
 * Anroparen måste dessutom avgränsa till den autentiserade hyresgästen.
 */
export function portalRentNoticeVisibilityWhere(): Prisma.RentNoticeWhereInput {
  return {
    OR: [{ status: { in: ['SENT', 'PAID'] } }, { status: 'OVERDUE', sentAt: { not: null } }],
  }
}
