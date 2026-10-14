import { compareEvidence, type EvidenceImport } from './opening-evidence-compare'
import {
  SOURCE_HEADER,
  MAPPING_HEADER,
  parseSource,
  parseMapping,
  strictCsv,
  canonical,
  hash,
  assertUpload,
  MAX_EVIDENCE_BYTES,
} from './opening-evidence-format'
import { SOURCE_191 } from './opening-evidence.fixtures'

const mappingText =
  MAPPING_HEADER +
  '\nSYNTHETIC_191;A;K-1;tenantA;leaseA;contrakt\nSYNTHETIC_191;B;K-2;tenantB;leaseB;contrakt'
const source = () => parseSource(SOURCE_191, 'SYNTHETIC_191', '2026-11-01')
const mapping = () => parseMapping(mappingText).map((m) => ({ ...m, valid: true }))
const imports = (): EvidenceImport[] => [
  {
    row: 1,
    document: 'DOC-1',
    kind: 'RECEIVABLE',
    tenantId: 'tenantA',
    leaseId: 'leaseA',
    original: 600000,
    paid: 0,
    credited: 0,
    open: 600000,
    period: '2026-10',
    due: '2026-10-31',
    received: '',
    resolutionOk: true,
  },
  {
    row: 2,
    document: 'DOC-2',
    kind: 'RECEIVABLE',
    tenantId: 'tenantB',
    leaseId: 'leaseB',
    original: 400000,
    paid: 0,
    credited: 0,
    open: 400000,
    period: '2026-10',
    due: '2026-10-31',
    received: '',
    resolutionOk: true,
  },
]
const compare = (s = source(), m = mapping(), i = imports()) =>
  compareEvidence(s, m, i, 'SYNTHETIC_191')

