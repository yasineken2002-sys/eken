/**
 * KUNDSTART-011 (C2 S3-1, S3-2, S3-3): en historisk fordran ur ett verkställt öppningspaket
 * (origin OPENING_PACKAGE) bär ingen konteringshistorik i Eveno — ingen accrual, period-
 * kontering eller moms ur det gamla systemet. Annullering, kreditering och kundförlust skulle
 * då antingen ta bort skulden ur reskontran utan verifikat (annullering: motverifikatet hoppas
 * över när accrual saknas) eller bokföra ett antagande (kredit 39xx/1510, kundförlust
 * 1515/1510 med dagens datum). Inget sådant antagande görs: vägarna spärras uttryckligen.
 * Betalning, delbetalning och avmatchning är oförändrade (prövade i K-B1/T4-2).
 */
export const HISTORISK_SKULD_SPARR =
  'Avin är en historisk skuld före brytdatum (öppningspaket). Den saknar konteringsunderlag ' +
  'i Eveno, så den kan inte annulleras, krediteras eller skrivas av här — det skulle ' +
  'ändra reskontran utan korrekt verifikat. Hantera den i Fortnox (det gamla systemets ' +
  'kontering) eller reglera den genom en betalning.'

export function arHistoriskSkuld(notice: { origin?: string | null }): boolean {
  return notice.origin === 'OPENING_PACKAGE'
}
