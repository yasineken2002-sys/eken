import { bankdagForeBrytdatum, bankdagForeBrytdatumSkal } from './payment-cutover'

describe('bankdag vid kundstart', () => {
  const cutover = new Date('2026-11-01')
  it.each([
    ['2026-10-31', true],
    ['2026-11-01', false],
    ['2026-11-02', false],
  ])('%s: före brytdatum = %s', (day, expected) => {
    expect(bankdagForeBrytdatum(new Date(day), cutover)).toBe(expected)
  })
  it('gissar ingen gräns när organisationen saknar brytdatum', () => {
    expect(bankdagForeBrytdatum(new Date('2000-01-01'), null)).toBe(false)
  })
  it('förklarar vilken bankdag och vilket brytdatum som stoppar betalningen', () => {
    const text = bankdagForeBrytdatumSkal(new Date('2026-10-31'), cutover)
    expect(text).toContain('2026-10-31')
    expect(text).toContain('2026-11-01')
    expect(text).toContain('Bankraden finns kvar')
  })
})
