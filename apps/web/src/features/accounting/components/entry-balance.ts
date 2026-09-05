/**
 * SALDORÄKNINGEN FÖR "NY VERIFIKATION" — ren funktion, inte JSX.
 *
 * Webs vitest kör med `environment: 'node'` och renderar ingenting (se
 * `apps/web/vitest.config.ts`), så ett prov på "modalen visar rätt saldo" måste
 * ställas mot en ren funktion. Att lägga räkningen här i stället för i
 * komponenten gör frågan prövbar, och den kostar en indirektion — hela priset.
 *
 * ── DEN HÄR FUNKTIONEN ÄR INTE SPÄRREN ──────────────────────────────────────
 *
 * Balanskravet verkställs i `createNumberedEntry` (C1-grinden) och prövas i
 * `AccountingService.createManualJournalEntry` innan dess. Det här är
 * gränssnittets LÖPANDE BESKED medan hyresvärden skriver — det ska visa exakt
 * samma tal som servern räknar, men det avgör ingenting. En komponent som
 * släppte igenom en obalans får 422 med samma belopp i meddelandet.
 *
 * NOLLTOLERANSEN ÄR DENSAMMA SOM SERVERNS: ett öre. `manual-entry.ts` och
 * `createNumberedEntry` använder samma gräns, och en generösare tolerans här
 * hade gjort knappen klickbar för något servern avvisar.
 */

import { vatFromGross } from '@eken/shared'

/**
 * Balansen jämförs i HELA ÖREN, precis som servern. En tolerans hade gjort
 * knappen klickbar för en obalans backend avvisar — och flyttalsbruset gör en
 * naiv `Math.abs(a - b) > 0.01` till en slack på ett helt öre (`1000 - 999.99`
 * är `0.00999999999999`). Se `accounting/manual-entry.ts` för samma resonemang
 * på serversidan.
 */
export function ioren(v: number): number {
  return Math.round(v * 100)
}

export interface RadUtkast {
  accountNumber: string
  debit: string
  credit: string
  description?: string
}

export interface Saldo {
  debet: number
  kredit: number
  /** Debet − kredit. Positiv = kredit saknas, negativ = debet saknas. */
  differens: number
  balanserar: boolean
  /** Rader som bär ett belopp. Under två går verifikatet inte att bokföra. */
  radermedBelopp: number
}

/**
 * Tolkar ett fält som tal. Tomt, blanktecken och skräp blir 0 — INTE NaN.
 *
 * Skälet är att fälten är fritext medan man skriver: ett halvskrivet "12," ska
 * ge ett saldo som uppdateras, inte "NaN kr". Ett NaN i totalen hade dessutom
 * gjort `balanserar` falskt på ett sätt som inte går att åtgärda genom att
 * fortsätta skriva.
 *
 * Komma accepteras som decimaltecken — svenskt tangentbord, svensk vana.
 */
export function tolkaBelopp(raw: string | undefined): number {
  if (raw === undefined) return 0
  const normaliserad = raw.replace(/\s/g, '').replace(',', '.')
  if (normaliserad === '') return 0
  const n = Number(normaliserad)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function beraknaSaldo(rader: readonly RadUtkast[]): Saldo {
  let debet = 0
  let kredit = 0
  let radermedBelopp = 0

  for (const rad of rader) {
    const d = tolkaBelopp(rad.debit)
    const k = tolkaBelopp(rad.credit)
    if (d > 0 || k > 0) radermedBelopp++
    debet += d
    kredit += k
  }

  const differens = debet - kredit
  return {
    debet,
    kredit,
    differens,
    // Ett tomt formulär BALANSERAR tekniskt (0 = 0) och det vore ett falskt
    // besked: kravet är att verifikatet går att bokföra, inte att två nollor är
    // lika. Därför båda villkoren.
    balanserar: ioren(debet) === ioren(kredit) && debet > 0,
    radermedBelopp,
  }
}

/**
 * Går verifikatet att skicka? Samma mängd villkor som DTO:n och tjänsten
 * kräver, formulerade som ETT svar så att knappen och felmeddelandet inte kan
 * säga olika saker.
 */
export function verifikatFel(
  rader: readonly RadUtkast[],
  beskrivning: string,
  datum: string,
): string | null {
  if (!datum) return 'Välj ett datum.'
  if (beskrivning.trim().length < 3) return 'Beskrivningen måste vara minst 3 tecken.'

  const medKonto = rader.filter((r) => r.accountNumber.trim() !== '')
  if (medKonto.length < 2) return 'Ett verifikat behöver minst två konteringsrader.'

  for (const rad of medKonto) {
    const d = tolkaBelopp(rad.debit)
    const k = tolkaBelopp(rad.credit)
    if (d === 0 && k === 0) {
      return `Rad mot konto ${rad.accountNumber} saknar både debet och kredit.`
    }
    if (d > 0 && k > 0) {
      return `Rad mot konto ${rad.accountNumber} har både debet och kredit — använd separata rader.`
    }
  }

  const saldo = beraknaSaldo(medKonto)
  if (!saldo.balanserar) {
    return `Verifikatet balanserar inte: debet ${saldo.debet.toFixed(2)} kr, kredit ${saldo.kredit.toFixed(2)} kr.`
  }
  return null
}

/**
 * Momsbeloppet ur ett bruttobelopp och en momssats.
 *
 * BRUTTO IN, MOMS UT. `belopp` är det som står på kvittot och det som lämnar
 * banken; momsen är den DEL av det beloppet som är moms — alltså
 * `belopp × sats / (100 + sats)`, inte `belopp × sats / 100`. Den andra formeln
 * ger ett för högt momsbelopp och ett netto som inte stämmer med kvittot, och
 * felet är osynligt i ett verifikat som ändå balanserar.
 */
export function momsAvBrutto(belopp: number, satsProcent: number): number {
  // EN implementation, i @eken/shared. API:t räknar samma sak när det tar emot
  // en leverantörsfaktura, och två kopior av avrundningen hade kunnat ge två
  // svar på samma faktura — förhandsvisningen ett, verifikatet ett annat.
  return vatFromGross(belopp, satsProcent)
}
