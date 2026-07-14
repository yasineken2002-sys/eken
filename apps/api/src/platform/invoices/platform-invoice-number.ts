import type { Prisma, PlatformInvoiceType } from '@prisma/client'

/**
 * Atomär, race-säker allokering av PLATTFORMS-fakturanummer via
 * PlatformInvoiceNumberSequence. UPSERT med increment tar Postgres row-lock på
 * scope-raden → två samtidiga plattformsfaktureringar kan ALDRIG dela ut samma
 * nummer (ersätter den tidigare count()+1-racen i nextInvoiceNumber som kunde ge
 * samma nummer → P2002 på invoiceNumber-unikheten, som dessutom kunde feltolkas
 * som en benign period-idempotens-race). Sker allokeringen i samma transaktion
 * som fakturan skapas (se PlatformInvoicesService.create) binds numret till just
 * den insert:en.
 *
 * Speglar allocateInvoiceNumber (org-fakturor) men numret är GLOBALT över hela
 * plattformen (Eveno är avsändaren), scopat per serie/period:
 *   PLT-{år}-{nnnnn}    (PLAN_FEE / OTHER) — serien nollställs per år
 *   CR-{åååmm}-{nnnn}   (AI_CREDITS)       — serien nollställs per månad
 * "scope" = prefixet (serien), t.ex. "PLT-2026" / "CR-202607"; en rad per scope.
 */
export async function allocatePlatformInvoiceNumber(
  tx: Prisma.TransactionClient,
  type: PlatformInvoiceType,
  now: Date = new Date(),
): Promise<string> {
  const isCredits = type === 'AI_CREDITS'
  const scope = isCredits
    ? `CR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    : `PLT-${now.getFullYear()}`
  const width = isCredits ? 4 : 5

  const row = await tx.platformInvoiceNumberSequence.upsert({
    where: { scope },
    create: { scope, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  })

  return `${scope}-${String(row.lastNumber).padStart(width, '0')}`
}
