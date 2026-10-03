import {
  kronorTillOre,
  tolkaForstaPeriodRegister,
  tolkaOpeningCsv,
  tolkaSpecifikation,
  delaCsv,
} from './opening-csv'
import { stamAv } from './opening-reconciliation'
import { periodForeBrytdatum, tolkaBrytdatum } from './cutover'
import { dagenForeBrytdatum, saldoUrLasning } from './opening-fortnox-balance'
import { registerHinder, tackningOk } from './first-period'

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
  it('S5-1/K011: gammalt format postId;belopp avvisas även med EXAKT rätt totalsumma (B-fallets 28 212 kr)', () => {
    // C2:s motexempel: summan förklarar differensen exakt, men posterna saknar identitet.
    const gammalt = tolkaSpecifikation('postId;belopp\n1;28212')
    expect(gammalt).toMatchObject({
      ok: false,
      error: expect.stringMatching(/identitet per post är obligatorisk/),
    })
    const tvaPoster = tolkaSpecifikation('postId;belopp\nG91;10000\nG92;18212')
    expect(tvaPoster).toMatchObject({ ok: false })
  })
  it('S5-1: kvittade eller negativa poster avvisas; dubbla (motpart, dokument) avvisas', () => {
    const H = 'postId;motpart;dokument;dokumentdatum;forfallodag;belopp'
    expect(
      tolkaSpecifikation(
        `${H}\nA;K1 Kund;F1;2025-12-01;2025-12-31;30000\nB;K2 Kund;F2;2025-12-01;2025-12-31;-1788`,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/kvittade eller negativa/) })
    expect(
      tolkaSpecifikation(
        `${H}\nA;K1 Kund;F1;2025-12-01;2025-12-31;100\nB;K1 Kund;F1;2025-12-02;2025-12-31;100`,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/samma motpart och dokument/) })
    expect(tolkaSpecifikation(`${H}\nA;K1 Kund;;2025-12-01;2025-12-31;100`)).toMatchObject({
      ok: false,
    })
  })
  it('S5-1: fullständig specifikation → sha, antal och summa i öre', () => {
    const H = 'postId;motpart;dokument;dokumentdatum;forfallodag;belopp'
    const s = tolkaSpecifikation(
      `${H}\nG91;H91 Hyresgäst;F-91;2025-11-30;2025-12-31;10000\nG92;H92 Hyresgäst;F-92;2025-11-30;2025-12-31;18212`,
    )
    expect(s).toMatchObject({ ok: true, spec: { antal: 2, summaOre: 2821200 } })
  })
  it('ACK-009: belopp över Decimal(12,2)-gränsen ger radfel, inte avrundning', () => {
    const fil = [HUVUD, 'A;FORDRAN;111;K;;;2025;10;2025-10-31;10000000000;10000000000;'].join('\n')
    const r = tolkaOpeningCsv(fil)
    expect(r.ok && r.rows[0]!.errors.join(' ')).toMatch(/överstiger gränsen 9 999 999 999,99 kr/)
    const ok = tolkaOpeningCsv(
      [HUVUD, 'A;FORDRAN;111;K;;;2025;10;2025-10-31;9999999999,99;9999999999,99;'].join('\n'),
    )
    expect(ok.ok && ok.rows[0]!.errors).toEqual([])
  })
  it('KUNDSTART-009: register för första perioden — strikt tolkning; bara rubrik = inga poster', () => {
    const H = 'radId;hyresgast;avtal;periodAr;periodManad;dokument;fakturerat;betalt'
    expect(tolkaForstaPeriodRegister(H)).toMatchObject({ ok: true, poster: [] })
    expect(tolkaForstaPeriodRegister(`${H}\n1;111;K-1;2026;11;F-1;6000;6000`)).toMatchObject({
      ok: true,
      poster: [{ faktureratOre: 600000, betaltOre: 600000 }],
    })
    expect(tolkaForstaPeriodRegister(`${H}\n1;111;K-1;2026;11;F-1;0;0`)).toMatchObject({
      ok: false,
    })
    expect(tolkaForstaPeriodRegister('radId;hyresgast')).toMatchObject({ ok: false })
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
    system: 'Gamla systemet',
    ansvarig: 'Ekonomichef',
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

describe('KUNDSTART: Fortnox-saldo per brytdatum (BYGGLEDARE-004 bevakning)', () => {
  const conn = {
    id: 'c',
    fortnoxDatabaseNumber: 1,
    connectedAt: new Date('2026-01-01'),
    status: 'ACTIVE' as const,
  }
  const run = (from: string, to: string, ib: Record<string, number | null>, rows: unknown[]) => ({
    id: 'r',
    organizationId: 'o',
    connectionId: 'c',
    fortnoxDatabaseNumber: 1,
    status: 'COMPLETE' as const,
    financialYearStart: new Date(`${from}T00:00:00Z`),
    periodFrom: new Date(`${from}T00:00:00Z`),
    periodTo: new Date(`${to}T00:00:00Z`),
    costAccounts: [1510, 2890],
    startedAt: new Date('2026-12-01'),
    completedAt: new Date('2026-12-01'),
    summary: { balanceBroughtForwardOre: ib },
    rows: { rows, references: [] },
  })
  it('brytdatum 1 januari: läsningen gäller FÖREGÅENDE år t.o.m. 31 december', () => {
    const b = new Date(Date.UTC(2027, 0, 1))
    expect(dagenForeBrytdatum(b)).toBe('2026-12-31')
    const r = saldoUrLasning(
      run('2026-01-01', '2026-12-31', { '1510': 100000, '2890': -50000 }, [
        { account: 1510, amountOre: 23400, bucket: 'UNALLOCATED' },
        { account: 2890, amountOre: -1000, bucket: 'UNALLOCATED' },
      ]) as never,
      conn as never,
      b,
    )
    expect(r).toMatchObject({ ok: true, saldo: { saldo1510Ore: 123400, saldo2890Ore: 51000 } })
  })
  it('läsning av fel år, saknad IB eller fel slutdag avvisas med skäl', () => {
    const b = new Date(Date.UTC(2027, 0, 1))
    expect(
      saldoUrLasning(
        run('2027-01-01', '2027-01-31', { '1510': 0, '2890': 0 }, []) as never,
        conn as never,
        b,
      ),
    ).toMatchObject({ ok: false })
    expect(
      saldoUrLasning(
        run('2026-01-01', '2026-12-31', { '1510': null, '2890': 0 }, []) as never,
        conn as never,
        b,
      ),
    ).toMatchObject({ ok: false, skal: expect.stringMatching(/aldrig som 0/) })
  })
})

describe('KUNDSTART-009: första periodens blockerare', () => {
  const b = new Date(Date.UTC(2026, 10, 1))
  it('saknat register blockerar; register med poster blockerar; tomt täckt register släpper', () => {
    expect(registerHinder(null, b)).toMatch(/Underlag för första perioden saknas/)
    expect(registerHinder({ sha256: 'x'.repeat(64), antal: 2, filnamn: 'r.csv' }, b)).toMatch(
      /2 fakturerade eller betalda poster/,
    )
    expect(registerHinder({ sha256: 'x'.repeat(64), antal: 0, filnamn: 'r.csv' }, b)).toBeNull()
  })
  it('täckningen ska börja på brytdatum och räcka hela första månaden', () => {
    expect(tackningOk('2026-11-01', '2026-11-30', b)).toBeNull()
    expect(tackningOk('2026-11-01', '2026-11-29', b)).toMatch(/minst till 2026-11-30/)
    expect(tackningOk('2026-10-01', '2026-12-31', b)).toMatch(/börja på brytdatum/)
  })
})
