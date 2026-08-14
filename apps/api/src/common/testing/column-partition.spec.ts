/**
 * HJÄLPARENS EGNA NEGATIVKONTROLLER — villkor 1 för utbrytningen.
 *
 * Utbrytning koncentrerar risk: fyra kopior av en regel är fyra tillfällen att
 * drifta blint, men en delad hjälpare med ett fel gör fyra vakter blinda
 * SAMTIDIGT. Dagen gav båda utfallen, och skillnaden mellan dem var en enda sak
 * — om det delade var negativkontrollerat.
 *
 * Den här filen är det villkoret. Ett påstående per assertion hjälparen gör, och
 * varje påstående prövat i BÅDA riktningarna: att det håller när partitionen är
 * korrekt, och att det FALLER när den inte är det. En hjälpare som bara testas
 * med giltig indata bevisar ingenting — den kan returnera tomma mängder alltid.
 *
 * `Organization` används som fixtur eftersom den är stabil, har många kolumner
 * och är den modell hjälparen först skrevs för (#448).
 */

import { partitioneraKolumner } from './column-partition'
import { skaläraKolumner } from './schema-columns'

const MODELL = 'Organization'

/** Alla kolumner, för att bygga korrekta och trasiga partitioner ur dem. */
const ALLA = skaläraKolumner(MODELL)

describe('partitioneraKolumner', () => {
  it('en KORREKT partition ger tomma felmängder', () => {
    // Positiv kontroll. Utan den kan en hjälpare som alltid returnerar fel se
    // ut att fungera i alla negativa tester nedan.
    const r = partitioneraKolumner({
      modell: MODELL,
      burna: [ALLA.slice(0, 5)],
      utelämnade: Object.fromEntries(ALLA.slice(5).map((k) => [k, 'skäl'])),
      golv: 10,
    })
    expect(r.oklassade).toEqual([])
    expect(r.föråldrade).toEqual([])
    expect(r.iBåda).toEqual([])
    expect(r.kolumner.length).toBe(ALLA.length)
  })

  it('OKLASSAD kolumn hittas — varken buren eller utelämnad', () => {
    const utelämnadeUtomEn = Object.fromEntries(
      ALLA.slice(5, ALLA.length - 1).map((k) => [k, 'skäl']),
    )
    const r = partitioneraKolumner({
      modell: MODELL,
      burna: [ALLA.slice(0, 5)],
      utelämnade: utelämnadeUtomEn,
      golv: 10,
    })
    expect(r.oklassade).toEqual([ALLA[ALLA.length - 1]])
  })

  it('FÖRÅLDRAT undantag hittas — motivering för en kolumn som inte finns', () => {
    const r = partitioneraKolumner({
      modell: MODELL,
      burna: [ALLA],
      utelämnade: { kolumnSomAldrigFunnits: 'skäl' },
      golv: 10,
    })
    expect(r.föråldrade).toEqual(['kolumnSomAldrigFunnits'])
  })

  it('kolumn i BÅDA mängderna hittas — partitionen är då ingen partition', () => {
    // Lärdomen från #444:s negativkontroll: ett fält i båda mängderna faller ur
    // båda filtren och får vakten att TIGA i stället för att falla.
    const dubblerad = ALLA[0] as string
    const r = partitioneraKolumner({
      modell: MODELL,
      burna: [ALLA],
      utelämnade: { [dubblerad]: 'skäl' },
      golv: 10,
    })
    expect(r.iBåda).toEqual([dubblerad])
  })

  it('FLERA burna listor: en kolumn räknas som klassad om NÅGON form bär den', () => {
    // #461:s fall — två svarsformer för samma modell.
    const r = partitioneraKolumner({
      modell: MODELL,
      burna: [ALLA.slice(0, 3), ALLA.slice(3, 6)],
      utelämnade: Object.fromEntries(ALLA.slice(6).map((k) => [k, 'skäl'])),
      golv: 10,
    })
    expect(r.oklassade).toEqual([])
  })

  it('GOLVET kastar — en partition mot för få kolumner är tomt-mängd-sann', () => {
    // Den enda assertionen konsumenten INTE kan glömma, därför ett kast och
    // inte ett returnerat värde.
    expect(() =>
      partitioneraKolumner({
        modell: MODELL,
        burna: [ALLA],
        utelämnade: {},
        golv: ALLA.length + 1,
      }),
    ).toThrow(/golvet är/)
  })

  it('okänd modell kastar — ett stavfel ska inte ge en tom partition', () => {
    expect(() =>
      partitioneraKolumner({
        modell: 'ModellSomInteFinns',
        burna: [[]],
        utelämnade: {},
        golv: 0,
      }),
    ).toThrow(/finns inte i schema.prisma/)
  })
})
