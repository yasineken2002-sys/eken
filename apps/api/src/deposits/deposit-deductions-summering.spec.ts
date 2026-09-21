import { summeraDepositionsavdrag } from '@eken/shared'

/**
 * DEN GEMENSAMMA SUMMERINGEN AV DEPOSITIONSAVDRAG.
 *
 * ── VAD FILEN SKA FÅNGA ─────────────────────────────────────────────────────
 *
 * Funktionen läses av TVÅ anropare med olika förutsättningar:
 *
 *   `DepositsService.refund`  — indata har gått genom `DeductionDto`
 *                               (`@IsNumber() @Min(0)` per rad). Här får
 *                               semantiken INTE ändras: talet går in i en
 *                               balanskontroll som avgör om ett verifikat
 *                               skrivs.
 *   Hyresgästportalen        — indata är en JSON-kolumn utan DTO bakom sig.
 *                               Här är det tvärtom gränsfallen som betyder
 *                               något.
 *
 * Proven nedan mäter båda halvorna. Paritetsprovet är det viktigaste: det
 * jämför funktionen med den `reduce` som stod i `refund()` innan, så att
 * refaktoreringen bevisligen inte flyttade ett tal som bokför.
 *
 * ── VAD PROVEN INTE MÄTER ───────────────────────────────────────────────────
 *
 *   • Ingenting om VAD ett avdrag får vara. Funktionen lägger ihop beslutade
 *     rader; beslutet och valideringen ligger kvar i `refund()` och i DTO:n.
 *   • Ingenting om bokföringen. Att summan stämmer med huvudboken är en annan
 *     fråga — och just därför säger portalen ut att talet är en summering av de
 *     visade raderna och inte ett saldo.
 */

/** Den `reduce` som stod i `refund()` före den gemensamma summeringen. */
function gamlaReduce(deductions: { amount: number }[]): number {
  return deductions.reduce((sum, d) => sum + Number(d.amount), 0)
}

describe('summeraDepositionsavdrag — paritet med den reduce som ersattes', () => {
  const fall: { namn: string; rader: { reason: string; amount: number }[] }[] = [
    { namn: 'tom lista', rader: [] },
    { namn: 'en rad, hela kronor', rader: [{ reason: 'Skada', amount: 4500 }] },
    {
      namn: 'två rader med ören',
      rader: [
        { reason: 'Skada', amount: 4500.5 },
        { reason: 'Städning', amount: 300.2 },
      ],
    },
    { namn: 'noll kronor är ett belopp', rader: [{ reason: 'Ingen kostnad', amount: 0 }] },
    {
      namn: 'många rader',
      rader: Array.from({ length: 25 }, (_, i) => ({ reason: `Rad ${i}`, amount: i * 10.33 })),
    },
  ]

  it.each(fall)('$namn ger exakt samma tal som förut', ({ rader }) => {
    // Bitidentiskt, inte "ungefär": flyttalssumman måste vara samma, annars kan
    // balanskontrollen i `refund()` falla ut på andra sidan sin 0,01-tolerans.
    expect(summeraDepositionsavdrag(rader).summa).toBe(gamlaReduce(rader))
  })

  it('summan är OAVRUNDAD — avrundningen är anroparens, som förut', () => {
    // `refund()` avrundar först i jämförelsen (`(refundAmount + total).toFixed(2)`).
    // Avrundade funktionen själv hade den ändrat ett tal som bokför.
    const summering = summeraDepositionsavdrag([
      { reason: 'a', amount: 4500.5 },
      { reason: 'b', amount: 300.2 },
    ])
    expect(summering.summa).toBe(4500.5 + 300.2)
    expect(summering.summa.toFixed(2)).toBe('4800.70')
  })

  it('DTO-giltig indata kan aldrig ge ofullständig summa', () => {
    const summering = summeraDepositionsavdrag([
      { reason: 'a', amount: 1 },
      { reason: 'b', amount: 2 },
    ])
    expect(summering.antalUtanBelopp).toBe(0)
    expect(summering.fullstandig).toBe(true)
  })
})

describe('summeraDepositionsavdrag — gränsfallen portalen möter i en JSON-kolumn', () => {
  it('ETT SAKNAT BELOPP ÄR INTE NOLL', () => {
    // `Number(rad.amount ?? 0)` gjorde raden till "0 kr", alltså till en
    // uppgift. Noll kronor och okänt belopp är två olika saker.
    const summering = summeraDepositionsavdrag([{ reason: 'Okänt' }])
    expect(summering.rader).toEqual([{ anledning: 'Okänt', belopp: null }])
    expect(summering.summa).toBe(0)
    expect(summering.antalUtanBelopp).toBe(1)
    expect(summering.fullstandig).toBe(false)
  })

  it('en TOM STRÄNG blir inte noll — `Number("")` är 0 och det är fällan', () => {
    expect(summeraDepositionsavdrag([{ reason: 'a', amount: '' }]).rader[0]!.belopp).toBeNull()
    expect(summeraDepositionsavdrag([{ reason: 'a', amount: '   ' }]).rader[0]!.belopp).toBeNull()
  })

  it('ett tal som STRÄNG läses — äldre JSON kan bära det så', () => {
    const summering = summeraDepositionsavdrag([{ reason: 'a', amount: '4500.50' }])
    expect(summering.rader[0]!.belopp).toBe(4500.5)
    expect(summering.fullstandig).toBe(true)
  })

  it('NaN, Infinity och skräptext räknas som saknat belopp, inte som tal', () => {
    for (const skräp of [NaN, Infinity, -Infinity, 'fyratusen', {}, [], true, null]) {
      const summering = summeraDepositionsavdrag([{ reason: 'a', amount: skräp }])
      expect({ skräp: String(skräp), belopp: summering.rader[0]!.belopp }).toEqual({
        skräp: String(skräp),
        belopp: null,
      })
    }
  })

  it('EN SAKNAD ANLEDNING BLIR null, inte texten "Ej angiven"', () => {
    // Portalen skrev "Ej angiven" i data. En etikett hör till vyn; datat ska
    // säga att uppgiften saknas, så att vyn kan välja ord.
    expect(summeraDepositionsavdrag([{ amount: 100 }]).rader[0]!.anledning).toBeNull()
    expect(
      summeraDepositionsavdrag([{ reason: '   ', amount: 100 }]).rader[0]!.anledning,
    ).toBeNull()
  })

  it('en blandning summerar de giltiga och räknar de övriga', () => {
    const summering = summeraDepositionsavdrag([
      { reason: 'Skada', amount: 4500 },
      { reason: 'Okänt' },
      { reason: 'Städning', amount: 300.25 },
      { reason: 'Tomt', amount: '' },
    ])
    expect(summering.summa).toBe(4800.25)
    expect(summering.antalUtanBelopp).toBe(2)
    expect(summering.fullstandig).toBe(false)
  })

  it('något som inte är en lista ger en tom summering i stället för att kasta', () => {
    // Kolumnen är JSON. `null`, ett objekt eller en sträng får inte fälla
    // hyresgästens hela depositionsvy.
    for (const icke of [null, undefined, {}, 'text', 42]) {
      const summering = summeraDepositionsavdrag(icke)
      expect(summering).toEqual({ rader: [], summa: 0, antalUtanBelopp: 0, fullstandig: true })
    }
  })

  it('rader som inte är objekt hoppas över', () => {
    const summering = summeraDepositionsavdrag([null, 'x', 7, { reason: 'Skada', amount: 100 }])
    expect(summering.rader).toEqual([{ anledning: 'Skada', belopp: 100 }])
    expect(summering.summa).toBe(100)
  })
})
