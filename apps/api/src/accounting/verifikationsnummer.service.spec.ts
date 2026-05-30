/**
 * FIX 9 · PR 4 — Gap-free, race-säker verifikationsnummer (LAGBROTT 6).
 *
 * Verifierar VerifikationsnummerService:
 *   • fiscalYearFor: kalenderår och brutet räkenskapsår.
 *   • allocate: atomär increment via JournalEntrySequence (serie "A").
 *   • allocate: härleds rätt räkenskapsår ur Organization.fiscalYearStartMonth.
 *   • allocate: vägrar nummer i stängd bokföringsperiod (ConflictException).
 */

import { ConflictException } from '@nestjs/common'
import { VerifikationsnummerService } from './verifikationsnummer.service'

function makeClient(opts: {
  fiscalYearStartMonth?: number | null
  closed?: boolean
  lastNumber?: number
}) {
  const upsert = jest.fn().mockResolvedValue({ lastNumber: opts.lastNumber ?? 1 })
  const client = {
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.fiscalYearStartMonth === null
            ? null
            : { fiscalYearStartMonth: opts.fiscalYearStartMonth ?? 1 },
        ),
    },
    closedAccountingPeriod: {
      findUnique: jest.fn().mockResolvedValue(opts.closed ? { id: 'closed-1' } : null),
    },
    journalEntrySequence: { upsert },
  }
  return { client, upsert }
}

// new VerifikationsnummerService(prisma) — prisma används aldrig direkt i
// allocate (allt går via det inskickade klient-/tx-objektet), så en tom mock duger.
const service = new VerifikationsnummerService({} as never)

describe('VerifikationsnummerService.fiscalYearFor', () => {
  it('kalenderår (startmånad 1): alltid datumets år', () => {
    expect(VerifikationsnummerService.fiscalYearFor(new Date('2026-01-01T00:00:00Z'), 1)).toBe(2026)
    expect(VerifikationsnummerService.fiscalYearFor(new Date('2026-12-31T00:00:00Z'), 1)).toBe(2026)
  })

  it('brutet räkenskapsår maj–april (startmånad 5)', () => {
    // Före startmånaden → föregående räkenskapsår.
    expect(VerifikationsnummerService.fiscalYearFor(new Date('2026-04-30T00:00:00Z'), 5)).toBe(2025)
    expect(VerifikationsnummerService.fiscalYearFor(new Date('2026-01-15T00:00:00Z'), 5)).toBe(2025)
    // Från och med startmånaden → innevarande räkenskapsår.
    expect(VerifikationsnummerService.fiscalYearFor(new Date('2026-05-01T00:00:00Z'), 5)).toBe(2026)
    expect(VerifikationsnummerService.fiscalYearFor(new Date('2026-07-01T00:00:00Z'), 5)).toBe(2026)
  })
})

describe('VerifikationsnummerService.allocate', () => {
  it('tilldelar serie "A" och numret från sekvensens increment', async () => {
    const { client, upsert } = makeClient({ lastNumber: 42 })
    const result = await service.allocate(
      client as never,
      'org-1',
      new Date('2026-06-15T00:00:00Z'),
    )

    expect(result).toEqual({ series: 'A', verNumber: 42, fiscalYear: 2026 })
    expect(upsert).toHaveBeenCalledWith({
      where: {
        organizationId_fiscalYear_series: {
          organizationId: 'org-1',
          fiscalYear: 2026,
          series: 'A',
        },
      },
      create: { organizationId: 'org-1', fiscalYear: 2026, series: 'A', lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })
  })

  it('härleds räkenskapsår ur brutet räkenskapsår vid allokering', async () => {
    const { client, upsert } = makeClient({ fiscalYearStartMonth: 5, lastNumber: 1 })
    // 2026-03 ligger i räkenskapsår 2025 (maj 2025 – april 2026).
    const result = await service.allocate(
      client as never,
      'org-1',
      new Date('2026-03-10T00:00:00Z'),
    )

    expect(result.fiscalYear).toBe(2025)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_fiscalYear_series: {
            organizationId: 'org-1',
            fiscalYear: 2025,
            series: 'A',
          },
        },
      }),
    )
  })

  it('defaultar till kalenderår om organisationen saknas', async () => {
    const { client } = makeClient({ fiscalYearStartMonth: null })
    const result = await service.allocate(
      client as never,
      'org-1',
      new Date('2026-09-01T00:00:00Z'),
    )
    expect(result.fiscalYear).toBe(2026)
  })

  it('vägrar tilldela nummer i en stängd bokföringsperiod', async () => {
    const { client, upsert } = makeClient({ closed: true })
    await expect(
      service.allocate(client as never, 'org-1', new Date('2026-06-15T00:00:00Z')),
    ).rejects.toBeInstanceOf(ConflictException)
    // Ingen sekvensökning får ske om perioden är stängd.
    expect(upsert).not.toHaveBeenCalled()
  })
})
