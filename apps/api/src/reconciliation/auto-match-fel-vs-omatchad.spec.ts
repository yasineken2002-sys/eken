// Måste stå FÖRE importerna: reconciliation.service → invoices.service →
// pdf.service → storage.service drar in @aws-sdk/client-s3, som är ESM och
// kraschar sviten under ts-jest. Samma knep som i AI-bilagornas specar.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * L1 — `autoMatchAll` skilde inte FEL från "ingen match".
 *
 * Grenen var en naken `catch { }` med bara en kommentar. Ett bokföringsfel, en
 * transaktions-timeout (Prisma P2028) och ett DB-avbrott hamnade i samma tysta
 * gren som ett normalt "den här transaktionen matchade inget" — och räknades
 * sedan in i `unmatched`. Operatören fick "12 väntar" och hade ingen anledning
 * att misstänka något; loggen sa ingenting, för det fanns ingen logg.
 *
 * Specen bevakar tre saker:
 *   1. att ett fel INTE längre ökar `unmatched`
 *   2. att det syns i utfallet (`failed`) OCH i loggen, med transaktions-id
 *   3. att en trasig transaktion inte stoppar resten av bulkkörningen
 */

import { Logger } from '@nestjs/common'
import { ReconciliationService } from './reconciliation.service'

/**
 * Bara de fält `autoMatchAll` rör. `matchTransaction` stubbas per transaktion —
 * det är precis gränssnittet mellan "kunde inte matcha" (false) och "gick sönder"
 * (kastar) som testas här, inte matchningslogiken i sig.
 */
function rigg(utfall: Array<boolean | Error>) {
  const candidates = utfall.map((_, i) => ({ id: `tx-${i + 1}` }))
  const prisma = {
    bankTransaction: { findMany: jest.fn().mockResolvedValue(candidates) },
  }
  // Bara prisma används av autoMatchAll; övriga beroenden nås aldrig i den här
  // vägen och stubbas som tomma objekt.
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )

  const anrop: string[] = []
  jest.spyOn(service, 'matchTransaction').mockImplementation((tx: { id: string }) => {
    anrop.push(tx.id)
    const svar = utfall[candidates.findIndex((c) => c.id === tx.id)]!
    if (svar instanceof Error) return Promise.reject(svar)
    return Promise.resolve(svar)
  })

  return { service, anrop }
}

let fel: jest.SpyInstance

