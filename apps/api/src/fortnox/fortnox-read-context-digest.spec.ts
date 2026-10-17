import { createHash } from 'node:crypto'
import {
  checkpointDigest,
  CheckpointContextSchema,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'
import { CheckpointContextDigest } from './fortnox-read-context-digest'

type Context = ReturnType<typeof CheckpointContextSchema.parse>
const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function context(mappings: number, exports: number): Context {
  return {
    version: 1,
    input: INPUT,
    mappings: Array.from({ length: mappings }, (_, i) => ({
      type: i % 2 ? 'PROJECT' : 'COST_CENTER',
      code: `${i}`,
      propertyId: `synthetic-${i}`,
      propertyName: i % 2 ? 'Ågården' : '',
    })),
    ownExports: Array.from({ length: exports }, (_, i) => ({
      voucher: `1|L|${i + 1}`,
      journalEntryId: `synthetic-journal-${i}`,
      revision: [0, -7, null][i % 3]!,
      perMal: [
        { account: 5171, sources: [5170, 5160, 5170] },
        { account: 1940, sources: [1930] },
      ],
    })),
  }
}

function streamed(source: Context, size = 100): string {
  const digest = new CheckpointContextDigest(source.input)
  for (let i = 0; i < source.mappings.length; i += size)
    digest.append('MAPPINGS', source.mappings.slice(i, i + size))
  for (let i = 0; i < source.ownExports.length; i += size)
    digest.append('OWN_EXPORTS', source.ownExports.slice(i, i + size))
  return digest.digest()
}

describe('Sidvis källdigest har exakt samma kanoniska JSON som fryst v1-kontext', () => {
  it('tomma samlingar matchar ett handskrivet bytefacit utan injicerade årsgränser', () => {
    const literal =
      '{"input":{"costAccounts":[5170],"financialYearId":1,"periodFrom":"2026-10-01","periodTo":"2026-10-31"},"mappings":[],"ownExports":[],"version":1}'
    expect(streamed(context(0, 0))).toBe(sha256(literal))
    expect(checkpointDigest(context(0, 0))).toBe(sha256(literal))
  })

  it.each([
    [0, 101],
    [101, 0],
    [101, 201],
  ])('%i mappningar och %i exporter ger samma digest vid olika sidgränser', (mappings, exports) => {
    const source = context(mappings!, exports!)
    const expected = checkpointDigest(source)
    for (const size of [1, 73, 100]) expect(streamed(source, size)).toBe(expected)
  })

  it('handskrivet Unicode-/escape-facit bevarar tom sträng, noll, null och ordning', () => {
    const source: Context = {
      version: 1,
      input: INPUT,
      mappings: [
        { type: 'PROJECT', code: '10', propertyId: 'p', propertyName: 'Å\n"\\😀' },
        { type: 'COST_CENTER', code: '2', propertyId: 'q', propertyName: 'A\u030A' },
        { type: 'PROJECT', code: '1', propertyId: 'r', propertyName: '' },
      ],
      ownExports: [
        {
          voucher: '1|L|2',
          journalEntryId: 'j',
          revision: 0,
          perMal: [{ account: 5171, sources: [5170, 5160] }],
        },
        { voucher: '1|L|1', journalEntryId: 'k', revision: null, perMal: [] },
      ],
    }
    const literal = String.raw`{"input":{"costAccounts":[5170],"financialYearId":1,"periodFrom":"2026-10-01","periodTo":"2026-10-31"},"mappings":[{"code":"10","propertyId":"p","propertyName":"Å\n\"\\😀","type":"PROJECT"},{"code":"2","propertyId":"q","propertyName":"Å","type":"COST_CENTER"},{"code":"1","propertyId":"r","propertyName":"","type":"PROJECT"}],"ownExports":[{"journalEntryId":"j","perMal":[{"account":5171,"sources":[5170,5160]}],"revision":0,"voucher":"1|L|2"},{"journalEntryId":"k","perMal":[],"revision":null,"voucher":"1|L|1"}],"version":1}`
    expect(streamed(source, 1)).toBe(sha256(literal))
    expect(checkpointDigest(source)).toBe(sha256(literal))
    const reorderedKeys = JSON.parse(literal) as Context
    expect(streamed(reorderedKeys)).toBe(sha256(literal))
    expect(streamed({ ...source, mappings: [...source.mappings].reverse() })).not.toBe(
      sha256(literal),
    )
    expect(streamed({ ...source, ownExports: [...source.ownExports].reverse() })).not.toBe(
      sha256(literal),
    )
    const changed = structuredClone(source)
    changed.ownExports[0]!.revision = null
    expect(streamed(changed)).not.toBe(sha256(literal))
    changed.mappings[1]!.propertyName = 'Å'
    expect(streamed(changed)).toBe(checkpointDigest(changed))
  })

  it('bevarar valfria årsgränser och redan fryst kontoordning utan deduplicering', () => {
    const source = context(1, 1)
    source.input = {
      ...INPUT,
      financialYearStart: '2026-01-01',
      financialYearEnd: '2026-12-31',
      costAccounts: [5170, 5160, 5170],
    }
    expect(streamed(source)).toBe(checkpointDigest(source))
    expect(streamed(source)).not.toBe(
      checkpointDigest({ ...source, input: { ...source.input, costAccounts: [5160, 5170] } }),
    )
  })

  it('bevarar dubletter på var sida om gränsen 100/101', () => {
    const source = context(101, 101)
    source.mappings[100] = structuredClone(source.mappings[99]!)
    source.ownExports[100] = structuredClone(source.ownExports[99]!)
    expect(streamed(source)).toBe(checkpointDigest(source))
    expect(streamed(source)).not.toBe(
      checkpointDigest({ ...source, ownExports: source.ownExports.slice(0, 100) }),
    )
  })

  it('skiljer en uttrycklig undefined-årsgräns från en utelämnad enligt befintlig stable', () => {
    const source = context(0, 0)
    source.input = { ...INPUT, financialYearStart: undefined }
    expect(streamed(source)).toBe(checkpointDigest(source))
    expect(streamed(source)).not.toBe(streamed(context(0, 0)))
  })

  it('användarens indata kan ändras efter append utan att redan hashade poster ändras', () => {
    const source = context(1, 1)
    const expected = checkpointDigest(source)
    const digest = new CheckpointContextDigest(source.input)
    digest.append('MAPPINGS', source.mappings)
    digest.append('OWN_EXPORTS', source.ownExports)
    source.mappings[0]!.propertyName = 'ändrat'
    source.ownExports[0]!.perMal[0]!.sources.reverse()
    expect(digest.digest()).toBe(expected)
  })

  it.each([
    { kind: 'MAPPINGS' as const, items: context(101, 0).mappings },
    { kind: 'OWN_EXPORTS' as const, items: context(0, 101).ownExports },
    { kind: 'MAPPINGS' as const, items: [{ ...context(1, 0).mappings[0], extra: true }] },
    { kind: 'OWN_EXPORTS' as const, items: [{ ...context(0, 1).ownExports[0], revision: '0' }] },
    { kind: 'OWN_EXPORTS' as const, items: null },
    { kind: 'UNKNOWN' as 'MAPPINGS', items: [] },
  ])('ogiltig sida $kind stänger instansen utan ett användbart delresultat', ({ kind, items }) => {
    const digest = new CheckpointContextDigest(INPUT)
    let failure: unknown
    try {
      digest.append(kind, items)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(() => digest.digest()).toThrow(failure as Error)
    expect(() => digest.append('MAPPINGS', [])).toThrow(failure as Error)
  })

  it('nekar mappningar efter exportfasen även när exportlistan är tom', () => {
    const digest = new CheckpointContextDigest(INPUT)
    digest.append('OWN_EXPORTS', [])
    expect(() => digest.append('MAPPINGS', [])).toThrow()
    expect(() => digest.digest()).toThrow()
  })

  it('tomma sidlistor ändrar inte bytes; en färdig instans får inte återanvändas', () => {
    const digest = new CheckpointContextDigest(INPUT)
    digest.append('MAPPINGS', [])
    digest.append('OWN_EXPORTS', [])
    expect(digest.digest()).toBe(checkpointDigest(context(0, 0)))
    expect(() => digest.digest()).toThrow()
    expect(() => digest.append('OWN_EXPORTS', [])).toThrow()
  })

  it('validerar input med befintligt strikt schema', () => {
    expect(() => new CheckpointContextDigest({ ...INPUT, extra: true })).toThrow()
    expect(() => new CheckpointContextDigest({ ...INPUT, costAccounts: [] })).toThrow()
    expect(() => new CheckpointContextDigest({ ...INPUT, financialYearId: '1' })).toThrow()
  })
})
