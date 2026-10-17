import { createHash } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { createLedgerAccumulator, LedgerAmountOverflow } from './fortnox-ledger-reducer'
import { Incomplete, type ValidatedLedgerVoucher } from './fortnox-ledger-validation'
import type { LedgerReadResult } from './fortnox-ledger'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import { enrichEvenoLedgerResult, type Egen } from './fortnox-read-provenance'
import type { VoucherManifestPage } from './fortnox-read-voucher-checkpoint'
import {
  appendReductionMappings,
  appendReductionOwnExports,
  buildReductionConfig,
  createFrozenReductionMaps,
  DetailReductionProof,
  finishReducedLedger,
  ManifestReductionProof,
} from './fortnox-read-reduction'

const hash = (literal: string) => createHash('sha256').update(literal).digest('hex')
const ONE =
  '{"date":"2026-10-01","headerDimensionPresent":false,"key":"1|L|1","reference":null,"rows":[{"account":5170,"costCenter":null,"creditOre":0,"debitOre":100,"index1":1,"project":null,"removed":false},{"account":2440,"costCenter":null,"creditOre":100,"debitOre":0,"index1":2,"project":null,"removed":false}]}'
const EMPTY_PAGE = '{"entries":[],"itemCount":0,"page":1,"totalPages":0,"totalResources":0}'
const EMPTY_DIGEST = hash(EMPTY_PAGE)
const emptyPage: VoucherManifestPage = {
  page: 1,
  totalPages: 0,
  totalResources: 0,
  itemCount: 0,
  entries: [],
  digest: EMPTY_DIGEST,
}
const one = (): ValidatedLedgerVoucher => JSON.parse(ONE) as ValidatedLedgerVoucher
const input: StartCheckpointInput = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const emptyCoverage = { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 }
const catalog: CheckpointCatalog = {
  version: 1,
  companyDatabaseNumber: 900001,
  financialYear: {
    id: 1,
    fromDate: '2026-01-01',
    toDate: '2026-12-31',
    accountingMethod: 'ACCRUAL',
  },
  accounts: [{ number: 5170, active: true, balanceBroughtForwardOre: -125 }],
  dimensions: [],
  coverage: { costCenters: emptyCoverage },
}
const LIMITATION =
  'Läsningen är en genomgång sida för sida, inte en låst ögonblicksbild: ändringar under läsningen och raderingar upptäcks inte alltid.'