describe('207 oberoende heltalsfacit och strikt format', () => {
  it('E1: korrekt191-källa har noll differens', () =>
    expect(compare()).toMatchObject({
      comparisonStatus: 'OK',
      counts: { matchade: 2, avvikelser: 0, stopp: 0 },
    }))
  it('E2: omkastade kunder ger två dokumentfel och A−200000/B+200000 trots total0', () => {
    const r = imports()
    ;[r[0]!.tenantId, r[1]!.tenantId] = [r[1]!.tenantId, r[0]!.tenantId]
    ;[r[0]!.leaseId, r[1]!.leaseId] = [r[1]!.leaseId, r[0]!.leaseId]
    const result = compare(source(), mapping(), r)
    expect(result.counts.avvikelser).toBe(2)
    expect(
      result.avvikelser
        .filter((d) => d.niva === 'KUND_AVTAL')
        .map((d) => [d.kund, Number(d.import) - Number(d.kalla)])
        .sort(),
    ).toEqual([
      ['A', -200000],
      ['B', 200000],
    ])
  })
  it.each(['source', 'import'] as const)('E3: dubblett i %s stoppas före summering', (side) => {
    const s = source(),
      i = imports()
    if (side === 'source') s.push(s[0]!)
    else i.push(i[0]!)
    expect(compare(s, mapping(), i)).toMatchObject({ comparisonStatus: 'STOPP', avvikelser: [] })
  })
  it.each(['source', 'import'] as const)('E4: saknat/extra dokument i %s', (side) => {
    const r = compare(
      side === 'source' ? source().slice(0, 1) : source(),
      mapping(),
      side === 'import' ? imports().slice(0, 1) : imports(),
    )
    expect(r.stopp.some((s) => /SAKNAT_DOKUMENT|EXTRA_DOKUMENT/u.test(s.kod))).toBe(true)
  })
  it.each(['', '-1', '0.1', '9999999999999'])(
    'E5/E19: ogiltigt monetärt värde %s är inte noll',
    (value) => {
      const text = SOURCE_191.replace(';600000;0;0;600000;', `;600000;${value};0;600000;`)
      expect(compare(parseSource(text, 'SYNTHETIC_191', '2026-11-01')).comparisonStatus).toBe(
        'STOPP',
      )
    },
  )
  it('E5b/V1: samma original och öppet men fel fördelning betalt/krediterat', () => {
    const s = source(),
      i = imports()
    Object.assign(s[0]!, { original: 1000000, paid: 250000, credited: 150000 })
    Object.assign(i[0]!, { original: 1000000, paid: 150000, credited: 250000 })
    const r = compare(s, mapping(), i)
    expect(r.counts.avvikelser).toBe(1)
    expect(r.avvikelser.map((d) => d.falt).sort()).toEqual(['credited', 'paid'])
  })
  it('E6/E7: främmande/okänd/tvetydig mappning stoppas utan främmande id i skälet', () => {
    const m = mapping()
    m[0]!.valid = false
    m[0]!.tenantId = 'FOREIGN-SECRET-ID'
    const r = compare(source(), m)
    expect(r.comparisonStatus).toBe('STOPP')
    expect(JSON.stringify(r.stopp)).not.toContain('FOREIGN-SECRET-ID')
    expect(compare(source(), [mapping()[0]!, mapping()[0]!]).comparisonStatus).toBe('STOPP')
    const merged = mapping()
    merged[1]!.tenantId = merged[0]!.tenantId
    expect(compare(source(), merged).comparisonStatus).toBe('STOPP')
  })
  it('E16: null kedja är inte uttryckligt noll', () => {
    const i = imports()
    i[0]!.paid = null
    expect(
      compare(source(), mapping(), i).stopp.some(
        (s) => s.skal === 'Importen saknar betalt/krediterat för dokumentet',
      ),
    ).toBe(true)
  })
  it('E18: deposition kräver datum/referens och jämförs separat', () => {
    const text = SOURCE_HEADER + '\nSYNTHETIC_191;A;K-1;DEP-1;DEPOSIT;;;;0;0;120000;2026-02-01;'
    expect(parseSource(text, 'SYNTHETIC_191', '2026-11-01')[0]!.errors.join(' ')).toMatch(
      /mottagningsreferens/u,
    )
  })
  it.each([
    SOURCE_191.replace('kallforetag;', 'kund;'),
    SOURCE_191 + ';extra',
    SOURCE_191 + '\n',
    SOURCE_191.replace('DOC-1', '"DOC-1'),
    SOURCE_191.replace('DOC-1', 'DOC-"1'),
    SOURCE_191.replace('DOC-1', '\ud800'),
    SOURCE_191.replace('DOC-1', '\uFEFFDOC-1'),
    'https://example.invalid/source.csv',
  ])('E20: felaktig struktur eller kodning avvisas', (text) => {
    // A single final newline is legal; two end lines create an empty document row.
    const candidate = text === SOURCE_191 + '\n' ? text + '\n' : text
    expect(() => strictCsv(candidate, SOURCE_HEADER)).toThrow()
  })
  it('E20: bytegräns och radgräns är obligatoriska även utan DTO', () => {
    expect(() => assertUpload('å'.repeat(MAX_EVIDENCE_BYTES / 2), MAPPING_HEADER)).toThrow(/stort/u)
    expect(() =>
      strictCsv(SOURCE_HEADER + '\n' + ('x;'.repeat(12) + 'x\n').repeat(1001), SOURCE_HEADER),
    ).toThrow(/1000/u)
  })
  it('V2: gränsvärde och kundsumma är exakta bortom 32 bitar', () => {
    const s = source(),
      i = imports()
    s[0]!.original = s[0]!.open = 999999999999
    i[0]!.original = i[0]!.open = 999999999999
    expect(compare(s, mapping(), i).comparisonStatus).toBe('OK')
    const manyS = Array.from({ length: 1000 }, (_, n) => ({
      ...s[0]!,
      row: n + 1,
      document: 'M' + n,
    }))
    const manyI = manyS.map((v, n) => ({
      ...i[0]!,
      row: n + 1,
      document: v.document,
      open: i[0]!.open! - 1,
    }))
    const r = compare(manyS, [mapping()[0]!], manyI)
    expect(r.avvikelser.find((d) => d.niva === 'KUND_AVTAL')?.kalla).toBe('999999999999000')
  })
  it('V3: determinism, säkra nycklar och distinkta råbytes', () => {
    expect(canonical(compare(source().reverse(), mapping().reverse(), imports().reverse()))).toBe(
      canonical(compare()),
    )
    expect(hash(SOURCE_191)).not.toBe(hash(SOURCE_191 + '\n'))
    expect(parseSource(SOURCE_191 + '\n', 'SYNTHETIC_191', '2026-11-01')).toEqual(source())
    expect(canonical(['a;b', 'c'])).not.toBe(canonical(['a', 'b;c']))
  })
})
