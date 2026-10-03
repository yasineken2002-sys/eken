/**
 * G7/G8 (FORTNOX-100): BgMax enligt Bankgirot, "Bankgiro Inbetalningar – Teknisk manual",
 * oktober 2023. Posterna nedan byggs ur manualens positionstabeller — inte ur parsern.
 */
import { tolkaBgMax } from './bgmax-parse'

const vb = (s: string, n: number) => s.padEnd(n, ' ').slice(0, n)
const hb = (s: string, n: number) => s.padStart(n, ' ').slice(-n)
const h0 = (s: string | number, n: number) => String(s).padStart(n, '0').slice(-n)
const tk01 = () => '01' + vb('BGMAX', 20) + '01' + '20261201080000000000' + 'T' + ' '.repeat(35)
// Tabell 3: 3–12 mottagarbankgiro, 13–22 plusgiro/blankt, 23–25 valuta.
const tk05 = () => '05' + h0('56781230', 10) + ' '.repeat(10) + 'SEK' + ' '.repeat(55)
// Tabell 4/8: 3–12 avsändarbg, 13–37 referens (hb), 38–55 belopp öre, 56 refkod, 57 kanal, 58–69 löpnr, 70 bild (71 avdragskod).
const post = (tk: '20' | '21', o: { bg?: string; ref: string; ore: number; lopnr: number }) =>
  tk +
  h0(o.bg ?? '0', 10) +
  hb(o.ref, 25) +
  h0(o.ore, 18) +
  '2' +
  '1' +
  h0(o.lopnr, 12) +
  '0' +
  (tk === '21' ? '0' + ' '.repeat(9) : ' '.repeat(10))
// Tabell 16: 3–37 bankkonto, 38–45 betalningsdag, 46–50 löpnr, 51–68 belopp, 69–71 valuta, 72–79 antal, 80 typ.
const tk15 = (dag: string, ore: number, antal: number) =>
  '15' + h0('1234000123456', 35) + dag + h0(1, 5) + h0(ore, 18) + 'SEK' + h0(antal, 8) + ' '
const tk70 = (bet: number, avd: number, ins: number) =>
  '70' + h0(bet, 8) + h0(avd, 8) + h0(0, 8) + h0(ins, 8) + ' '.repeat(46)
const fil = (...r: string[]) => {
  for (const x of r) expect(x).toHaveLength(80)
  return r.join('\r\n') + '\r\n'
}

describe('tolkaBgMax — Bankgirots manual okt 2023', () => {
  it('G7: betalningsdagen kommer ur TK15 och gäller avsnittets alla betalningar; TK05 bär inget datum', () => {
    const t = tolkaBgMax(
      fil(
        tk01(),
        tk05(),
        post('20', { ref: '00000000019', ore: 603700, lopnr: 1 }),
        post('20', { ref: '00000000028', ore: 607400, lopnr: 2 }),
        tk15('20261102', 1211100, 2),
        tk05(),
        post('20', { ref: '00000000037', ore: 611100, lopnr: 3 }),
        tk15('20261130', 611100, 1),
        tk70(3, 0, 2),
      ),
    )
    expect(t.fel).toEqual([])
    expect(
      t.avsnitt.map((a) => [
        a.betalningsdag?.toISOString().slice(0, 10),
        a.betalningar.map((p) => [p.referens, p.beloppOre]),
      ]),
    ).toEqual([
      [
        '2026-11-02',
        [
          ['00000000019', 603700],
          ['00000000028', 607400],
        ],
      ],
      ['2026-11-30', [['00000000037', 611100]]],
    ])
  })

  it('G8: avdrag (TK21) blir aldrig en inbetalning; betalarens poster stoppas synligt med belopp och referens', () => {
    const t = tolkaBgMax(
      fil(
        tk01(),
        tk05(),
        post('20', { ref: '00000000019', ore: 603700, lopnr: 1 }),
        post('20', { bg: '0051234567', ref: '00000000846', ore: 920800, lopnr: 2 }),
        post('21', { bg: '0051234567', ref: 'KREDIT-77', ore: 10000, lopnr: 3 }),
        tk15('20261102', 603700 + 920800 - 10000, 3),
        tk70(2, 1, 1),
      ),
    )
    expect(t.avsnitt).toHaveLength(1)
    expect(t.avsnitt[0]!.betalningar.map((p) => p.referens)).toEqual(['00000000019'])
    expect(t.fel).toHaveLength(1)
    expect(t.fel[0]).toMatch(
      /bankgiro 0051234567 har 1 betalning\(ar\) på 9208,00 kr och 1 avdrag \(TK21\) på 100,00 kr \(referens KREDIT-77\)/,
    )
  })

  it('G8: avdrag utan känd betalare (avsändarbankgiro 0) stoppar hela avsnittet — ingen gissad koppling', () => {
    const t = tolkaBgMax(
      fil(
        tk01(),
        tk05(),
        post('20', { ref: '00000000019', ore: 603700, lopnr: 1 }),
        post('20', { ref: '00000000846', ore: 920800, lopnr: 2 }),
        post('21', { ref: 'KREDIT-77', ore: 10000, lopnr: 3 }),
        tk15('20261102', 603700 + 920800 - 10000, 3),
        tk70(2, 1, 1),
      ),
    )
    expect(t.avsnitt).toEqual([])
    expect(t.fel[0]).toMatch(
      /avdrag \(TK21\) utan känd betalare.*Hela avsnittet \(insättning 15145,00 kr\) importeras inte/,
    )
  })

  it('TK15 som inte stämmer med avsnittet (belopp eller antal) stoppar avsnittet', () => {
    for (const [ore, antal] of [
      [603701, 1],
      [603700, 2],
    ] as const) {
      const t = tolkaBgMax(
        fil(
          tk01(),
          tk05(),
          post('20', { ref: '00000000019', ore: 603700, lopnr: 1 }),
          tk15('20261102', ore, antal),
          tk70(1, 0, 1),
        ),
      )
      expect(t.avsnitt).toEqual([])
      expect(t.fel[0]).toMatch(/insättningsposten anger .* avsnittet importeras inte/)
    }
  })

  it('avsnitt utan TK15, ogiltig betalningsdag och oläsbar post stoppar avsnittet; okända posttyper ignoreras', () => {
    const utanTk15 = tolkaBgMax(
      fil(tk01(), tk05(), post('20', { ref: '00000000019', ore: 603700, lopnr: 1 }), tk70(1, 0, 0)),
    )
    expect(utanTk15.avsnitt).toEqual([])
    expect(utanTk15.fel[0]).toMatch(/saknar insättningspost \(TK15\)/)
    const felDag = tolkaBgMax(
      fil(
        tk01(),
        tk05(),
        post('20', { ref: '00000000019', ore: 603700, lopnr: 1 }),
        tk15('20261131', 603700, 1),
        tk70(1, 0, 1),
      ),
    )
    expect(felDag.avsnitt).toEqual([])
    expect(felDag.fel[0]).toMatch(/ingen giltig betalningsdag/)
    const oläsbar = post('20', { ref: '00000000019', ore: 0, lopnr: 1 })
    const t = tolkaBgMax(
      fil(
        tk01(),
        tk05(),
        oläsbar,
        ('25' + 'Fritext').padEnd(80, ' '),
        tk15('20261102', 0, 1),
        tk70(1, 0, 1),
      ),
    )
    expect(t.avsnitt).toEqual([])
    expect(t.fel.join('\n')).toMatch(/ogiltigt belopp[\s\S]*oläsbara poster/)
  })
})

