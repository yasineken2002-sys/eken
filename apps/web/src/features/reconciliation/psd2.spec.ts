import { describe, expect, it } from 'vitest'
import {
  SAFE_BANK_CONSENT_FIELDS,
  aktivaSamtycken,
  consentDisplayFields,
  tolkaPsd2Kvittens,
} from './api/psd2.api'
import type { BankConsent, BankConsentStatus } from './api/psd2.api'
import { bankConsentStatusVisning } from './components/BankConsentStatusBadge'
import { SYNK_TIMEOUT_MS, synkBaslinje, synkLage } from './hooks/usePsd2'

const BASSAMTYCKE: BankConsent = {
  id: 'consent-1',
  provider: 'MOCK',
  status: 'ACTIVE',
  expiresAt: '2026-12-01T00:00:00.000Z',
  lastSyncedAt: '2026-09-03T08:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-09-01T08:00:00.000Z',
}

describe('BankConsentStatusBadge — mappningen är uttömmande', () => {
  const alla: BankConsentStatus[] = ['ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR']

  it.each(alla)('%s har en egen etikett och variant', (status) => {
    const { etikett, variant } = bankConsentStatusVisning(status)
    expect(etikett).toBeTruthy()
    expect(etikett).not.toBe(status) // aldrig rå enum-sträng i gränssnittet
    expect(['success', 'warning', 'danger', 'default']).toContain(variant)
  })

  it('fyra distinkta etiketter — ingen status maskerar en annan', () => {
    // Två tillstånd som renderas likadant är i praktiken ett tillstånd. Provet
    // är billigt och fångar den vanligaste slarvvarianten: en copy-paste-rad som
    // glömts.
    const etiketter = alla.map((s) => bankConsentStatusVisning(s).etikett)
    expect(new Set(etiketter).size).toBe(alla.length)
  })

  it('REVOKED är neutral, EXPIRED gul, ERROR röd — inte tvärtom', () => {
    // Semantiken, inte bara distinktheten. Ett återkallat samtycke är oftast
    // hyresvärdens egen handling och ska inte larma; ett utgånget KRÄVER en
    // åtgärd; ett fel är ett fel. Blir de omkastade är badgen fortfarande
    // "uttömmande" och fortfarande "distinkt" — proven ovan hade inte sett det.
    expect(bankConsentStatusVisning('REVOKED').variant).toBe('default')
    expect(bankConsentStatusVisning('EXPIRED').variant).toBe('warning')
    expect(bankConsentStatusVisning('ERROR').variant).toBe('danger')
    expect(bankConsentStatusVisning('ACTIVE').variant).toBe('success')
  })
})

describe('?psd2= — kvittensen efter bankens SCA', () => {
  it("'ok' och 'error' tolkas", () => {
    expect(tolkaPsd2Kvittens('ok')).toBe('ok')
    expect(tolkaPsd2Kvittens('error')).toBe('error')
  })

  it('OKÄNT värde blir null — inte error', () => {
    // Den bärande halvan. Ett okänt värde betyder "ingen bank har skickat
    // tillbaka någon", och den som öppnar sidan från menyn eller ett bokmärke
    // ska inte mötas av ett felmeddelande om ett samtycke hen aldrig startade.
    // Att tolka allt okänt som fel är den naturliga slarvvarianten.
    for (const värde of ['OK', 'Ok', 'true', 'fel', 'ok ', '', 'error;drop']) {
      expect(tolkaPsd2Kvittens(värde)).toBeNull()
    }
  })

  it('saknad, undefined och icke-strängar blir null', () => {
    expect(tolkaPsd2Kvittens(undefined)).toBeNull()
    expect(tolkaPsd2Kvittens(null)).toBeNull()
    expect(tolkaPsd2Kvittens(1)).toBeNull()
    expect(tolkaPsd2Kvittens(['ok'])).toBeNull()
  })
})

/**
 * ── LISTAN FÅR ALDRIG VISA ETT FÄLT UTANFÖR ALLOW-LISTEN ────────────────────
 *
 * `BankConsent` bär i databasen `accessTokenEnc`, `refreshTokenEnc`, `scope` och
 * `syncCursor`. Backend väljer bort dem (`SAFE_BANK_CONSENT_SELECT`), men ett
 * prov på backend-selecten säger ingenting om vad webben gör med ett svar som
 * ändå bär dem — och en framtida utvidgning av selecten är exakt hur ett sådant
 * svar uppstår.
 *
 * SONDEN MÅSTE KUNNA GE UTSLAG. Ett prov som bara letar efter hemligheter i
 * utdatan och inte hittar några är oskiljbart från ett prov som letar på fel
 * ställe. Därför prövas letmetoden först mot ett värde som SKA finnas där.
 *
 * VAD PROVET INTE KAN SE:
 *
 *  1. Att `SAFE_BANK_CONSENT_FIELDS` här och `SAFE_BANK_CONSENT_SELECT` i
 *     backend är samma mängd. De är två uppräkningar i två paket, och ingen
 *     vakt binder ihop dem i dag. Det som faktiskt skyddar är backend-selecten
 *     — den avgör vad som lämnar servern; listan här är en spegling som gör
 *     avsikten läsbar.
 *  2. Att komponenten går genom `consentDisplayFields`. Det bärs av att
 *     `ConsentKort` tar en `ConsentVisning` som prop och aldrig ser ett
 *     `BankConsent` — det finns inget objekt att gå förbi till.
 */
