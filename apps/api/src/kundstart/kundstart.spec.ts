import { kronorTillOre, tolkaOpeningCsv, tolkaSpecifikation, delaCsv } from './opening-csv'
import { stamAv } from './opening-reconciliation'
import { periodForeBrytdatum, tolkaBrytdatum } from './cutover'

const HUVUD =
  'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum'

describe('KUNDSTART: brytdatum (C2)', () => {
  it('bara den 1:a godtas; mitt i perioden avvisas och avrundas inte', () => {
    expect(tolkaBrytdatum('2026-11-01')).toMatchObject({ ok: true })
    const r = tolkaBrytdatum('2026-11-15')
    expect(r.ok).toBe(false)
    expect(tolkaBrytdatum('2026-02-30').ok).toBe(false)
    expect(tolkaBrytdatum('2026-11').ok).toBe(false)
  })
  it('gränsen jämförs som heltal (år, månad) — före, vid och efter', () => {
    const b = new Date(Date.UTC(2026, 10, 1))
    expect(periodForeBrytdatum(b, 2026, 10)).toBe(true)
    expect(periodForeBrytdatum(b, 2026, 11)).toBe(false)
    expect(periodForeBrytdatum(b, 2026, 12)).toBe(false)
    expect(periodForeBrytdatum(b, 2025, 12)).toBe(true)
    expect(periodForeBrytdatum(null, 1999, 1)).toBe(false)
  })
})

describe('KUNDSTART: belopp och CSV', () => {
  it('kronor → öre exakt; fler än två decimaler avvisas i stället för att avrundas', () => {
    expect(kronorTillOre('1 234,50')).toBe(123450)
    expect(kronorTillOre('6000')).toBe(600000)
    expect(kronorTillOre('0.1')).toBe(10)
    expect(kronorTillOre('1,234')).toBeNull()
    expect(kronorTillOre('abc')).toBeNull()
  })
  it('citattecken och semikolon i fält', () => {
    expect(delaCsv('a;"b;c";"d""e"\n1;2;3')).toEqual([
      ['a', 'b;c', 'd"e'],
      ['1', '2', '3'],
    ])
  })
  it('saknad kolumn ger fel; dubbla radId och typfel blir radfel; sha är deterministisk', () => {
    expect(tolkaOpeningCsv('radId;typ\nx;FORDRAN')).toMatchObject({ ok: false })
    const fil = [
      HUVUD,
      'A;FORDRAN;111;K;;;2026;10;2026-10-31;100;100;',
      'A;FORDRAN;111;K;;;2026;10;2026-10-31;100;100;',
      'B;KONSTIG;111;K;;;;;;100;100;',
      'C;DEPOSITION;111;K;;;2026;;;100;100;2026-01-01',
    ].join('\n')
    const r = tolkaOpeningCsv(fil)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows[1]!.errors.join()).toMatch(/förekommer två gånger/)
    expect(r.rows[2]!.errors.join()).toMatch(/FORDRAN eller DEPOSITION/)
    expect(r.rows[3]!.errors.join()).toMatch(/gäller bara FORDRAN/)
    const r2 = tolkaOpeningCsv(fil)
    expect(r2.ok && r2.sha256).toBe(r.sha256)
  })
  it('specifikation: sha, antal och summa i öre', () => {
    const s = tolkaSpecifikation('postId;belopp\nG91;10000\nG92;18212')
    expect(s).toMatchObject({ ok: true, spec: { antal: 2, summaOre: 2821200 } })
    expect(tolkaSpecifikation('postId;belopp\nG91;10\nG91;10')).toMatchObject({ ok: false })
  })
})

describe('KUNDSTART: startavstämning (A4 enligt BYGGLEDARE-002)', () => {
  const cutover = new Date(Date.UTC(2026, 10, 1))
  const spec = (summaOre: number) => ({
    sha256: 'f'.repeat(64),
    antal: 3,
    summaOre,
    beskrivning: 'Separat reskontra',
    filnamn: 'spec.csv',
    poster: [],
  })
  it('0 differens → AVSTAMD; saknat saldo → ingen status', () => {
    expect(
      stamAv({
        cutover,
        paketOre: { '1510': 5, '2890': 0 },
        fortnoxOre: { '1510': 5, '2890': 0 },
        spec: {},
      }).status,
    ).toBe('AVSTAMD')
    expect(
      stamAv({
        cutover,
        paketOre: { '1510': 5, '2890': 0 },
        fortnoxOre: { '1510': null, '2890': 0 },
        spec: {},
      }).status,
    ).toBeNull()
  })
  it('B-fallet 28 212: DIFFERENS utan specifikation, även med fel summa; AVGRÄNSAD bara exakt', () => {
    const bas = {
      cutover,
      paketOre: { '1510': 2821200, '2890': 0 },
      fortnoxOre: { '1510': 5642400, '2890': 0 },
    }
    expect(stamAv({ ...bas, spec: {} }).status).toBe('DIFFERENS')
    expect(stamAv({ ...bas, spec: { '1510': spec(2821100) } }).status).toBe('DIFFERENS')
    const ok = stamAv({ ...bas, spec: { '1510': spec(2821200) } })
    expect(ok.status).toBe('AVGRANSAD')
    expect(ok.konton[0]!.text).toMatch(/INTE avstämt i sin helhet/)
  })
  it('negativ differens (paketet säger mer än Fortnox) kan aldrig avgränsas', () => {
    expect(
      stamAv({
        cutover,
        paketOre: { '1510': 300, '2890': 0 },
        fortnoxOre: { '1510': 100, '2890': 0 },
        spec: { '1510': spec(-200) },
      }).status,
    ).toBe('DIFFERENS')
  })
})
