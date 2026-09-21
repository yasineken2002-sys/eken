/**
 * EN SUMMERING AV DEPOSITIONSAVDRAG, ANVÄND AV BÅDA SIDOR.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * `Deposit.deductions` är en JSON-kolumn. Två ställen läser den och behövde
 * summera den: `DepositsService.refund`, som prövar att återbetalning plus
 * avdrag går jämnt ut mot depositionsbeloppet innan verifikatet skrivs, och
 * hyresgästportalen, som visar raderna.
 *
 * Portalen hade sin egen `reduce`. Det var en andra beskrivning av samma
 * räkning, och T2:s granskning hade rätt i att det är precis den formen som
 * senare säger något annat än bokföringen. Summan bor därför här, och båda
 * anropar den.
 *
 * ── DET HÄR ÄR INGET NYTT REGELVERK ─────────────────────────────────────────
 *
 * Funktionen avgör INTE vad ett avdrag får vara, hur många de får vara eller om
 * de är rimliga. Den läser rader som redan är BESLUTADE och lägger ihop dem.
 * Beslutet, valideringen och verifikatet ligger kvar i `refund()`, och
 * `RefundDepositSchema`/`DeductionDto` är fortfarande det som bestämmer vad som
 * får skrivas in.
 *
 * Semantiken är med flit IDENTISK med den `reduce` portalen och `refund()` hade
 * var för sig: ett osummerat, oavrundat tal. Avrundningen är anroparens, precis
 * som förut — `refund()` avrundar först när den jämför mot depositionsbeloppet.
 * Byter den här funktionen avrundningsbeteende ändras en balanskontroll som
 * bokför, och det är inte vad en refaktorering får göra.
 *
 * ── ETT SAKNAT BELOPP ÄR INTE NOLL ──────────────────────────────────────────
 *
 * Portalen gjorde `Number(rad.amount ?? 0)`. En rad utan belopp blev då `0 kr`,
 * vilket ser ut som ett avdrag på noll kronor — alltså en uppgift — i stället
 * för som ett okänt belopp. Samma fel som `NULL` och `''` någon annanstans i
 * den här kodbasen: tomhet får inte se ut som ett värde.
 *
 * Ogiltiga rader räknas därför INTE in i `summa`, och `fullstandig` säger om
 * något lämnats utanför. En summa som tyst hoppar över rader är en felaktig
 * summa; en summa som säger att den är ofullständig är en riktig summa med en
 * gräns.
 */

/** En rad som den ser ut när den läses ur JSON-kolumnen — alltså otypad. */
export type RaAvdragsrad = { reason?: unknown; amount?: unknown } | null | undefined

export type Avdragsrad = {
  /** `null` = ingen anledning står i raden. Inte "Ej angiven" som text. */
  anledning: string | null
  /** `null` = beloppet saknas eller är inte ett ändligt tal. Aldrig 0 som ersättning. */
  belopp: number | null
}

export type Avdragssummering = {
  rader: Avdragsrad[]
  /**
   * Summan av de rader som HAR ett giltigt belopp. Oavrundad — avrundningen är
   * anroparens, se filhuvudet.
   */
  summa: number
  /** Antal rader vars belopp inte gick att läsa. */
  antalUtanBelopp: number
  /** Sant när varje rad bar ett giltigt belopp, alltså när `summa` är hel. */
  fullstandig: boolean
}

function giltigtBelopp(värde: unknown): number | null {
  if (typeof värde === 'number') return Number.isFinite(värde) ? värde : null
  // Decimal-kolumner och JSON skrivna av äldre kod kan bära talet som sträng.
  // `Number('')` är 0 och `Number(' ')` är 0 — därför prövas tomhet först,
  // annars hade en tom sträng blivit ett avdrag på noll kronor.
  if (typeof värde === 'string') {
    const trimmad = värde.trim()
    if (trimmad === '') return null
    const tal = Number(trimmad)
    return Number.isFinite(tal) ? tal : null
  }
  return null
}

/**
 * Läser och summerar beslutade avdrag ur `Deposit.deductions`.
 *
 * Indata är `unknown` därför att kolumnen är JSON: det som faktiskt ligger där
 * är inte garanterat av någon typ vid läsningen, bara vid skrivningen.
 */
export function summeraDepositionsavdrag(deductions: unknown): Avdragssummering {
  const råa: RaAvdragsrad[] = Array.isArray(deductions) ? (deductions as RaAvdragsrad[]) : []

  const rader: Avdragsrad[] = råa
    .filter((rad): rad is { reason?: unknown; amount?: unknown } => {
      return typeof rad === 'object' && rad !== null
    })
    .map((rad) => ({
      anledning: typeof rad.reason === 'string' && rad.reason.trim() !== '' ? rad.reason : null,
      belopp: giltigtBelopp(rad.amount),
    }))

  const medBelopp = rader.filter((rad): rad is Avdragsrad & { belopp: number } => {
    return rad.belopp !== null
  })

  return {
    rader,
    summa: medBelopp.reduce((summa, rad) => summa + rad.belopp, 0),
    antalUtanBelopp: rader.length - medBelopp.length,
    fullstandig: rader.length === medBelopp.length,
  }
}
