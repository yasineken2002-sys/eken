/**
 * H1 — avinummerserien är scopad till organisationen.
 *
 * Historik: max-sekvensen räknades en gång över ALLA orgars avier (saknat
 * organizationId-filter), så en ny kunds serie kunde börja på AVI-2026-06-0047.
 * Det rättades med ett `where`-filter på `organizationId`.
 *
 * M3 ersatte hela max+1-läsningen med en sekvenstabell. Org-scopet är därmed
 * inte längre ett FILTER någon kan glömma utan en del av PRIMÄRNYCKELN:
 * `@@id([organizationId, year, month])`. En org kan strukturellt inte läsa en
 * annan orgs räknare.
 *
 * Specen finns kvar därför att garantin ska bevakas även när mekanismen byts —
 * det är garantin som är kravet, inte implementationen. Den prövar nu att
 * organisationen ingår i uppslaget och att två orgar har åtskilda serier.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { allocateRentNoticeNumber } from './rent-notice-number'

interface UpsertArg {
  where: { organizationId_year_month: { organizationId: string; year: number; month: number } }
}

/** Räknare PER SCOPE-NYCKEL — samma isolering som tabellens primärnyckel ger. */
function riggMedScopeRäknare() {
  const räknare = new Map<string, number>()
  const upsert = jest.fn().mockImplementation((arg: UpsertArg) => {
    const { organizationId, year, month } = arg.where.organizationId_year_month
    const nyckel = `${organizationId}|${year}|${month}`
    const nästa = (räknare.get(nyckel) ?? 0) + 1
    räknare.set(nyckel, nästa)
    return Promise.resolve({ lastNumber: nästa })
  })
  return { client: { rentNoticeNumberSequence: { upsert } }, upsert }
}

describe('avinummer — org-scope (H1)', () => {
  it('organisationen ingår i sekvensuppslaget', async () => {
    const { client, upsert } = riggMedScopeRäknare()
    await allocateRentNoticeNumber(client as never, 'org-1', 2026, 6)

    expect(upsert.mock.calls[0][0].where.organizationId_year_month).toMatchObject({
      organizationId: 'org-1',
    })
  })

  it('KÄRNAN I H1: en ny org börjar på 0001 oavsett hur långt andra orgar kommit', async () => {
    const { client } = riggMedScopeRäknare()
    for (let i = 0; i < 46; i++) {
      await allocateRentNoticeNumber(client as never, 'etablerad-org', 2026, 6)
    }
    // Den etablerade orgen står på 0046. Den nya ska INTE ärva den serien.
    await expect(allocateRentNoticeNumber(client as never, 'ny-org', 2026, 6)).resolves.toBe(
      'AVI-2026-06-0001',
    )
  })

  it('två orgar räknar oberoende av varandra i samma månad', async () => {
    const { client } = riggMedScopeRäknare()
    const a1 = await allocateRentNoticeNumber(client as never, 'org-a', 2026, 6)
    const b1 = await allocateRentNoticeNumber(client as never, 'org-b', 2026, 6)
    const a2 = await allocateRentNoticeNumber(client as never, 'org-a', 2026, 6)

    expect(a1).toBe('AVI-2026-06-0001')
    expect(b1).toBe('AVI-2026-06-0001') // samma nummer, annan org — kolliderar inte
    expect(a2).toBe('AVI-2026-06-0002')
  })

  it('samma org räknar oberoende per månad', async () => {
    const { client } = riggMedScopeRäknare()
    await allocateRentNoticeNumber(client as never, 'org-1', 2026, 6)
    await allocateRentNoticeNumber(client as never, 'org-1', 2026, 6)

    await expect(allocateRentNoticeNumber(client as never, 'org-1', 2026, 7)).resolves.toBe(
      'AVI-2026-07-0001',
    )
  })
})
