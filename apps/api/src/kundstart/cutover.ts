/**
 * KUNDSTART-001: brytdatum (billingCutoverDate) — EN serverregel för varje väg som skapar
 * avier: månadsplanen (cron, HTTP, AI, förhandsvisning), initiala avier (worker,
 * controller, återtrigg, deposition) och efterdebitering (kö, förhandsvisning, bekräftelse).
 *
 * Definition (KONTRAKT-001 §1, §5): brytdatum är den FÖRSTA dag Eveno fakturerar och är
 * alltid den 1:a i en månad enligt svensk kalender. Gränsen jämförs som heltal (år, månad)
 * mot avins period — aldrig mot en UTC-tidsstämpel. En period FÖRE brytdatum är fakturerad
 * i tidigare system och skapas aldrig i Eveno. NULL = ingen gräns (oförändrat beteende).
 *
 * `DATE`-kolumnen kommer från Prisma som UTC-midnatt; år och månad läses därför i UTC.
 */
export function brytAr(cutover: Date): { year: number; month: number } {
  return { year: cutover.getUTCFullYear(), month: cutover.getUTCMonth() + 1 }
}

export function periodForeBrytdatum(cutover: Date | null, year: number, month: number): boolean {
  if (!cutover) return false
  const b = brytAr(cutover)
  return year < b.year || (year === b.year && month < b.month)
}

export function brytdatumIso(cutover: Date): string {
  return cutover.toISOString().slice(0, 10)
}

export function foreBrytdatumSkal(cutover: Date): string {
  return (
    `Perioden ligger före organisationens brytdatum ${brytdatumIso(cutover)} — den är ` +
    'fakturerad i tidigare system och skapas inte i Eveno.'
  )
}

/**
 * Tolkar ett föreslaget brytdatum. Bara 'ÅÅÅÅ-MM-01' godtas: ett datum mitt i en period
 * avvisas med skäl i stället för att avrundas (KUNDSTART C2).
 */
export function tolkaBrytdatum(
  iso: string,
): { ok: true; datum: Date } | { ok: false; skal: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return { ok: false, skal: 'Brytdatum ska anges som ÅÅÅÅ-MM-DD.' }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const datum = new Date(Date.UTC(y, mo - 1, d))
  if (datum.getUTCFullYear() !== y || datum.getUTCMonth() !== mo - 1 || datum.getUTCDate() !== d)
    return { ok: false, skal: `${iso} är inget giltigt datum.` }
  if (d !== 1)
    return {
      ok: false,
      skal:
        `Brytdatum måste vara den 1:a i en månad (hyresperioden är hel kalendermånad). ` +
        `${iso} ligger mitt i en period och avrundas inte — ange ${iso.slice(0, 8)}01 eller ` +
        'den 1:a i nästa månad.',
    }
  return { ok: true, datum }
}
