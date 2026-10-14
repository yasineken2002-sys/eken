import { brytdatumIso } from './cutover'

/** Bankdagen ska redan ha importens dagrepresentation (UTC-midnatt). NULL ger ingen gräns. */
export function bankdagForeBrytdatum(bankdag: Date, cutover: Date | null): boolean {
  return cutover !== null && brytdatumIso(bankdag) < brytdatumIso(cutover)
}

export function bankdagForeBrytdatumSkal(bankdag: Date, cutover: Date): string {
  return (
    `Bankdagen ${brytdatumIso(bankdag)} ligger före organisationens brytdatum ` +
    `${brytdatumIso(cutover)}. Betalningen kan inte fördelas i Eveno. ` +
    'Bankraden finns kvar för avstämning; ingen betalning eller bokföring skapades.'
  )
}
