/**
 * KUNDSTART K-B7 p4 (E-pre): förkontroll mot dubbel representation. Den här versionen
 * stödjer bara övertagande till en TOM Eveno-reskontra före brytdatum: finns egna
 * Eveno-poster daterade före brytdatum (verifikat, EVENO-avier för perioder före, bankrader
 * eller betalda EVENO-depositioner) kan de redan finnas i Fortnox och får inte också läggas
 * in som extern öppning. Paketet och kundaktiveringen stoppas då med skäl (kundgräns i
 * KUNDUNDERLAG). Läsning; inget ändras.
 */
import type { Prisma } from '@prisma/client'
import { brytAr, brytdatumIso } from './cutover'

export async function evenoPosterForeBrytdatum(
  db: Prisma.TransactionClient,
  organizationId: string,
  cutover: Date,
): Promise<string | null> {
  const b = brytAr(cutover)
  const [verifikat, avier, bank, dep] = await Promise.all([
    db.journalEntry.count({ where: { organizationId, date: { lt: cutover } } }),
    db.rentNotice.count({
      where: {
        organizationId,
        origin: 'EVENO',
        OR: [{ year: { lt: b.year } }, { year: b.year, month: { lt: b.month } }],
      },
    }),
    db.bankTransaction.count({ where: { organizationId, date: { lt: cutover } } }),
    db.deposit.count({ where: { organizationId, origin: 'EVENO', paidAt: { lt: cutover } } }),
  ])
  if (verifikat + avier + bank + dep === 0) return null
  return (
    `Eveno har egna poster före brytdatum ${brytdatumIso(cutover)} (${verifikat} verifikat, ` +
    `${avier} avier, ${bank} bankrader, ${dep} betalda depositioner). De kan redan finnas i ` +
    'Fortnox och får inte också tas in som öppning. Denna version stödjer bara övertagande ' +
    'till en tom Eveno-reskontra före brytdatum — hantera posterna manuellt först.'
  )
}
