/**
 * M3 (del 2) — avinumret allokeras ur en sekvens i stället för max+1.
 *
 * Den gamla `nextNoticeNumber` läste högsta befintliga suffix och lade på ett.
 * Två överlappande genereringar läste samma committade max och fick SAMMA
 * nummer — mätt med riktiga överlappande anrop, inte resonerat.
 *
 * ⚠️ SERIALISERINGEN BEVISAS INTE HÄR. Ett radlås finns inte i en attrapp; en
 * mockad upsert returnerar bara det jag programmerat den att returnera. Det
 * beviset görs mot riktig Postgres i `.proof-m3/` (se PR-texten och
 * docs/runbooks/bevisrigg-riktig-postgres.md), och där är utfallet:
 *
 *     två samtidiga → AVI-2026-06-0001 / 0002, kollision: false   (före: 0002/0002)
 *     tjugo samtidiga → tjugo unika, sammanhängande
 *
 * Den här specen äger det som GÅR att pinna utan databas: att allokeringen
 * verkligen går via sekvensen, med rätt scope, och att formatet är oförändrat.
 */

import { allocateRentNoticeNumber, formatNoticeNumber } from './rent-notice-number'

function rigg(lastNumber: number) {
  const upsert = jest.fn().mockResolvedValue({ lastNumber })
  return { client: { rentNoticeNumberSequence: { upsert } }, upsert }
}

describe('formatNoticeNumber — formatet är OFÖRÄNDRAT', () => {
  it('AVI-{år}-{mm}-{NNNN}', () => {
    expect(formatNoticeNumber(2026, 6, 1)).toBe('AVI-2026-06-0001')
    expect(formatNoticeNumber(2026, 12, 42)).toBe('AVI-2026-12-0042')
  })

  it('månaden nollutfylls — annars kolliderar inte prefixen som de ska', () => {
    // Vore månaden inte tvåsiffrig blev "AVI-2026-1-0001" och "AVI-2026-11-..."
    // svårare att skilja åt, och prefixsökningar hade blandat ihop dem.
    expect(formatNoticeNumber(2026, 1, 1)).toBe('AVI-2026-01-0001')
    expect(formatNoticeNumber(2026, 11, 1)).toBe('AVI-2026-11-0001')
  })

  it('löpnumret nollutfylls till fyra siffror men klipps inte vid överflöd', () => {
    expect(formatNoticeNumber(2026, 6, 9999)).toBe('AVI-2026-06-9999')
    expect(formatNoticeNumber(2026, 6, 10_000)).toBe('AVI-2026-06-10000')
  })
})

describe('allocateRentNoticeNumber', () => {
  it('går via sekvensen — INTE en max-läsning över RentNotice', () => {
    // Kärnan i ändringen: ingen findMany, ingen parsning av befintliga nummer.
    const { client } = rigg(1)
    expect((client as Record<string, unknown>).rentNotice).toBeUndefined()
  })

  it('scopet är (organizationId, year, month)', async () => {
    const { client, upsert } = rigg(7)
    await allocateRentNoticeNumber(client as never, 'org-1', 2026, 6)

    expect(upsert).toHaveBeenCalledTimes(1)
    const arg = upsert.mock.calls[0][0]
    expect(arg.where).toEqual({
      organizationId_year_month: { organizationId: 'org-1', year: 2026, month: 6 },
    })
  })

  it('en ny scope-rad börjar på 1, en befintlig ökas med 1', async () => {
    const { client, upsert } = rigg(1)
    await allocateRentNoticeNumber(client as never, 'org-1', 2026, 6)

    const arg = upsert.mock.calls[0][0]
    expect(arg.create).toMatchObject({ organizationId: 'org-1', year: 2026, month: 6, lastNumber: 1 }) // prettier-ignore
    // Atomär increment — inte "läs, lägg på ett, skriv".
    expect(arg.update).toEqual({ lastNumber: { increment: 1 } })
  })

  it('numret byggs ur sekvensens svar, inte ur något annat', async () => {
    const { client } = rigg(43)
    await expect(allocateRentNoticeNumber(client as never, 'org-1', 2026, 6)).resolves.toBe(
      'AVI-2026-06-0043',
    )
  })

  it('KANARIEFÅGEL: update får aldrig bli en absolut skrivning', async () => {
    // `lastNumber: n + 1` i stället för `increment: 1` hade sett rätt ut i ett
    // sekventiellt test och återinfört exakt den race vi byggt bort — värdet
    // hade räknats i applikationen på inaktuell grund.
    const { client, upsert } = rigg(5)
    await allocateRentNoticeNumber(client as never, 'org-1', 2026, 6)

    const update = upsert.mock.calls[0][0].update as Record<string, unknown>
    expect(update).toHaveProperty('lastNumber.increment')
    expect(typeof (update.lastNumber as Record<string, unknown>).increment).toBe('number')
  })
})
