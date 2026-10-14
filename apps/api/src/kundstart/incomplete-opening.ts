import { ConflictException, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

export const INCOMPLETE_OPENING_REASON =
  'Organisationen har ett ofärdigt öppningspaket för aktuellt brytdatum. ' +
  'Hantera öppningspaketet innan nya avier skapas.'

export class IncompleteOpeningException extends ConflictException {
  constructor() {
    super({ code: 'OPENING_PACKAGE_INCOMPLETE', message: INCOMPLETE_OPENING_REASON })
  }
}

/** First lock in the notice transaction; held through notice/revenue creation.
 * FOR UPDATE also serializes concurrent OpeningPackage FK inserts. This is only
 * an unfinished-package stop, not a complete-start or Fortnox-activation policy.
 */
export async function assertNoIncompleteOpening(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  const [org] = await tx.$queryRaw<{ billingCutoverDate: Date | null }[]>`
    SELECT "billingCutoverDate" FROM "Organization" WHERE id = ${organizationId} FOR UPDATE
  `
  if (!org) throw new NotFoundException('Organisationen hittades inte')
  if (!org.billingCutoverDate) return
  const pending = await tx.openingPackage.findFirst({
    where: {
      organizationId,
      cutoverDate: org.billingCutoverDate,
      status: { in: ['DRAFT', 'VALIDATED', 'APPROVED'] },
    },
    select: { id: true },
  })
  if (pending) throw new IncompleteOpeningException()
}