beforeEach(() => {
  fel = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

describe('autoMatchAll — FEL är inte samma sak som ingen match', () => {
  it('normalfallet oförändrat: matchade + omatchade, noll fel', async () => {
    const { service } = rigg([true, false, true])
    await expect(service.autoMatchAll('org-1')).resolves.toEqual({
      matched: 2,
      unmatched: 1,
      skippedUnresolvedOcr: 0,
      failed: 0,
    })
    expect(fel).not.toHaveBeenCalled()
  })

  it('KRAV: ett kastat fel ökar INTE unmatched — det räknas för sig', async () => {
    // Kärnan i L1. Före fixen gav den här riggen { matched: 1, unmatched: 2 } och
    // felet var osynligt. Nu ska den omatchade vara EN, och felet stå för sig.
    const { service } = rigg([true, false, new Error('bokföringen sa nej')])

    const resultat = await service.autoMatchAll('org-1')

    expect(resultat).toEqual({ matched: 1, unmatched: 1, skippedUnresolvedOcr: 0, failed: 1 })
    expect(resultat.unmatched).not.toBe(2)
  })

  it('NEGATIVKONTROLL: det injicerade felet syns i LOGGEN med transaktions-id och orsak', async () => {
    // Att koden tar catch-grenen räcker inte som bevis — den gjorde den förut
    // också. Det som ska gå att belägga är att felet NÅR någon: id:t för att
    // kunna slå upp raden, orsaken för att veta vad som hände.
    const { service } = rigg([new Error('Betalningsverifikat kunde inte skapas')])

    await service.autoMatchAll('org-7')

    const rader = fel.mock.calls.map(([m]) => String(m))
    const raden = rader.find((r) => r.includes('tx-1'))
    expect(raden).toBeDefined()
    expect(raden).toContain('Betalningsverifikat kunde inte skapas')
    expect(raden).toContain('org-7')
  })

  it('en trasig transaktion stoppar inte resten av körningen', async () => {
    const { service, anrop } = rigg([new Error('DB nere'), true, true])

    const resultat = await service.autoMatchAll('org-1')

    expect(anrop).toEqual(['tx-1', 'tx-2', 'tx-3'])
    expect(resultat).toEqual({ matched: 2, unmatched: 0, skippedUnresolvedOcr: 0, failed: 1 })
  })

  it('en sammanfattningsrad skrivs när något gick fel — och bara då', async () => {
    const { service } = rigg([true, false])
    await service.autoMatchAll('org-1')
    expect(fel.mock.calls.some(([m]) => String(m).includes('FEL'))).toBe(false)

    fel.mockClear()
    const trasig = rigg([true, new Error('boom')])
    await trasig.service.autoMatchAll('org-1')
    expect(fel.mock.calls.some(([m]) => String(m).includes('1 FEL'))).toBe(true)
  })

  it('INVARIANT: räknarna summerar OCH failed speglar antalet injicerade fel', async () => {
    // Summan ensam är en BLIND kontroll — mätt, inte antaget: med den gamla
    // nakna grenen (failed stannar på 0, unmatched = allt som inte matchade)
    // summerar den ändå till antalet kandidater, och testet passerade grönt mot
    // exakt den defekt det skulle fånga.
    //
    // Därför pinnas BÅDA leden: att ingen transaktion försvinner ur
    // redovisningen, och att felen faktiskt hamnar i `failed` och ingen
    // annanstans. Det andra ledet är det som diskriminerar.
    for (const utfall of [
      [true, false, new Error('a')],
      [new Error('a'), new Error('b')],
      [false, false, false],
      [true, true, true],
    ]) {
      const { service } = rigg(utfall)
      const r = await service.autoMatchAll('org-1')
      const injiceradeFel = utfall.filter((u) => u instanceof Error).length

      expect(r.matched + r.unmatched + r.failed).toBe(utfall.length)
      expect(r.failed).toBe(injiceradeFel)
      expect(r.matched).toBe(utfall.filter((u) => u === true).length)
      expect(r.unmatched).toBe(utfall.filter((u) => u === false).length)

      jest.restoreAllMocks()
      fel = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    }
  })
})

// ── H3 PR B: same-tenant-invarianten i bulkkörningen ─────────────────────────
//
// Invarianten kastar mitt i en körning över många transaktioner. Den får INTE
// fälla hela körningen — men den får inte heller försvinna i `unmatched`, för då
// vore en avbruten allokering oskiljbar från "matchade inget".
//
// Den landar i `failed`-kategorin som #480 införde: räknad för sig, loggad med
// transaktions-id och orsak, och synlig i frontendens röda räknare.
describe('autoMatchAll — vattenfallets invariant räknas som FEL', () => {
  it('en bruten same-tenant-invariant stoppar inte körningen och göms inte i unmatched', async () => {
    const invariantfel = new Error(
      'Banktransaktion tx-2: OCR 00000000019 pekar på avier hos FLERA hyresgäster (tenant-A, tenant-B).',
    )
    const { service, anrop } = rigg([true, invariantfel, true])

    const resultat = await service.autoMatchAll('org-1')

    // Körningen fortsatte till sista transaktionen.
    expect(anrop).toEqual(['tx-1', 'tx-2', 'tx-3'])
    // Och felet ligger i failed, inte i unmatched.
    expect(resultat).toEqual({ matched: 2, unmatched: 0, skippedUnresolvedOcr: 0, failed: 1 })
  })

  it('loggen bär transaktions-id OCH de motstridiga hyresgästerna', async () => {
    const invariantfel = new Error(
      'Banktransaktion tx-1: OCR 00000000019 pekar på avier hos FLERA hyresgäster (tenant-A, tenant-B).',
    )
    const { service } = rigg([invariantfel])

    await service.autoMatchAll('org-9')

    const raden = fel.mock.calls.map(([m]) => String(m)).find((r) => r.includes('tx-1'))
    expect(raden).toBeDefined()
    expect(raden).toContain('tenant-A')
    expect(raden).toContain('tenant-B')
    expect(raden).toContain('org-9')
  })
})
