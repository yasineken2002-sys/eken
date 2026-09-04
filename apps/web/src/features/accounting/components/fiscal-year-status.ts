import type { FiscalYearOverviewItem } from '../api/accounting.api'

/**
 * Ren logik för årskortet — avsiktligt skild från komponenten (#704 PR 3).
 *
 * Skälet är att den GÅR ATT PRÖVA. `apps/web` fick en enhetstestkörare i #719;
 * fram till dess hade en funktion som den här bara kunnat mätas genom att rendera
 * hela sidan. Det som avgör om en oåterkallelig knapp är aktiv hör inte hemma
 * inuti en JSX-gren där ingen kan komma åt det.
 */

export type ÅrsKortTon = 'closed' | 'ready' | 'pending'

export interface ÅrsKortStatus {
  ton: ÅrsKortTon
  /** Badge-texten. */
  badge: string
  /** Förklaringen under rubriken — alltid en hel mening. */
  beskrivning: string
  /** Får knappen "Stäng räkenskapsår" vara aktiv? */
  kanStänga: boolean
}

/**
 * Kortets status i klartext.
 *
 * `kanStänga` betyder "månaderna är på plats", INTE "stängningen kommer att
 * lyckas". De dyrare förutsättningarna prövas av förhandsvisningen när dialogen
 * öppnas, och det är dess `canClose` som grindar själva bekräftelsen. Knappen
 * här öppnar en dialog; den bokför ingenting.
 */
export function årsKortStatus(item: FiscalYearOverviewItem): ÅrsKortStatus {
  if (item.status === 'CLOSED') {
    return {
      ton: 'closed',
      badge: 'Stängt',
      beskrivning: 'Räkenskapsåret är stängt och kan inte öppnas igen.',
      kanStänga: false,
    }
  }

  if (item.status === 'READY') {
    return {
      ton: 'ready',
      badge: 'Klart att stänga',
      beskrivning: `Alla månader utom ${item.finalMonth} är stängda. Årsstängningen bokför resultatavräkningen och stänger den sista månaden.`,
      kanStänga: true,
    }
  }

  // MONTHS_PENDING har två helt olika orsaker, och de anvisar olika åtgärder.
  // Att slå ihop dem till "månader återstår" hade skickat operatören att stänga
  // månader som redan är stängda.
  if (item.finalMonthClosed) {
    return {
      ton: 'pending',
      badge: 'Sista månaden stängd',
      beskrivning: `Årets sista månad (${item.finalMonth}) är redan stängd för egen del, så årsavslutsverifikatet kan inte längre bokföras i den. Öppna månaden igen och stäng räkenskapsåret i stället.`,
      kanStänga: false,
    }
  }

  const n = item.monthsRemaining.length
  return {
    ton: 'pending',
    badge: n === 1 ? '1 månad kvar' : `${n} månader kvar`,
    beskrivning:
      n === 0
        ? 'Räkenskapsåret är inte klart att stängas än.'
        : `Följande månader måste stängas först: ${item.monthsRemaining.join(', ')}.`,
    kanStänga: false,
  }
}

/**
 * Har användaren skrivit årtalet rätt?
 *
 * BEKRÄFTELSEN ÄR EN BINDANDE HANDLING. Ett stängt räkenskapsår kan inte öppnas
 * igen — det finns ingen väg tillbaka, varken i UI:t eller i backend. Att skriva
 * årtalet är det som skiljer "jag klickade" från "jag menade det", och det är
 * samma sorts krav som en radering av något oersättligt brukar ha.
 *
 * Jämförelsen sker mot ÅRTALET (`2026`), inte mot etiketten (`2026/2027`): ett
 * brutet räkenskapsår har två kalenderår i namnet, och att kräva ett snedstreck
 * gör bekräftelsen till ett stavningsprov i stället för ett ställningstagande.
 */
export function bekräftelseGiltig(inmatat: string, fiscalYear: number): boolean {
  return inmatat.trim() === String(fiscalYear)
}

/**
 * Ligger den här MÅNADEN i ett låst räkenskapsår?
 *
 * Periodöversikten listar månader och känner inte till räkenskapsår. Utan den
 * här kopplingen ser en stängd månad i ett låst år likadan ut som en stängd
 * månad i ett öppet — och skillnaden är hela poängen: den ena går att öppna
 * igen, den andra gör det inte.
 *
 * Kopplingen görs på MÅNADSNYCKELN (`2026-12`) och inte på kalenderåret. Vid
 * brutet räkenskapsår spänner ett år över två kalenderår, så `item.year` säger
 * ingenting om vilket räkenskapsår månaden hör till. Månadsmängden kommer från
 * backend, som härleder den ur `fiscalYearStartMonth`.
 *
 * Saknas årsdata (frågan laddar, eller föll) svarar funktionen `false`: en
 * utebliven badge är en utebliven upplysning, medan en felaktig badge är ett
 * påstående. Det är rätt håll att fela åt.
 */
export function periodInLockedFiscalYear(
  period: { year: number; month: number },
  years: FiscalYearOverviewItem[] | undefined,
): boolean {
  if (!years) return false
  const nyckel = `${period.year}-${String(period.month).padStart(2, '0')}`
  return years.some(
    (y) =>
      y.status === 'CLOSED' &&
      (y.finalMonth === nyckel || y.monthsRemaining.includes(nyckel) || inomÅret(nyckel, y)),
  )
}

/** Ligger månadsnyckeln inom räkenskapsårets tolv månader? */
function inomÅret(nyckel: string, år: FiscalYearOverviewItem): boolean {
  return nyckel >= år.fiscalStart.slice(0, 7) && nyckel <= år.yearEndDate.slice(0, 7)
}
