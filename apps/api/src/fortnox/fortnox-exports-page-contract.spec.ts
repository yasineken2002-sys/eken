import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { JournalEntrySource } from '@prisma/client'

import {
  FORTNOX_EXPORT_GROUPS,
  FORTNOX_EXPORT_SOURCES,
  fortnoxExportRowSchema,
  fortnoxExportsPageQuerySchema,
  fortnoxExportsPageSchema,
} from '@eken/shared'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { FortnoxExportsPageQueryDto } from './dto/fortnox-exports-page-query.dto'

/** Queryn går genom exakt samma pipeinställningar som main.ts, inklusive implicit koercion. */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)
const transform = (query: Record<string, unknown>): Promise<unknown> =>
  pipe.transform(query, { type: 'query', metatype: FortnoxExportsPageQueryDto })

async function expectAccepted(query: Record<string, unknown>): Promise<void> {
  const parsed = fortnoxExportsPageQuerySchema.parse(query)
  const actual = await transform(query)
  expect(actual).toBeInstanceOf(FortnoxExportsPageQueryDto)
  expect(actual).toEqual(parsed)
}

async function expectRejected(query: Record<string, unknown>): Promise<void> {
  expect(fortnoxExportsPageQuerySchema.safeParse(query).success).toBe(false)
  await expect(transform(query)).rejects.toBeInstanceOf(BadRequestException)
}

describe('Fortnox-arbetslistans querykontrakt genom produktionspipen', () => {
  it('mäter den verkliga koercionen och ger inga standardvärden åt saknade fält', async () => {
    expect(VALIDATION_PIPE_OPTIONS.transformOptions?.enableImplicitConversion).toBe(true)
    await expectAccepted({})
    expect(fortnoxExportsPageQuerySchema.parse({})).toStrictEqual({})
    const actual = await transform({})
    if (!(actual instanceof FortnoxExportsPageQueryDto))
      throw new Error('Pipen returnerade inte DTO:n')
    expect(actual.offset).toBeUndefined()
    expect(actual.limit).toBeUndefined()
    expect(actual.group).toBeUndefined()
  })

  it.each([
    { offset: 0, limit: 1 },
    { offset: 2147483647, limit: 200 },
    { offset: '0', limit: '1' },
    { offset: '2147483647', limit: '200' },
    { offset: '12', limit: '50' },
    { from: '2024-02-29', to: '2024-02-29' },
    { from: '2000-02-29', to: '2000-03-01' },
    { from: '2025-12-31', to: '2026-01-01' },
    { from: '2026-01-01' },
    { to: '2026-12-31' },
  ])('godtar gränsen %p med samma resultat i schema och DTO', expectAccepted)

  it('konverterar kanoniska querysträngar till tal, inte bara godtar dem', async () => {
    const query = { offset: '12', limit: '50', group: 'NEEDS_REVIEW' }
    expect(fortnoxExportsPageQuerySchema.parse(query)).toStrictEqual({
      offset: 12,
      limit: 50,
      group: 'NEEDS_REVIEW',
    })
    expect(await transform(query)).toMatchObject({ offset: 12, limit: 50, group: 'NEEDS_REVIEW' })
  })

  it('binder hela källmängden till befintliga JournalEntrySource utan Prisma i webben', async () => {
    expect([...FORTNOX_EXPORT_SOURCES].sort()).toEqual(Object.values(JournalEntrySource).sort())
    for (const source of FORTNOX_EXPORT_SOURCES) await expectAccepted({ source })
    for (const group of FORTNOX_EXPORT_GROUPS) await expectAccepted({ group })
  })

  it.each(['offset', 'limit', 'from', 'to', 'source', 'group'])(
    '%s är valfritt men avvisar null, array, objekt och boolean',
    async (field) => {
      for (const value of [null, [], ['1'], {}, true, false]) {
        await expectRejected({ [field]: value })
      }
    },
  )

  it.each(['offset', 'limit'])(
    '%s avvisar icke-kanoniska eller icke-ändliga tal genom samma pipe',
    async (field) => {
      for (const value of [
        '',
        ' ',
        '01',
        '+1',
        '-0',
        '-1',
        '1.0',
        '1e2',
        '0x10',
        '12abc',
        'Infinity',
        'NaN',
        ' 12',
        '12 ',
        '12\n',
        '12\r\n',
        1.5,
        -1,
        Infinity,
        -Infinity,
        NaN,
      ]) {
        await expectRejected({ [field]: value })
      }
    },
  )

  it.each([
    { offset: 2147483648 },
    { offset: '2147483648' },
    { offset: '999999999999999999999999' },
    { limit: 0 },
    { limit: '0' },
    { limit: 201 },
    { limit: '201' },
    { source: 'CUSTOMER_CREDIT' },
    { source: 'manual' },
    { source: '' },
    { source: 1 },
    { group: 'UNKNOWN' },
    { group: 'all' },
    { group: '' },
    { group: 1 },
    { from: '2026-03-01', to: '2026-02-28' },
    { offset: '1', extra: 'ignored?' },
    { __fortnoxExportsPageContract: true },
  ])('avvisar %p i både schemat och DTO:n', expectRejected)

  it.each(['from', 'to'])(
    '%s kräver ett verkligt datum utan tid eller normalisering',
    async (field) => {
      for (const value of [
        '',
        '2026-02-29',
        '1900-02-29',
        '2024-02-30',
        '2026-04-31',
        '2026-13-01',
        '2026-00-01',
        '2026-01-00',
        '2026-1-01',
        '2026-01-1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01 ',
        20260101,
      ]) {
        await expectRejected({ [field]: value })
      }
    },
  )
})

