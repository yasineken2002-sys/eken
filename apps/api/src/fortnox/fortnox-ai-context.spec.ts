import {
  formatFortnoxShadowForAi,
  formatOre,
  type AiReadRow,
  type FortnoxAiSnapshot,
} from './fortnox-ai-context'

const conn = {
  status: 'ACTIVE' as const,
  fortnoxDatabaseNumber: 900001,
  fortnoxCompanyName: 'Testbolag AB',
}
const run = (over: Partial<AiReadRow> = {}): AiReadRow => ({
  id: 'r1',
  status: 'COMPLETE',
  financialYearId: 1,
  financialYearStart: new Date('2026-01-01'),
  financialYearEnd: new Date('2026-12-31'),
  periodFrom: new Date('2026-10-01'),
  periodTo: new Date('2026-10-31'),
  startedAt: new Date('2026-10-31T10:00:00Z'),
  completedAt: new Date('2026-10-31T10:01:00Z'),
  reason: null,
  costAccounts: [5170],
  uncertainties: ['Läsningen är en genomgång sida för sida.'],
  summary: {
    totalOre: 2300000,
    byProperty: [
      { propertyName: 'HUS-A', amountOre: 1900000 },
      { propertyName: 'HUS-B', amountOre: 200000 },
    ],
    unmappedDimensions: [],
    unallocatedOre: 200000,
    uncertainRemovedOre: 0,
    evenoExportOre: 0,
  },
  ...over,
})
const NOW = new Date('2026-10-31T10:31:00Z')
const text = (s: FortnoxAiSnapshot) => formatFortnoxShadowForAi(s, NOW).join('\n')

describe('Fortnox AI-underlag (skuggläge)', () => {
  it('ingen anslutning → inget block (dagens kontext oförändrad)', () => {
    expect(
      formatFortnoxShadowForAi({ connection: null, latestRead: null, latestCompleteRead: null }),
    ).toEqual([])
  })

  it('komplett läsning: färdiga summor, valda konton, återläst per, aldrig "aktuellt" som påstående', () => {
    const t = text({ connection: conn, latestRead: run(), latestCompleteRead: run() })
    expect(t).toContain('Summa: 23 000,00 kr')
    expect(t).toContain('Fastighet HUS-A: 19 000,00 kr')
    expect(t).toContain('Ofördelat (rader utan dimension): 2 000,00 kr')
    expect(t).toContain('konto 5170')
    expect(t).toContain('återläst per')
    expect(t).toContain('30 min sedan')
    expect(t).toMatch(/ändrar INTE Evenos egna siffror/)
  })

  it('ingen komplett läsning → inga belopp, uttryckligen inte 0', () => {
    const t = text({
      connection: conn,
      latestRead: run({ status: 'PARTIAL', summary: null, reason: 'avbrott' }),
      latestCompleteRead: null,
    })
    expect(t).not.toMatch(/\d kr/)
    expect(t).toContain('Ange INGA Fortnox-belopp – inte heller 0')
    expect(t).toContain('ofullständigt: avbrott')
  })

  it('senare misslyckad läsning märks; beloppen anges som den tidigare kompletta', () => {
    const t = text({
      connection: conn,
      latestRead: run({ id: 'r2', status: 'PARTIAL', summary: null, reason: 'avbrott' }),
      latestCompleteRead: run(),
    })
    expect(t).toContain('Beloppen ovan kommer från den tidigare kompletta läsningen')
  })

  it('frånkopplad/AUTH_LOST anges', () => {
    expect(
      text({
        connection: { ...conn, status: 'AUTH_LOST' },
        latestRead: null,
        latestCompleteRead: null,
      }),
    ).toContain('inloggningen har upphört')
  })

  it('öre formateras exakt', () => {
    expect(formatOre(9007199254740990)).toBe('90 071 992 547 409,90 kr')
    expect(formatOre(-5)).toBe('−0,05 kr')
  })
})