describe('tolkaBgMax — filens ram, valuta och extra referenser (PARSER-006)', () => {
  const tk70x = (bet: number, avd: number, extra: number, ins: number) =>
    '70' + h0(bet, 8) + h0(avd, 8) + h0(extra, 8) + h0(ins, 8) + ' '.repeat(46)
  const p1 = () => post('20', { ref: '00000000019', ore: 603700, lopnr: 1 })
  const t15 = () => tk15('20261102', 603700, 1)
  const hel = tolkaBgMax(fil(tk01(), tk05(), p1(), t15(), tk70(1, 0, 1)))
  // Extra referensnummerpost (tabell 10): som TK20, transaktionskod 22 (positiv) eller 23 (avdrag).
  const extra = (tk: '22' | '23', o: { bg?: string; ref: string; ore: number; lopnr: number }) =>
    tk +
    h0(o.bg ?? '0', 10) +
    hb(o.ref, 25) +
    h0(o.ore, 18) +
    '2' +
    '1' +
    h0(o.lopnr, 12) +
    '0' +
    ' '.repeat(10)

  it('positiv kontroll: en korrekt fil importerar betalningen utan fel och utan stopp', () => {
    expect(hel.fel).toEqual([])
    expect(hel.stopp).toEqual([])
    expect(hel.avsnitt[0]!.betalningar).toHaveLength(1)
  })

  it.each([
    ['utan slutpost (avklippt)', () => [tk01(), tk05(), p1(), t15()], /saknar slutpost \(TK70\)/],
    [
      'slutpostens antal stämmer inte',
      () => [tk01(), tk05(), p1(), t15(), tk70(2, 0, 1)],
      /Slutposten anger 2\/0\/0\/1 men filen innehåller 1\/0\/0\/1/,
    ],
    ['utan startpost', () => [tk05(), p1(), t15(), tk70(1, 0, 1)], /saknar startpost \(TK01\)/],
    [
      'fel layout',
      () => [tk01().replace('BGMAX', 'XXXXX'), tk05(), p1(), t15(), tk70(1, 0, 1)],
      /layout "XXXXX".*bara BGMAX/,
    ],
    [
      'två slutposter',
      () => [tk01(), tk05(), p1(), t15(), tk70(1, 0, 1), tk70(1, 0, 1)],
      /fler än en startpost eller slutpost/,
    ],
  ])('%s → hela filen stoppas synligt, inget importeras', (_namn, rader, fel) => {
    const t = tolkaBgMax(fil(...rader()))
    expect(t.avsnitt).toEqual([])
    expect(t.fel).toHaveLength(1)
    expect(t.fel[0]).toMatch(fel)
    expect(t.fel[0]).toMatch(/Hela filen importeras inte/)
    expect(t.stopp.map((s) => [s.omfattning, s.skäl, s.dag, s.beloppOre])).toEqual([
      ['FIL', 'FILRAM', null, null],
    ])
  })

  it.each([
    ['EUR i båda', 'EUR', 'EUR'],
    ['motsägande valuta', 'SEK', 'EUR'],
  ])('valuta: %s → avsnittet stoppas, ingen växling', (_namn, v05, v15) => {
    const t = tolkaBgMax(
      fil(
        tk01(),
        tk05().replace('SEK', v05),
        p1(),
        t15().slice(0, 68) + v15 + t15().slice(71),
        tk70(1, 0, 1),
      ),
    )
    expect(t.avsnitt).toEqual([])
    expect(t.fel[0]).toMatch(/bara SEK stöds och ingen växling görs/)
    expect(t.stopp.map((s) => s.dag?.toISOString().slice(0, 10))).toEqual(['2026-11-02'])
  })

  it.each(['22', '23'] as const)(
    'TK%s: betalningen med extra referensnummer stoppas synligt; övriga i avsnittet importeras',
    (tk) => {
      const t = tolkaBgMax(
        fil(
          tk01(),
          tk05(),
          p1(),
          post('20', { bg: '0051234567', ref: '00000000028', ore: 1500000, lopnr: 2 }),
          extra(tk, { bg: '0051234567', ref: '00000000037', ore: 700000, lopnr: 2 }),
          tk15('20261102', 603700 + 1500000, 2),
          tk70x(2, 0, 1, 1),
        ),
      )
      expect(t.avsnitt[0]!.betalningar.map((p) => p.referens)).toEqual(['00000000019'])
      expect(t.fel).toHaveLength(1)
      expect(t.fel[0]).toMatch(
        new RegExp(
          `15000,00 kr \\(referens 00000000028, löpnummer 000000000002\\) har extra referensnummer \\(TK${tk}\\)`,
        ),
      )
      expect(t.stopp.map((s) => s.dag?.toISOString().slice(0, 10))).toEqual(['2026-11-02'])
    },
  )

  it('extra referensnummerpost utan matchande betalning stoppar avsnittet', () => {
    const t = tolkaBgMax(
      fil(
        tk01(),
        tk05(),
        p1(),
        extra('22', { bg: '0051234567', ref: '00000000037', ore: 700000, lopnr: 99 }),
        t15(),
        tk70x(1, 0, 1, 1),
      ),
    )
    expect(t.avsnitt).toEqual([])
    expect(t.fel[0]).toMatch(/hör inte till någon betalning/)
  })

  it('avdrag (TK21) med känd betalare ger stopp på betalningsdagen', () => {
    const t = tolkaBgMax(
      fil(
        tk01(),
        tk05(),
        p1(),
        post('20', { bg: '0051234567', ref: '00000000846', ore: 920800, lopnr: 2 }),
        post('21', { bg: '0051234567', ref: 'KREDIT-77', ore: 10000, lopnr: 3 }),
        tk15('20261102', 603700 + 920800 - 10000, 3),
        tk70(2, 1, 1),
      ),
    )
    expect(t.stopp.map((s) => s.dag?.toISOString().slice(0, 10))).toEqual(['2026-11-02'])
    // IMPORTSTOPP-009: betalarens NETTO (TK20 − TK21) och bankgiro följer med; inget uppfunnet.
    expect(t.stopp.map((s) => [s.omfattning, s.skäl, s.beloppOre, s.avsandarBankgiro])).toEqual([
      ['BETALARE', 'AVDRAG_BETALARE', 920800 - 10000, '0051234567'],
    ])
  })

  it('stoppens nycklar är deterministiska: samma fil ger samma nycklar (replay)', () => {
    const f = fil(
      tk01(),
      tk05(),
      post('20', { bg: '0051234567', ref: '00000000846', ore: 920800, lopnr: 2 }),
      post('21', { bg: '0051234567', ref: 'KREDIT-77', ore: 10000, lopnr: 3 }),
      tk15('20261102', 920800 - 10000, 2),
      tk05().replace('SEK', 'EUR'),
      p1(),
      tk15('20261103', 603700, 1).slice(0, 68) + 'EUR' + tk15('20261103', 603700, 1).slice(71),
      tk70(2, 1, 2),
    )
    const a = tolkaBgMax(f).stopp.map((s) => s.nyckel)
    expect(a).toEqual(tolkaBgMax(f).stopp.map((s) => s.nyckel))
    expect(new Set(a).size).toBe(2)
    // Valutastoppet: beloppet är i fel valuta → okänt, inte ett SEK-belopp.
    expect(tolkaBgMax(f).stopp.find((s) => s.skäl === 'VALUTA')?.beloppOre).toBeNull()
  })
})
