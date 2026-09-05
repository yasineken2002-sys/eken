import { describe, expect, it } from 'vitest'
import { bekräftelsetext, spärrskäl, type PaminnelseForhandsbesked } from './reminder-preview'

/**
 * Knappens villkor och bekräftelsens texter. Vitest renderar ingenting, så
 * reglerna prövas som rena funktioner — skälet till att de bor utanför modalen.
 *
 * Det som mäts är att en SPÄRR SÄGER VARFÖR. En grå knapp utan skäl tvingar
 * hyresvärden att gissa mellan "inget att skicka", "inaktuell data" och "trasigt",
 * och de tre kräver olika åtgärder.
 */

const besked = (över: Partial<PaminnelseForhandsbesked> = {}): PaminnelseForhandsbesked => ({
  invoices: [
    { id: 'i1', invoiceNumber: 'F-1', recipient: 'Anna', outstanding: 1000, dueDate: '2026-08-01' },
  ],
  count: 1,
  totalOutstanding: 1000,
  freshness: { stale: false, through: '2026-09-04', ageDays: 1, thresholdDays: 5 },
  ...över,
})

describe('spärrskäl', () => {
  it('färsk data och något att skicka → null (knappen går att trycka)', () => {
    expect(spärrskäl(besked())).toBeNull()
  })

  it('utan underlag ännu → besked om att det hämtas, inte en tyst spärr', () => {
    expect(spärrskäl(undefined)).toContain('Hämtar')
  })

  it('INAKTUELL data spärrar, och skälet bär datum, ålder och gräns', () => {
    // Alla tre talen behövs: datumet säger vad som är känt, åldern varför det är
    // för gammalt, och gränsen vad som skulle räcka. Utan dem är "inaktuell" ett
    // påstående man inte kan handla på.
    const skäl = spärrskäl(
      besked({ freshness: { stale: true, through: '2026-08-01', ageDays: 35, thresholdDays: 5 } }),
    )
    expect(skäl).toContain('2026-08-01')
    expect(skäl).toContain('35')
    expect(skäl).toContain('5')
    expect(skäl).toContain('redan betalat')
  })

  it('ingen betalningsdata alls formuleras som just det, inte som "null dygn"', () => {
    const skäl = spärrskäl(
      besked({ freshness: { stale: true, through: null, ageDays: null, thresholdDays: 5 } }),
    )
    expect(skäl).toContain('ingen betalningsdata är importerad')
    expect(skäl).not.toContain('null')
  })

  it('FÄRSKHETEN GÅR FÖRE tomheten — den enda av de två som säger något om RISK', () => {
    // Med både inaktuell data OCH noll fakturor ska skälet vara färskheten:
    // "inget att skicka" är en tomhet, "kan nå någon som betalat" är en risk.
    const skäl = spärrskäl(
      besked({
        count: 0,
        invoices: [],
        freshness: { stale: true, through: '2026-08-01', ageDays: 35, thresholdDays: 5 },
      }),
    )
    expect(skäl).toContain('inaktuell')
  })

  it('noll fakturor med färsk data → egen text, inte färskhetstexten', () => {
    const skäl = spärrskäl(besked({ count: 0, invoices: [] }))
    expect(skäl).toContain('Ingen förfallen faktura')
    expect(skäl).not.toContain('inaktuell')
  })
})

describe('bekräftelsetext', () => {
  it('säger UPP TILL — antalet är ett tak, inte ett löfte', () => {
    // Dedupen sker per faktura på servern (en påminnelse per faktura och dag).
    // "3 påminnelser skickas" hade varit en osanning för den som redan påmindes.
    const t = bekräftelsetext(besked({ count: 3 }))
    expect(t).toContain('Upp till 3')
    expect(t).toContain('redan påmindes i dag')
  })

  it('böjer singular rätt', () => {
    expect(bekräftelsetext(besked({ count: 1 }))).toContain('Upp till 1 påminnelse ')
  })

  it('böjer plural rätt', () => {
    expect(bekräftelsetext(besked({ count: 2 }))).toContain('Upp till 2 påminnelser')
  })
})
