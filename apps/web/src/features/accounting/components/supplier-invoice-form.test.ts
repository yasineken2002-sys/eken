import { describe, expect, it } from 'vitest'
import {
  arForfallen,
  beraknaBelopp,
  fakturaFel,
  idagIso,
  type LeverantorsfakturaUtkast,
} from './supplier-invoice-form'

const kontoFinns = (n: number) => [1930, 2440, 2641, 5070].includes(n)

const utkast = (över: Partial<LeverantorsfakturaUtkast> = {}): LeverantorsfakturaUtkast => ({
  supplierName: 'Rörjouren AB',
  invoiceNumber: 'F-100',
  description: 'Stambyte trapphus B',
  invoiceDate: '2026-09-01',
  dueDate: '2026-10-01',
  expenseAccount: '5070',
  amount: '1250',
  vatRate: 25,
  ...över,
})

describe('beraknaBelopp — momsen bryts UT ur bruttot', () => {
  it('25 % på 1250 ger 250 moms och 1000 netto', () => {
    // DEN AVGÖRANDE KONTROLLEN. Formeln belopp × sats/100 hade gett 312,50 och
    // ett netto som inte stämmer med fakturan — ett fel som är osynligt i ett
    // verifikat som ändå balanserar.
    expect(beraknaBelopp(utkast())).toEqual({ brutto: 1250, moms: 250, netto: 1000 })
  })

  it('0 % ger ingen moms', () => {
    expect(beraknaBelopp(utkast({ vatRate: 0 }))).toEqual({ brutto: 1250, moms: 0, netto: 1250 })
  })

  it('komma som decimaltecken', () => {
    expect(beraknaBelopp(utkast({ amount: '1 250,00' })).brutto).toBe(1250)
  })
})

describe('fakturaFel', () => {
  it('komplett formulär ger null', () => {
    expect(fakturaFel(utkast(), kontoFinns)).toBeNull()
  })

  it('för kort leverantörsnamn fälls först', () => {
    expect(fakturaFel(utkast({ supplierName: 'A' }), kontoFinns)).toContain('leverantörens namn')
  })

  it('FÖRFALLODATUM FÖRE FAKTURADATUM säger vilket förhållande som brutits', () => {
    // "Ogiltigt datum" hade lämnat den som fyller i att gissa vilket av två
    // fält som är fel.
    const fel = fakturaFel(utkast({ dueDate: '2026-08-01' }), kontoFinns)
    expect(fel).toContain('före fakturadatum')
  })

  it('samma dag är tillåtet — kontantfaktura med noll dagars kredit', () => {
    expect(fakturaFel(utkast({ dueDate: '2026-09-01' }), kontoFinns)).toBeNull()
  })

  it('belopp noll fälls', () => {
    expect(fakturaFel(utkast({ amount: '0' }), kontoFinns)).toContain('större än noll')
  })

  it('okänt konto fälls med numret utskrivet', () => {
    expect(fakturaFel(utkast({ expenseAccount: '9999' }), kontoFinns)).toContain('9999')
  })

  it('tomt konto fälls med ett annat meddelande än okänt konto', () => {
    // De två kräver olika åtgärd: välja respektive rätta.
    expect(fakturaFel(utkast({ expenseAccount: '' }), kontoFinns)).toContain('Välj')
  })
})

describe('arForfallen — speglar serverns isOverdue', () => {
  const idag = '2026-09-05'

  it('öppen med passerat datum är förfallen', () => {
    expect(arForfallen('2026-09-04', 'OPEN', idag)).toBe(true)
  })

  it('BETALD är inte förfallen, hur gammal den än är', () => {
    expect(arForfallen('2026-01-01', 'PAID', idag)).toBe(false)
  })

  it('makulerad är inte förfallen', () => {
    expect(arForfallen('2026-01-01', 'CANCELLED', idag)).toBe(false)
  })

  it('förfaller I DAG är inte försenad förrän i morgon', () => {
    expect(arForfallen(idag, 'OPEN', idag)).toBe(false)
  })
})

describe('idagIso', () => {
  it('ger ÅÅÅÅ-MM-DD', () => {
    expect(idagIso(new Date('2026-09-05T23:30:00Z'))).toBe('2026-09-05')
  })
})
