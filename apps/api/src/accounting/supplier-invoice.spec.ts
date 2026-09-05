/**
 * Fakturametodens rader och det BERÄKNADE tillståndet.
 *
 * Konteringen prövas här som rena funktioner; att de två stegen tar ut varandra
 * i huvudboken ägs av `supplier-invoice.db.spec.ts` mot riktig Postgres.
 */

import { calculateVat, vatFromGross } from '@eken/shared'
import {
  byggLeverantorsbetalningsrader,
  byggLeverantorsfakturareverseringsrader,
  byggLeverantorsfakturarader,
  KONTO_BANK,
  KONTO_INGAENDE_MOMS,
  KONTO_LEVERANTORSSKULD,
} from './manual-entry'
import {
  cancelBlockedReason,
  isOpen,
  isOverdue,
  cancellationSourceId,
  paymentSourceId,
  receiptSourceId,
  supplierInvoiceStatus,
} from './supplier-invoice-status'

const KONTON = new Map<number, string>([
  [1930, 'id-1930'],
  [2440, 'id-2440'],
  [2641, 'id-2641'],
  [5070, 'id-5070'],
])

describe('byggLeverantorsfakturarader — mottagandet', () => {
  it('netto på kostnaden, moms på 2641, BRUTTO på 2440', () => {
    const r = byggLeverantorsfakturarader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'Rörmokare' },
      KONTON,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rader).toEqual([
      { accountId: 'id-5070', debit: 1000, description: 'Rörmokare' },
      { accountId: 'id-2440', credit: 1250, description: 'Leverantörsskuld' },
      { accountId: 'id-2641', debit: 250, description: 'Ingående moms' },
    ])
    // RIKTNINGEN uttryckligen: skulden är BRUTTO, inte netto. Den omvända
    // tolkningen ger ett verifikat som balanserar men en skuld som är för liten.
    const skuld = r.rader.find((rad) => rad.accountId === 'id-2440')
    expect(skuld?.credit).toBe(1250)
  })

  it('KONTRASTEN mot kontantmetoden: motkontot är 2440, ALDRIG 1930', () => {
    // Det är hela skillnaden mot `byggUtgiftsrader`. Blir motkontot 1930 här är
    // fakturametoden bara kontantmetoden med ett annat namn.
    const r = byggLeverantorsfakturarader(
      { belopp: 500, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    if (!r.ok) throw new Error(r.fel)
    expect(r.rader.some((rad) => rad.accountId === 'id-2440')).toBe(true)
    expect(r.rader.some((rad) => rad.accountId === 'id-1930')).toBe(false)
  })

  it('utan moms: två rader, ingen 2641', () => {
    const r = byggLeverantorsfakturarader(
      { belopp: 500, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    if (!r.ok) throw new Error(r.fel)
    expect(r.rader).toHaveLength(2)
  })

  it('raderna balanserar', () => {
    const r = byggLeverantorsfakturarader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    if (!r.ok) throw new Error(r.fel)
    const debet = r.rader.reduce((s, rad) => s + (rad.debit ?? 0), 0)
    const kredit = r.rader.reduce((s, rad) => s + (rad.credit ?? 0), 0)
    expect(debet).toBeCloseTo(kredit, 2)
  })

  it('moms större än beloppet avvisas — beloppet är inklusive moms', () => {
    const r = byggLeverantorsfakturarader(
      { belopp: 100, moms: 200, kontonummer: 5070, beskrivning: 'x' },
      KONTON,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fel).toContain('inklusive moms')
  })

  it('saknat 2440 avvisas med kontonumret utskrivet', () => {
    const utan = new Map(KONTON)
    utan.delete(KONTO_LEVERANTORSSKULD)
    const r = byggLeverantorsfakturarader(
      { belopp: 100, kontonummer: 5070, beskrivning: 'x' },
      utan,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fel).toContain(String(KONTO_LEVERANTORSSKULD))
  })
})

describe('byggLeverantorsbetalningsrader — betalningen', () => {
  it('2440 debet, 1930 kredit, BRUTTO på båda', () => {
    const r = byggLeverantorsbetalningsrader(1250, KONTON)
    if (!r.ok) throw new Error(r.fel)
    expect(r.rader).toEqual([
      { accountId: 'id-2440', debit: 1250, description: 'Betald leverantörsfaktura' },
      { accountId: 'id-1930', credit: 1250, description: 'Betalning bank' },
    ])
  })

  it('INGEN moms i betalningssteget — avdraget gjordes vid mottagandet', () => {
    // DEN AVGÖRANDE KONTROLLEN. Att röra 2641 igen hade DUBBLERAT avdraget, och
    // felet BALANSERAR — det syns alltså inte i någon balansgrind.
    const r = byggLeverantorsbetalningsrader(1250, KONTON)
    if (!r.ok) throw new Error(r.fel)
    expect(r.rader.some((rad) => rad.accountId === `id-${KONTO_INGAENDE_MOMS}`)).toBe(false)
  })

  it('saknat bankkonto avvisas', () => {
    const utan = new Map(KONTON)
    utan.delete(KONTO_BANK)
    expect(byggLeverantorsbetalningsrader(100, utan).ok).toBe(false)
  })

  it('belopp ≤ 0 avvisas', () => {
    expect(byggLeverantorsbetalningsrader(0, KONTON).ok).toBe(false)
  })
})

describe('supplierInvoiceStatus — beräknat, aldrig en flagga', () => {
  it('varken betald eller makulerad → OPEN', () => {
    expect(supplierInvoiceStatus({ paidAt: null, cancelledAt: null })).toBe('OPEN')
    expect(isOpen({ paidAt: null, cancelledAt: null })).toBe(true)
  })

  it('betald → PAID', () => {
    expect(supplierInvoiceStatus({ paidAt: new Date(), cancelledAt: null })).toBe('PAID')
  })

  it('makulerad → CANCELLED', () => {
    expect(supplierInvoiceStatus({ paidAt: null, cancelledAt: new Date() })).toBe('CANCELLED')
  })

  it('BÅDA satta → PAID, inte CANCELLED — pengar som lämnat kontot får inte döljas', () => {
    // Kombinationen är ett datafel som skrivvägen hindrar. Ordningen här är
    // andra lagret: att svara CANCELLED hade dolt en faktisk betalning.
    expect(supplierInvoiceStatus({ paidAt: new Date(), cancelledAt: new Date() })).toBe('PAID')
  })
})

describe('isOverdue — bara ÖPPNA kan förfalla', () => {
  const igår = new Date('2026-09-04')
  const nu = new Date('2026-09-05T12:00:00Z')

  it('öppen med passerat förfallodatum → förfallen', () => {
    expect(isOverdue({ paidAt: null, cancelledAt: null, dueDate: igår }, nu)).toBe(true)
  })

  it('BETALD med passerat förfallodatum är INTE förfallen', () => {
    // En betald faktura som betalades sent är betald. Att färga den röd hade
    // gjort en åtgärdslista till en historikbok.
    expect(isOverdue({ paidAt: new Date(), cancelledAt: null, dueDate: igår }, nu)).toBe(false)
  })

  it('makulerad är inte förfallen', () => {
    expect(isOverdue({ paidAt: null, cancelledAt: new Date(), dueDate: igår }, nu)).toBe(false)
  })

  it('förfaller I DAG är INTE försenad förrän i morgon', () => {
    const idag = new Date('2026-09-05')
    expect(isOverdue({ paidAt: null, cancelledAt: null, dueDate: idag }, nu)).toBe(false)
  })

  it('förfaller i morgon är inte förfallen', () => {
    const imorgon = new Date('2026-09-06')
    expect(isOverdue({ paidAt: null, cancelledAt: null, dueDate: imorgon }, nu)).toBe(false)
  })
})

describe('cancelBlockedReason — en spärr ska säga varför', () => {
  it('obetald går att makulera', () => {
    expect(cancelBlockedReason({ paidAt: null, cancelledAt: null })).toBeNull()
  })

  it('BETALD blockeras, och skälet pekar på motverifikatet', () => {
    // Makulering nollar ingenting i huvudboken. En "makulerad" betald faktura
    // hade lämnat både kostnaden och betalningen kvar medan listan påstod att
    // posten inte finns.
    const skäl = cancelBlockedReason({ paidAt: new Date(), cancelledAt: null })
    expect(skäl).toContain('motverifikat')
  })

  it('redan makulerad blockeras', () => {
    expect(cancelBlockedReason({ paidAt: null, cancelledAt: new Date() })).toContain('makulerad')
  })
})

describe('idempotensnycklarna', () => {
  it('mottagande och betalning har SKILDA nycklar', () => {
    // Med en gemensam nyckel hade betalningen blivit en idempotensträff på
    // mottagandet — tyst ingen bokföring, och en skuld som aldrig regleras.
    const id = 'abc-123'
    expect(receiptSourceId(id)).not.toBe(paymentSourceId(id))
  })

  it('nycklarna bär fakturans id', () => {
    expect(receiptSourceId('abc')).toContain('abc')
    expect(paymentSourceId('abc')).toContain('abc')
  })
})

describe('byggLeverantorsfakturareverseringsrader — makuleringen vänder mottagandet', () => {
  const indata = { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'Rörmokare' }

  it('varje rad byter sida, ingen rad tillkommer eller försvinner', () => {
    const framat = byggLeverantorsfakturarader(indata, KONTON)
    const bakat = byggLeverantorsfakturareverseringsrader(indata, KONTON)
    if (!framat.ok || !bakat.ok) throw new Error('kunde inte bygga rader')

    expect(bakat.rader).toHaveLength(framat.rader.length)
    for (const fram of framat.rader) {
      const back = bakat.rader.find((r) => r.accountId === fram.accountId)
      expect(back).toBeDefined()
      // Debet blir kredit och tvärtom, med SAMMA belopp. Ett annat belopp hade
      // gett två balanserade verifikat vars summa inte är noll — osynligt för
      // varje balanskontroll som ser ett verifikat i taget.
      expect(back?.credit ?? 0).toBeCloseTo(fram.debit ?? 0, 2)
      expect(back?.debit ?? 0).toBeCloseTo(fram.credit ?? 0, 2)
    }
  })

  it('debiterar 2440 med BRUTTOT — skulden försvinner', () => {
    const bakat = byggLeverantorsfakturareverseringsrader(indata, KONTON)
    if (!bakat.ok) throw new Error(bakat.fel)
    const skuld = bakat.rader.find((r) => r.accountId === KONTON.get(KONTO_LEVERANTORSSKULD))
    expect(skuld?.debit).toBeCloseTo(1250, 2)
    expect(skuld?.credit).toBeUndefined()
  })

  it('krediterar kostnaden med NETTOT och momsen separat', () => {
    const bakat = byggLeverantorsfakturareverseringsrader(indata, KONTON)
    if (!bakat.ok) throw new Error(bakat.fel)
    expect(bakat.rader.find((r) => r.accountId === KONTON.get(5070))?.credit).toBeCloseTo(1000, 2)
    expect(bakat.rader.find((r) => r.accountId === KONTON.get(2641))?.credit).toBeCloseTo(250, 2)
  })

  it('BANKKONTOT rörs inte — makulering flyttar inga pengar', () => {
    const bakat = byggLeverantorsfakturareverseringsrader(indata, KONTON)
    if (!bakat.ok) throw new Error(bakat.fel)
    expect(bakat.rader.some((r) => r.accountId === KONTON.get(1930))).toBe(false)
  })

  it('ärver mottagandets valideringsfel i stället för att ha egna', () => {
    // Byggd UR mottagandet, så ett okänt konto fälls med samma text. Två egna
    // uppräkningar hade kunnat säga olika saker om samma indata.
    const utfall = byggLeverantorsfakturareverseringsrader({ ...indata, kontonummer: 9999 }, KONTON)
    expect(utfall.ok).toBe(false)
    if (!utfall.ok) expect(utfall.fel).toContain('9999')
  })

  it('de TRE nycklarna är olika', () => {
    const id = 'abc-123'
    expect(new Set([receiptSourceId(id), paymentSourceId(id), cancellationSourceId(id)]).size).toBe(
      3,
    )
  })
})

describe('momsen är SERVERNS uträkning — vatRate lagras, vatAmount bokförs', () => {
  // Riggen är ren aritmetik: det som prövas är regeln, inte Prisma. Den skarpa
  // vägen (SupplierInvoiceService.create) använder samma `vatFromGross` och
  // samma tolerans.
  const godtas = (brutto: number, sats: number, inskickad?: number) => {
    const beraknad = vatFromGross(brutto, sats)
    const moms = inskickad ?? beraknad
    return Math.abs(moms - beraknad) <= 0.01
  }

  it('utelämnat momsbelopp räknas fram ur brutto och sats', () => {
    expect(vatFromGross(1250, 25)).toBe(250)
    expect(vatFromGross(1120, 12)).toBe(120)
    expect(vatFromGross(1060, 6)).toBe(60)
  })

  it('0 % ger noll moms', () => {
    expect(vatFromGross(1000, 0)).toBe(0)
  })

  it('DEN AVGÖRANDE: fel formel (belopp × sats/100) FÄLLS', () => {
    // 1250 × 25/100 = 312,50. Ett verifikat med det talet BALANSERAR — netto
    // 937,50 mot skuld 1250 — men bokför fel summa som kostnad. Ingen
    // balansgrind kan se det; den här kontrollen kan.
    expect(godtas(1250, 25, 312.5)).toBe(false)
  })

  it('noll moms med 25 % angivet FÄLLS — registret får inte säga emot verifikatet', () => {
    expect(godtas(1250, 25, 0)).toBe(false)
  })

  it('en ÖRES avvikelse godtas — leverantören kan ha avrundat åt andra hållet', () => {
    expect(godtas(1250, 25, 250.01)).toBe(true)
    expect(godtas(1250, 25, 249.99)).toBe(true)
  })

  it('två ören godtas INTE — toleransen är avrundning, inte slack', () => {
    expect(godtas(1250, 25, 250.02)).toBe(false)
  })

  it('vatFromGross är MOTSATSEN till calculateVat — de tas lätt för varandra', () => {
    // calculateVat(1000, 25) = 250 lägger TILL momsen på ett netto.
    // vatFromGross(1250, 25) = 250 bryter UT den ur ett brutto.
    // Samma svar för olika indata; fel funktion på fel tal är felet.
    expect(calculateVat(1000, 25)).toBe(250)
    expect(vatFromGross(1250, 25)).toBe(250)
    expect(vatFromGross(1000, 25)).not.toBe(calculateVat(1000, 25))
  })
})
