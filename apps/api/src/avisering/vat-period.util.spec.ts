/**
 * T1.4 PR3 — vatPeriodLabelsForMonths: namnger berörda momsperioder.
 * Ren funktion, kalenderbaserad, distinkt + kronologiskt sorterad.
 */
import { vatPeriodLabelsForMonths } from './vat-period.util'

describe('vatPeriodLabelsForMonths', () => {
  it('QUARTERLY: mappar månader till kalenderkvartal, distinkt + sorterat', () => {
    const months = [
      { year: 2026, month: 3 }, // Q1
      { year: 2026, month: 5 }, // Q2
      { year: 2026, month: 6 }, // Q2 (dubbett → dedupas)
      { year: 2026, month: 7 }, // Q3
    ]
    expect(vatPeriodLabelsForMonths(months, 'QUARTERLY')).toEqual(['Q1 2026', 'Q2 2026', 'Q3 2026'])
  })

  it('QUARTERLY: kvartalsgränser (mar=Q1, apr=Q2, sep=Q3, okt=Q4)', () => {
    expect(
      vatPeriodLabelsForMonths(
        [
          { year: 2026, month: 3 },
          { year: 2026, month: 4 },
          { year: 2026, month: 9 },
          { year: 2026, month: 10 },
        ],
        'QUARTERLY',
      ),
    ).toEqual(['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026'])
  })

  it('MONTHLY: svenska månadsnamn, distinkt + sorterat', () => {
    expect(
      vatPeriodLabelsForMonths(
        [
          { year: 2026, month: 7 },
          { year: 2026, month: 5 },
          { year: 2026, month: 5 },
        ],
        'MONTHLY',
      ),
    ).toEqual(['maj 2026', 'juli 2026'])
  })

  it('YEARLY (kalenderår, fym=1): en etikett per kalenderår', () => {
    expect(
      vatPeriodLabelsForMonths(
        [
          { year: 2025, month: 12 },
          { year: 2026, month: 1 },
          { year: 2026, month: 6 },
        ],
        'YEARLY',
      ),
    ).toEqual(['2025', '2026'])
  })

  // Bokförings-expert HIGH: helårsmoms redovisas per beskattningsår (SFL 26:11),
  // inte kalenderår, vid brutet räkenskapsår.
  it('YEARLY (brutet räkenskapsår, fym=5): etiketten speglar beskattningsåret maj–apr', () => {
    // fym=5 (maj–apr). feb & mar 2026 hör till beskattningsåret maj 2025–apr 2026.
    // maj & jun 2026 hör till maj 2026–apr 2027.
    expect(
      vatPeriodLabelsForMonths(
        [
          { year: 2026, month: 2 }, // → maj 2025–apr 2026
          { year: 2026, month: 3 }, // → maj 2025–apr 2026 (dedup)
          { year: 2026, month: 5 }, // → maj 2026–apr 2027
        ],
        'YEARLY',
        5,
      ),
    ).toEqual(['maj 2025–april 2026', 'maj 2026–april 2027'])
  })

  it('sorterar korrekt över årsskiften (QUARTERLY)', () => {
    expect(
      vatPeriodLabelsForMonths(
        [
          { year: 2026, month: 2 }, // Q1 2026
          { year: 2025, month: 11 }, // Q4 2025
        ],
        'QUARTERLY',
      ),
    ).toEqual(['Q4 2025', 'Q1 2026'])
  })

  it('tom input → tom lista', () => {
    expect(vatPeriodLabelsForMonths([], 'QUARTERLY')).toEqual([])
  })
})
