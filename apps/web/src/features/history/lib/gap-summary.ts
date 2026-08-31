import type { GapResult, GapStatus } from '../api/history.api'

/**
 * DEN VIKTIGASTE FUNKTIONEN I HELA FLIKEN.
 *
 * "Inget saknas" och "vi vet inte vad som borde ha hänt" är två helt olika
 * besked, och i ett gränssnitt som bara visar det som finns ser de likadana ut:
 * en lugn, tom yta. Hela poängen med luckberäkningen går förlorad i just den
 * likheten — och den är lätt att återinföra av misstag, därför att den ser
 * prydlig ut.
 *
 * Reglerna som håller isär dem:
 *
 *   1. En ODEFINIERAD förväntan får ALDRIG räknas som uppfylld, aldrig döljas
 *      bakom en expandering, och aldrig sammanfattas bort. Den framhävs på
 *      samma villkor som en faktisk lucka.
 *   2. `alltUppfyllt` — det enda som får rendera grönt — kräver att det finns
 *      minst en mätbar förväntan, att ingen av dem brustit, OCH att ingenting
 *      är odefinierat eller okänt. Ett av fyra villkor räcker för att neka.
 *   3. En status funktionen inte känner igen framhävs och räknas som okänd.
 *      Se nedan.
 *
 * ── VARFÖR EN OKÄND STATUS MÅSTE SYNAS, INTE TYSTAS ────────────────────────
 *
 * `GapStatus` är speglad från API:t. Läggs ett femte utfall till där vet den
 * här filen inget om det, och kompilatorn kan inte hjälpa — typen är vår kopia,
 * inte deras. Ett `switch` med `default: return 'uppfyllt'` hade då gjort ett
 * okänt utfall till ett tyst godkännande, vilket är precis det fel modulen
 * finns för att förhindra.
 *
 * Därför är fallback:en åt andra hållet: det vi inte känner igen FRAMHÄVS. Ett
 * okänt utfall blir en synlig rad som ber om en uppdatering av gränssnittet, i
 * stället för en osann lugn yta.
 */

/** Utfall som kräver att någon läser dem. Allt okänt läggs till här. */
const MÅSTE_LÄSAS: ReadonlySet<string> = new Set<GapStatus>(['LUCKA', 'ODEFINIERAD'])

/** Utfall som får vila hopfällda — och bara dessa två. */
const FÅR_VILA: ReadonlySet<string> = new Set<GapStatus>(['UPPFYLLD', 'GÄLLER_EJ'])

export interface GapSummary {
  /** Luckor och odefinierade (plus okända) — renderas alltid, överst. */
  framhävda: GapResult[]
  /** Uppfyllda och ej tillämpliga — hopfällda bakom en räknare. */
  vilande: GapResult[]
  antalLuckor: number
  antalOdefinierade: number
  antalUppfyllda: number
  antalGällerEj: number
  antalOkända: number
  /** Mätbara = de som har en definierad förväntan som faktiskt prövades. */
  antalMätbara: number
  /** Sant BARA när allt mätbart är uppfyllt och inget är okänt eller odefinierat. */
  alltUppfyllt: boolean
  /** En mening som är sann i vart och ett av lägena. */
  mening: string
}

