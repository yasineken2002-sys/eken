import type { Prisma } from '@prisma/client'

/**
 * Atomär, race-säker allokering av fakturanummer via InvoiceNumberSequence
 * (BFL/ML: fortlöpande, gap-fri nummerserie). UPSERT med increment ger Postgres
 * row-lock; sker allokeringen i samma transaktion som fakturan skapas blir serien
 * gap-free.
 *
 * DELAD källa för BÅDE InvoicesService och DepositsService. Tidigare hade deposits
 * en egen `count()+1`-numrering som kolliderade med denna sekvens (samma
 * invoiceNumber → unique-constraint-krasch vid manuell fakturering efter en
 * deposition). Numret är globalt per org (året i F-{år}-{nr} är kosmetiskt) och
 * bevarar OCR-unikheten som härleds ur sekvensen.
 */
export async function allocateInvoiceNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  year: number = new Date().getFullYear(),
): Promise<{ invoiceNumber: string; sequence: number }> {
  const row = await tx.invoiceNumberSequence.upsert({
    where: { organizationId },
    create: { organizationId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  })
  const sequence = row.lastNumber
  return { invoiceNumber: `F-${year}-${String(sequence).padStart(4, '0')}`, sequence }
}