describe('consentDisplayFields — inget utanför allow-listen når UI:t', () => {
  const HEMLIGHETER = {
    accessTokenEnc: 'HEMLIG-ACCESS-TOKEN-abc123',
    refreshTokenEnc: 'HEMLIG-REFRESH-TOKEN-def456',
    scope: 'accounts transactions',
    syncCursor: 'markör-ghi789',
    organizationId: 'org-hemlig-jkl012',
  }
  // Ett samtycke så som det skulle se ut om backend-selecten utvidgades.
  const smutsigt = { ...BASSAMTYCKE, ...HEMLIGHETER } as unknown as BankConsent

  const platt = (v: unknown) => JSON.stringify(v)

  it('sonden kan ge utslag: ett SAFE-fälts värde hittas av samma metod', () => {
    // Kanariefågeln. Utan den skiljer inget "hemligheterna kom inte ut" från
    // "letandet fungerar inte". `provider` ligger i allow-listen och ska synas.
    const visning = consentDisplayFields(smutsigt)
    expect(platt(visning)).toContain('MOCK')
  })

  it('ingen av de fem uteslutna nycklarnas VÄRDEN finns i visningen', () => {
    const utdata = platt(consentDisplayFields(smutsigt))
    for (const [nyckel, värde] of Object.entries(HEMLIGHETER)) {
      expect(utdata, `${nyckel} läckte`).not.toContain(värde)
    }
  })

  it('inte heller deras NYCKELNAMN', () => {
    // Värdet ensamt räcker inte: en visning som skrev ut `scope: ''` hade
    // passerat provet ovan när värdet råkade vara tomt.
    const utdata = platt(consentDisplayFields(smutsigt))
    for (const nyckel of Object.keys(HEMLIGHETER)) {
      expect(utdata, `${nyckel} nämndes`).not.toContain(nyckel)
    }
  })

  it('varje toppnivå-nyckel i visningen är härledd ur allow-listen', () => {
    const visning = consentDisplayFields(smutsigt)
    // `rader` är den renderade uppräkningen; `id`, `provider` och `status` är
    // allow-listade fält som används direkt.
    expect(Object.keys(visning).sort()).toEqual(['id', 'provider', 'rader', 'status'])
    for (const nyckel of ['id', 'provider', 'status']) {
      expect(SAFE_BANK_CONSENT_FIELDS).toContain(nyckel)
    }
  })

  it('saknade datum blir läsbar text, inte tom rad eller "Invalid Date"', () => {
    const visning = consentDisplayFields({
      ...BASSAMTYCKE,
      expiresAt: null,
      lastSyncedAt: null,
      createdAt: 'inte-ett-datum',
    })
    const värden = visning.rader.map((r) => r.varde)
    expect(värden).toContain('Okänt')
    expect(värden).toContain('Aldrig')
    expect(platt(visning)).not.toContain('Invalid Date')
    // Ett ogiltigt createdAt ger ingen "Ansluten"-rad alls — hellre ingen
    // uppgift än en falsk.
    expect(visning.rader.map((r) => r.etikett)).not.toContain('Ansluten')
  })
})

describe('aktivaSamtycken räknar bara det som kan mata avstämningen', () => {
  it('bara ACTIVE', () => {
    const lista: BankConsent[] = [
      { ...BASSAMTYCKE, id: 'a', status: 'ACTIVE' },
      { ...BASSAMTYCKE, id: 'b', status: 'EXPIRED' },
      { ...BASSAMTYCKE, id: 'c', status: 'REVOKED' },
      { ...BASSAMTYCKE, id: 'd', status: 'ERROR' },
      { ...BASSAMTYCKE, id: 'e', status: 'ACTIVE' },
    ]
    expect(aktivaSamtycken(lista)).toBe(2)
    expect(aktivaSamtycken([])).toBe(0)
  })
})

describe('synkLage — en flyttad lastSyncedAt, inte ett kvitto från kön', () => {
  const baslinje = synkBaslinje([BASSAMTYCKE])

  it('oförändrad tidsstämpel inom fönstret → pågår', () => {
    expect(synkLage({ baslinje, nu: [BASSAMTYCKE], forflutenMs: 1_000 })).toBe('pagar')
  })

  it('flyttad tidsstämpel → klar', () => {
    const nu = [{ ...BASSAMTYCKE, lastSyncedAt: '2026-09-04T08:00:00.000Z' }]
    expect(synkLage({ baslinje, nu, forflutenMs: 1_000 })).toBe('klar')
  })

  it('från aldrig-synkad till synkad → klar', () => {
    // Den vanligaste första gången: baslinjen är null, inte en tidsstämpel.
    const forsta = synkBaslinje([{ ...BASSAMTYCKE, lastSyncedAt: null }])
    expect(synkLage({ baslinje: forsta, nu: [BASSAMTYCKE], forflutenMs: 500 })).toBe('klar')
  })

  it('efter fönstret utan förändring → uppgiven', () => {
    expect(synkLage({ baslinje, nu: [BASSAMTYCKE], forflutenMs: SYNK_TIMEOUT_MS })).toBe('uppgiven')
  })

  it('ett NYTT samtycke avslutar inte pollningen', () => {
    // Någon anslöt en bank i en annan flik. Det är en annan händelse, och att
    // läsa den som "synken är klar" hade gett ett falskt klarbesked.
    const nu = [BASSAMTYCKE, { ...BASSAMTYCKE, id: 'consent-2', lastSyncedAt: 'nyss' }]
    expect(synkLage({ baslinje, nu, forflutenMs: 1_000 })).toBe('pagar')
  })
})