describe('Fortnox intern reducer: bokstavliga strömbevis', () => {
  it('binder den verkliga tomma manifestsidan och den tomma detaljströmmen', () => {
    const manifest = new ManifestReductionProof({ pageCount: 1, totalPages: 0, totalResources: 0 })
    manifest.append(emptyPage)
    expect(manifest.finish()).toStrictEqual({
      digest: hash(
        '{"pages":[{"digest":"' +
          EMPTY_DIGEST +
          '","entries":[],"itemCount":0,"page":1,"totalPages":0,"totalResources":0}],"version":1}',
      ),
      pageCount: 1,
      itemsSeen: 0,
      keys: new Map(),
      duplicateWarnings: [],
    })
    const details = new DetailReductionProof(new Map())
    details.append([])
    expect(details.finish()).toStrictEqual({
      digest: hash('{"items":[],"version":1}'),
      count: 0,
      firstKey: null,
      lastKey: null,
    })
    expect(() => details.finish()).toThrow(ConflictException)
    expect(() => manifest.append(emptyPage)).toThrow(ConflictException)
  })

  it('låser hela enskilda normalformen med bokstavliga bytes', () => {
    const proof = new DetailReductionProof(new Map([['1|L|1', 'manifest']]))
    proof.append([one()])
    expect(proof.finish()).toStrictEqual({
      digest: hash('{"items":[' + ONE + '],"version":1}'),
      count: 1,
      firstKey: '1|L|1',
      lastKey: '1|L|1',
    })
  })

  it('bevarar tom sträng, citat, backslash och kombinerande Unicode utan normalisering', () => {
    const literal = ONE.replace(
      '"reference":null',
      String.raw`"reference":{"number":"Å\\\"é","type":""}`,
    )
    const item = JSON.parse(literal) as ValidatedLedgerVoucher
    const proof = new DetailReductionProof(new Map([[item.key, 'manifest']]))
    proof.append([item])
    expect(proof.finish().digest).toBe(hash('{"items":[' + literal + '],"version":1}'))
    expect(literal).not.toBe(literal.normalize('NFC'))
  })

  it.each([1, 100, 101])(
    'ger identiskt fullbevis när 101 detaljer delas i grupper om %i',
    (size) => {
      const keys = Array.from(
        { length: 101 },
        (_, index) => `1|L|${String(index + 1).padStart(3, '0')}`,
      )
      const literals = keys.map((key) => ONE.replace('1|L|1', key))
      const items = literals.map((literal) => JSON.parse(literal) as ValidatedLedgerVoucher)
      const proof = new DetailReductionProof(new Map(keys.map((key) => [key, 'manifest'])))
      for (let index = 0; index < items.length; index += size)
        proof.append(items.slice(index, index + size))
      proof.append([])
      expect(proof.finish()).toStrictEqual({
        digest: hash('{"items":[' + literals.join(',') + '],"version":1}'),
        count: 101,
        firstKey: '1|L|001',
        lastKey: '1|L|101',
      })
    },
  )

  it.each(['missing', 'foreign', 'duplicate', 'order'] as const)(
    'avvisar %s utan att kunna slutföra prefixet',
    (kind) => {
      const a = one(),
        b = { ...one(), key: '1|L|2' }
      const proof = new DetailReductionProof(
        new Map([
          [a.key, 'a'],
          [b.key, 'b'],
        ]),
      )
      if (kind === 'missing') {
        proof.append([a])
        expect(() => proof.finish()).toThrow(ConflictException)
      } else {
        const bad =
          kind === 'foreign' ? [a, { ...b, key: '2|L|2' }] : kind === 'duplicate' ? [a, a] : [b, a]
        expect(() => proof.append(bad)).toThrow(ConflictException)
      }
      expect(() => proof.append([b])).toThrow(ConflictException)
      expect(() => proof.finish()).toThrow(ConflictException)
    },
  )

  it('binder tom mellansida och upprepade entries utan att ändra manifestordningen', () => {
    const entry = { key: '1|L|2', digest: 'a'.repeat(64) }
    const proof = new ManifestReductionProof({ pageCount: 3, totalPages: 3, totalResources: 1 })
    const pages: VoucherManifestPage[] = [
      {
        page: 1,
        totalPages: 3,
        totalResources: 1,
        itemCount: 1,
        entries: [entry],
        digest: 'b'.repeat(64),
      },
      {
        page: 2,
        totalPages: 3,
        totalResources: 1,
        itemCount: 0,
        entries: [],
        digest: 'c'.repeat(64),
      },
      {
        page: 3,
        totalPages: 3,
        totalResources: 1,
        itemCount: 2,
        entries: [entry, entry],
        digest: 'd'.repeat(64),
      },
    ]
    for (const page of pages) proof.append(page)
    const e = '{"digest":"' + 'a'.repeat(64) + '","key":"1|L|2"}'
    const expected =
      '{"pages":[' +
      '{"digest":"' +
      'b'.repeat(64) +
      '","entries":[' +
      e +
      '],"itemCount":1,"page":1,"totalPages":3,"totalResources":1},' +
      '{"digest":"' +
      'c'.repeat(64) +
      '","entries":[],"itemCount":0,"page":2,"totalPages":3,"totalResources":1},' +
      '{"digest":"' +
      'd'.repeat(64) +
      '","entries":[' +
      e +
      ',' +
      e +
      '],"itemCount":2,"page":3,"totalPages":3,"totalResources":1}],"version":1}'
    expect(proof.finish()).toStrictEqual({
      digest: hash(expected),
      pageCount: 3,
      itemsSeen: 3,
      keys: new Map([['1|L|2', 'a'.repeat(64)]]),
      duplicateWarnings: [
        'Verifikat 1|L|2 förekom flera gånger i listan och räknades en gång.',
        'Verifikat 1|L|2 förekom flera gånger i listan och räknades en gång.',
      ],
    })
  })

  it.each(['page', 'totals', 'conflicting-duplicate', 'missing'] as const)(
    'avvisar manifestfel %s och stänger proofbyggaren',
    (kind) => {
      const proof = new ManifestReductionProof({ pageCount: 2, totalPages: 2, totalResources: 1 })
      const page = {
        page: 1,
        totalPages: 2,
        totalResources: 1,
        itemCount: 1,
        entries: [{ key: '1|L|1', digest: 'a'.repeat(64) }],
        digest: 'b'.repeat(64),
      }
      proof.append(page)
      if (kind === 'missing') expect(() => proof.finish()).toThrow(ConflictException)
      else {
        const bad = {
          ...page,
          page: kind === 'page' ? 1 : 2,
          totalResources: kind === 'totals' ? 2 : 1,
          entries: [
            {
              key: '1|L|1',
              digest: kind === 'conflicting-duplicate' ? 'c'.repeat(64) : 'a'.repeat(64),
            },
          ],
        }
        expect(() => proof.append(bad)).toThrow(ConflictException)
      }
      expect(() => proof.finish()).toThrow(ConflictException)
    },
  )
})