export function summarizeGaps(gaps: readonly GapResult[]): GapSummary {
  const framhävda: GapResult[] = []
  const vilande: GapResult[] = []
  let antalLuckor = 0
  let antalOdefinierade = 0
  let antalUppfyllda = 0
  let antalGällerEj = 0
  let antalOkända = 0

  for (const g of gaps) {
    if (g.status === 'LUCKA') antalLuckor++
    else if (g.status === 'ODEFINIERAD') antalOdefinierade++
    else if (g.status === 'UPPFYLLD') antalUppfyllda++
    else if (g.status === 'GÄLLER_EJ') antalGällerEj++
    else antalOkända++

    // Allt som inte uttryckligen får vila framhävs. Ordningen på villkoren är
    // hela skyddet: en okänd status faller till `framhävda`, inte till `vilande`.
    if (FÅR_VILA.has(g.status) && !MÅSTE_LÄSAS.has(g.status)) vilande.push(g)
    else framhävda.push(g)
  }

  // Luckor först — en bruten förväntan är mer akut än en odefinierad.
  framhävda.sort((a, b) => rang(a.status) - rang(b.status))

  const antalMätbara = antalLuckor + antalUppfyllda
  const alltUppfyllt =
    antalMätbara > 0 && antalLuckor === 0 && antalOdefinierade === 0 && antalOkända === 0

  return {
    framhävda,
    vilande,
    antalLuckor,
    antalOdefinierade,
    antalUppfyllda,
    antalGällerEj,
    antalOkända,
    antalMätbara,
    alltUppfyllt,
    mening: mening({
      antal: gaps.length,
      antalLuckor,
      antalOdefinierade,
      antalUppfyllda,
      antalMätbara,
      antalOkända,
    }),
  }
}

function rang(status: string): number {
  if (status === 'LUCKA') return 0
  if (status === 'ODEFINIERAD') return 1
  return 2
}

interface MeningInput {
  antal: number
  antalLuckor: number
  antalOdefinierade: number
  antalUppfyllda: number
  antalMätbara: number
  antalOkända: number
}

/**
 * Meningen ovanför raderna. Den ska gå att lita på utan att man läser vidare.
 *
 * Ordningen på grenarna är vald så att det svåraste fallet — noll luckor MEN
 * odefinierade förväntningar — aldrig kan falla igenom till en formulering som
 * låter som ett friskintyg. Det fallet har en egen gren, och den säger rakt ut
 * vad som inte går att veta.
 */
function mening(i: MeningInput): string {
  const odefSvans =
    i.antalOdefinierade === 1
      ? '1 förväntan går inte att mäta'
      : `${i.antalOdefinierade} förväntningar går inte att mäta`
  const okändSvans =
    i.antalOkända > 0 ? ` ${i.antalOkända} utfall känns inte igen av gränssnittet.` : ''

  if (i.antal === 0) {
    return 'Inga förväntningar är definierade — ingen lucka kan beräknas här.' + okändSvans
  }
  if (i.antalLuckor > 0) {
    const luckor = i.antalLuckor === 1 ? '1 lucka' : `${i.antalLuckor} luckor`
    const mätbara =
      i.antalMätbara === 1 ? '1 mätbar förväntan' : `${i.antalMätbara} mätbara förväntningar`
    const huvud = `${luckor} bland ${mätbara}`
    return i.antalOdefinierade > 0
      ? `${huvud}, och ${odefSvans}.${okändSvans}`
      : `${huvud}.${okändSvans}`
  }
  if (i.antalOdefinierade > 0) {
    // DET KRITISKA FALLET. Inga luckor är INTE detsamma som inget saknas.
    const odefinierade =
      i.antalOdefinierade === 1
        ? '1 förväntan är odefinierad'
        : `${i.antalOdefinierade} förväntningar är odefinierade`
    const huvud =
      i.antalMätbara > 0
        ? `${
            i.antalMätbara === 1
              ? 'Ingen lucka i den enda förväntan som går att mäta'
              : `Inga luckor bland de ${i.antalMätbara} förväntningar som går att mäta`
          } — men ${odefinierade}`
        : `Ingenting går att mäta här ännu, och ${odefinierade}`
    return `${huvud}, så vi vet inte vad som borde ha hänt där.${okändSvans}`
  }
  if (i.antalMätbara > 0) {
    return i.antalUppfyllda === 1
      ? `Den enda mätbara förväntningen är uppfylld.${okändSvans}`
      : `Alla ${i.antalUppfyllda} mätbara förväntningar är uppfyllda.${okändSvans}`
  }
  return `Ingen förväntan gäller det här objektet ännu.${okändSvans}`
}
