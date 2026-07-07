/**
 * PSD2 P1 — ingestFromApi (väg byggd, ingen skarp källa förrän P2). Bevisar:
 *   • atomär dedup: dubbel-API-request samma externalId → EN rad, inget 500,
 *   • valuta-avvisning (icke-SEK) — explicit, ingen create,
 *   • storno/negativa — avvisas EXPLICIT, aldrig tyst drop,
 *   • booked-only (pending avvisas),
 *   • MIGRATIONSFÄLLAN: samma betalning via fil OCH API → ingen andra rad, ingen
 *     dubbel-allokering (bägge riktningarna),
 *   • bookingDate normaliseras till Europe/Stockholm-kalenderdag.
 * Den härdade matchTransaction (#161-166) mockas bort — detta rör bara vägen in.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

// In-memory BankTransaction-tabell med de where-former ingest-vägarna använder.
function makeFake() {
  const rows: Array<Record<string, unknown>> = []
  let seq = 0

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'organizationId') {
        if (row.organizationId !== v) return false
      } else if (k === 'externalId') {
        if (v && typeof v === 'object' && 'not' in (v as object)) {
          if ((v as { not: unknown }).not === null && row.externalId == null) return false
        } else if (row.externalId !== v) return false
      } else if (k === 'dedupKey') {
        if (row.dedupKey !== v) return false
      } else if (k === 'date') {
        if ((row.date as Date)?.getTime?.() !== (v as Date)?.getTime?.()) return false
      } else if (k === 'amount') {
        if (String(row.amount) !== String(v)) return false
      } else if (row[k] !== v) {
        return false
      }
    }
    return true
  }

  const prisma = {
    bankTransaction: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        // Speglar @@unique(organizationId, externalId): dubblett (icke-null) → P2002.
        if (
          data.externalId != null &&
          rows.some(
            (r) => r.organizationId === data.organizationId && r.externalId === data.externalId,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          })
        }
        const row = { id: `tx-${(seq += 1)}`, ...data }
        rows.push(row)
        return Promise.resolve(row)
      }),
    },
  }
  return { prisma, rows }
}

function makeService() {
  const fake = makeFake()
  const service = new ReconciliationService(
    fake.prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  const matchSpy = jest.spyOn(service, 'matchTransaction').mockResolvedValue(true)
  return { service, matchSpy, ...fake }
}

const OCR = '00123459'
const SEK_TX = {
  bookingDate: new Date('2026-05-01T10:00:00Z'),
  booked: true,
  currency: 'SEK',
  amount: 8500,
  description: 'Inbetalning',
  ocr: OCR,
}

describe('ReconciliationService.ingestFromApi — PSD2 P1', () => {
  it('atomär dedup: dubbel-request samma externalId → EN rad, inget 500', async () => {
    const { service, rows, matchSpy } = makeService()
    const r1 = await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    const r2 = await service.ingestFromApi('org-1', 'ext-1', SEK_TX)

    expect(r1.outcome).toBe('imported')
    expect(r2.outcome).toBe('duplicate')
    if (r2.outcome === 'duplicate') expect(r2.transactionId).toBe(rows[0]!.id)
    expect(rows).toHaveLength(1) // bara EN rad
    expect(matchSpy).toHaveBeenCalledTimes(1) // matchning bara på första raden
  })

  it('valuta: icke-SEK avvisas EXPLICIT, ingen rad skapas', async () => {
    const { service, rows } = makeService()
    const result = await service.ingestFromApi('org-1', 'ext-eur', { ...SEK_TX, currency: 'EUR' })
    expect(result).toEqual({ outcome: 'rejected', reason: 'NON_SEK' })
    expect(rows).toHaveLength(0)
  })

  it('storno/negativa: amount<=0 avvisas EXPLICIT (aldrig tyst drop)', async () => {
    const { service, rows } = makeService()
    const neg = await service.ingestFromApi('org-1', 'ext-neg', { ...SEK_TX, amount: -8500 })
    const zero = await service.ingestFromApi('org-1', 'ext-zero', { ...SEK_TX, amount: 0 })
    expect(neg).toEqual({ outcome: 'rejected', reason: 'NON_POSITIVE' })
    expect(zero).toEqual({ outcome: 'rejected', reason: 'NON_POSITIVE' })
    expect(rows).toHaveLength(0)
  })

  it('booked-only: pending (booked=false) avvisas', async () => {
    const { service, rows } = makeService()
    const result = await service.ingestFromApi('org-1', 'ext-pending', { ...SEK_TX, booked: false })
    expect(result).toEqual({ outcome: 'rejected', reason: 'NOT_BOOKED' })
    expect(rows).toHaveLength(0)
  })

  it('bookingDate normaliseras till Europe/Stockholm-kalenderdag', async () => {
    const { service, rows } = makeService()
    // 2026-05-01 23:30 UTC = 2026-05-02 01:30 svensk tid → dag 2026-05-02.
    await service.ingestFromApi('org-1', 'ext-tz', {
      ...SEK_TX,
      bookingDate: new Date('2026-05-01T23:30:00Z'),
    })
    expect((rows[0]!.date as Date).toISOString().slice(0, 10)).toBe('2026-05-02')
  })

  it('MIGRATIONSFÄLLAN fil→API: fil-rad finns → API dedupar (dedupKey), ingen dubbel-allokering', async () => {
    const { service, rows, matchSpy } = makeService()
    // 1) Betalning ingestas via FIL (stämplar dedupKey), matchas → allokerad EN gång.
    const fileOutcome = await service.ingestFromFile('org-1', {
      dedup: { date: new Date('2026-05-01'), description: 'Hyra', amount: new Decimal('8500.00') },
      data: {
        date: new Date('2026-05-01'),
        description: 'Hyra',
        amount: new Decimal('8500.00'),
        rawOcr: OCR,
      },
      crossSource: { date: new Date('2026-05-01'), amount: new Decimal('8500.00'), ocr: OCR },
    })
    expect(fileOutcome.duplicate).toBe(false)
    expect(rows).toHaveLength(1)

    // 2) SAMMA betalning kommer via PSD2-API → måste kännas igen (dedupKey), INGEN rad 2.
    const apiOutcome = await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    expect(apiOutcome.outcome).toBe('duplicate')
    if (apiOutcome.outcome === 'duplicate') expect(apiOutcome.via).toBe('dedupKey')
    expect(rows).toHaveLength(1) // fortfarande EN rad
    expect(matchSpy).toHaveBeenCalledTimes(1) // matchning bara EN gång → ingen dubbel-allokering
  })

  it('MIGRATIONSFÄLLAN API→fil: API-rad finns → filimport dedupar mot API-raden', async () => {
    const { service, rows, matchSpy } = makeService()
    // 1) Betalning via PSD2-API (externalId + dedupKey), matchas.
    await service.ingestFromApi('org-1', 'ext-1', SEK_TX)
    expect(rows).toHaveLength(1)

    // 2) Operatören laddar upp en FIL med samma betalning (annan beskrivning) →
    //    fält-dedupen missar (olik description), men cross-source dedupKey fångar API-raden.
    const fileOutcome = await service.ingestFromFile('org-1', {
      dedup: {
        date: new Date('2026-05-01'),
        description: 'Annan text',
        amount: new Decimal('8500.00'),
      },
      data: {
        date: new Date('2026-05-01'),
        description: 'Annan text',
        amount: new Decimal('8500.00'),
        rawOcr: OCR,
      },
      crossSource: { date: new Date('2026-05-01'), amount: new Decimal('8500.00'), ocr: OCR },
    })
    expect(fileOutcome.duplicate).toBe(true)
    expect(rows).toHaveLength(1) // ingen andra rad
    expect(matchSpy).toHaveBeenCalledTimes(1) // matchning bara EN gång
  })
})