describe('Fortnox intern reducer: oförändrad ekonomi och provenance', () => {
  it('bevarar sista mappingvärdet, första nyckelordningen och gamla varningsordningen', () => {
    const maps = createFrozenReductionMaps()
    appendReductionMappings(maps, [
      { type: 'COST_CENTER', code: 'X', propertyId: 'old', propertyName: 'Öst' },
      { type: 'PROJECT', code: 'P', propertyId: 'p', propertyName: 'Äng' },
      { type: 'COST_CENTER', code: 'X', propertyId: 'new', propertyName: 'Ås' },
      { type: 'COST_CENTER', code: 'OK', propertyId: 'ok', propertyName: 'Hus' },
    ])
    const accepted = {
      ...catalog,
      dimensions: [{ type: 'COST_CENTER' as const, code: 'OK' }],
      coverage: {
        costCenters: { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 },
        projects: emptyCoverage,
      },
    }
    const { config, base } = buildReductionConfig(input, accepted, maps, emptyCoverage, [
      'duplicate',
    ])
    expect([...maps.mappings]).toStrictEqual([
      ['COST_CENTER:X', { propertyId: 'new', propertyName: 'Ås' }],
      ['PROJECT:P', { propertyId: 'p', propertyName: 'Äng' }],
      ['COST_CENTER:OK', { propertyId: 'ok', propertyName: 'Hus' }],
    ])
    expect([...config.mappings]).toStrictEqual([
      ['COST_CENTER:OK', { propertyId: 'ok', propertyName: 'Hus' }],
    ])
    expect(base.uncertainties).toStrictEqual([
      'Kostnadsstället X är kopplat i Eveno men finns inte i Fortnox; kopplingen används inte.',
      'Projektet P är kopplat i Eveno men finns inte i Fortnox; kopplingen används inte.',
      'duplicate',
    ])
  })

  it('behåller extra katalogprojekt i katalogen men bara efterfrågad coverage i resultatet', () => {
    const extra = {
      ...catalog,
      dimensions: [{ type: 'PROJECT' as const, code: 'P' }],
      coverage: {
        ...catalog.coverage,
        projects: { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 },
      },
    }
    const before = JSON.stringify(extra)
    const { config, base } = buildReductionConfig(
      input,
      extra,
      createFrozenReductionMaps(),
      emptyCoverage,
      [],
    )
    const result = finishReducedLedger(
      createLedgerAccumulator(config, base).finish(),
      extra,
      new Map(),
    )
    expect(result).toStrictEqual({
      status: 'COMPLETE',
      reason: null,
      financialYear: { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' },
      summary: {
        currency: 'SEK',
        totalOre: 0,
        byProperty: [],
        unmappedDimensions: [],
        unallocatedOre: 0,
        uncertainRemovedOre: 0,
        evenoExportOre: 0,
        balanceBroughtForwardOre: { '5170': -125 },
        financialYearAccountingMethod: 'ACCRUAL',
      },
      rows: [],
      references: [],
      uncertainties: [LIMITATION],
      coverage: { '/3/costcenters': emptyCoverage, '/3/vouchers/sublist': emptyCoverage },
    })
    expect(JSON.stringify(extra)).toBe(before)
  })

  it('summerar aldrig skilda ingående saldon och bevarar tecken, noll och null', () => {
    const balances: CheckpointCatalog = {
      ...catalog,
      financialYear: { ...catalog.financialYear, accountingMethod: '' },
      accounts: [
        { number: 5390, active: null, balanceBroughtForwardOre: Number.MAX_SAFE_INTEGER },
        { number: 5310, active: true, balanceBroughtForwardOre: Number.MAX_SAFE_INTEGER },
        { number: 5290, active: true, balanceBroughtForwardOre: null },
        { number: 5190, active: true, balanceBroughtForwardOre: 0 },
        { number: 5170, active: true, balanceBroughtForwardOre: -125 },
      ],
    }
    const { config, base } = buildReductionConfig(
      { ...input, costAccounts: [5170, 5190, 5290, 5310, 5390] },
      balances,
      createFrozenReductionMaps(),
      emptyCoverage,
      [],
    )
    const accumulator = createLedgerAccumulator(config, base)
    accumulator.add(one())
    expect(finishReducedLedger(accumulator.finish(), balances, new Map()).summary).toStrictEqual({
      currency: 'SEK',
      totalOre: 100,
      byProperty: [],
      unmappedDimensions: [],
      unallocatedOre: 100,
      uncertainRemovedOre: 0,
      evenoExportOre: 0,
      balanceBroughtForwardOre: {
        '5170': -125,
        '5190': 0,
        '5290': null,
        '5310': 9007199254740991,
        '5390': 9007199254740991,
      },
      financialYearAccountingMethod: null,
    })
  })

  it.each([0, -7, null])('bevarar revision %s och källkonton med 0/1/flera träffar', (revision) => {
    const maps = createFrozenReductionMaps()
    appendReductionOwnExports(maps, [
      {
        voucher: '1|L|1',
        journalEntryId: 'journal',
        revision,
        perMal: [
          { account: 5170, sources: [] },
          { account: 5190, sources: [4010] },
          { account: 5290, sources: [4000, 4001] },
        ],
      },
    ])
    const row = {
      voucher: '1|L|1',
      row: 1,
      transactionDate: '2026-10-01',
      account: 5170,
      amountOre: 100,
      bucket: 'UNALLOCATED' as const,
      dimensionType: null,
      code: null,
      propertyId: null,
      evenoExport: true,
    }
    const baseResult: LedgerReadResult = {
      status: 'COMPLETE',
      reason: null,
      financialYear: null,
      summary: null,
      rows: [
        row,
        { ...row, row: 2, account: 5190 },
        { ...row, row: 3, account: 5290 },
        { ...row, row: 4, evenoExport: false },
      ],
      coverage: {},
      references: [],
      uncertainties: [],
    }
    const before = JSON.stringify(baseResult)
    expect(enrichEvenoLedgerResult(baseResult, maps.ownExports)).toStrictEqual({
      ...baseResult,
      rows: [
        {
          ...row,
          evenoSource: {
            journalEntryId: 'journal',
            sourceAccount: null,
            mappingRevision: revision,
          },
        },
        {
          ...row,
          row: 2,
          account: 5190,
          evenoSource: {
            journalEntryId: 'journal',
            sourceAccount: 4010,
            mappingRevision: revision,
          },
        },
        {
          ...row,
          row: 3,
          account: 5290,
          evenoSource: {
            journalEntryId: 'journal',
            sourceAccount: null,
            mappingRevision: revision,
          },
        },
        { ...row, row: 4, evenoExport: false },
      ],
    })
    expect(JSON.stringify(baseResult)).toBe(before)
    const empty = { ...baseResult, rows: null }
    expect(enrichEvenoLedgerResult(empty, new Map<string, Egen>())).toBe(empty)
    expect(
      enrichEvenoLedgerResult({ ...baseResult, rows: [] }, maps.ownExports).rows,
    ).toStrictEqual([])
  })

  it('behåller alla varningar även över V8:s funktionsargumentgräns', () => {
    const warnings = Array.from({ length: 150_000 }, (_, index) => `duplicate-${index}`)
    const { base } = buildReductionConfig(
      input,
      catalog,
      createFrozenReductionMaps(),
      emptyCoverage,
      warnings,
    )
    expect(base.uncertainties).toEqual(warnings)
    expect(base.uncertainties).not.toBe(warnings)
  })

  it('ger en snäv overflowklass men behåller gamla Incomplete-kontraktet och spärrat prefix', () => {
    const { config, base } = buildReductionConfig(
      input,
      catalog,
      createFrozenReductionMaps(),
      emptyCoverage,
      [],
    )
    const accumulator = createLedgerAccumulator(config, base)
    const huge = one()
    huge.rows[0]!.debitOre = 9007199254740990
    accumulator.add(huge)
    let error: unknown
    try {
      accumulator.add({ ...one(), key: '1|L|2' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LedgerAmountOverflow)
    expect(error).toBeInstanceOf(Incomplete)
    expect((error as Error).message).toBe('Beloppssumman ligger utanför säkert talområde')
    expect(() => accumulator.finish()).toThrow(error as Error)
    expect(() => accumulator.add(one())).toThrow(error as Error)
    expect(new Incomplete('Beloppssumman ligger utanför säkert talområde')).not.toBeInstanceOf(
      LedgerAmountOverflow,
    )
  })
})