describe('Fortnox-arbetslistans delade svar', () => {
  const minimalRow = {
    id: 'export-1',
    journalEntryId: 'journal-1',
    state: 'BLOCKED',
    blockReason: null,
    updatedAt: '2026-10-16T12:00:00.000Z',
  }

  it('bevarar befintliga fält och valfria/nullbara värden utan nya personfält', () => {
    expect(fortnoxExportRowSchema.parse(minimalRow)).toStrictEqual(minimalRow)
    const row = {
      ...minimalRow,
      state: 'CONFIRMED',
      draftHash: null,
      lastOutcome: null,
      externalYear: 2026,
      externalSeries: 'A',
      externalNumber: 12,
      exportText: [{ falt: 'Description', rad: null, originaltext: 'Text', exporttext: 'Text' }],
    }
    expect(fortnoxExportRowSchema.parse(row)).toStrictEqual(row)
    expect(Object.keys(fortnoxExportRowSchema.shape).sort()).toEqual(
      [
        'id',
        'journalEntryId',
        'state',
        'blockReason',
        'draftHash',
        'lastOutcome',
        'externalYear',
        'externalSeries',
        'externalNumber',
        'exportText',
        'updatedAt',
      ].sort(),
    )
  })

  it('kräver sidmetadata även på en tom sida efter sista träffen', () => {
    expect(fortnoxExportsPageSchema.parse({ items: [], total: 3, offset: 50, limit: 50 })).toEqual({
      items: [],
      total: 3,
      offset: 50,
      limit: 50,
    })
    expect(fortnoxExportsPageSchema.safeParse({ items: [minimalRow] }).success).toBe(false)
  })

  it('avvisar trasiga sidmetadata eller exporttillstånd', () => {
    const page = { items: [minimalRow], total: 1, offset: 0, limit: 50 }
    expect(fortnoxExportsPageSchema.parse(page)).toStrictEqual(page)
    for (const changed of [
      { total: -1 },
      { total: 1.5 },
      { total: '1' },
      { offset: -1 },
      { offset: 2147483648 },
      { limit: 0 },
      { limit: 201 },
      { items: [{ ...minimalRow, state: 'UNRECOGNIZED' }] },
    ]) {
      expect(fortnoxExportsPageSchema.safeParse({ ...page, ...changed }).success).toBe(false)
    }
  })
})
