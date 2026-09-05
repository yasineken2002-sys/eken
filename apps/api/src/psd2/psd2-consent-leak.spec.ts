/**
 * Läcktätning: SAFE_BANK_CONSENT_SELECT är den ENDA vägen BankConsent lämnar
 * backend. Tokens (accessTokenEnc/refreshTokenEnc), scope, syncCursor och
 * consentId får ALDRIG exponeras mot frontend/AI. (Mönster från
 * signering/tenant-portal.)
 *
 * ── EN LISTA, INTE TVÅ ──────────────────────────────────────────────────────
 *
 * Fältnamnen bor sedan den här PR:en i `@eken/shared`, och BÅDE selecten här och
 * webbens `psd2.api.ts` härleds ur dem. Provet nedan som jämför select-nycklarna
 * med listan är därför per konstruktion svårt att få rött — det är en
 * påkopplingskontroll, inte en regel: det ser att selecten fortfarande BYGGS ur
 * listan, och blir rött den dag någon skriver tillbaka en handskriven literal.
 *
 * DET SOM HAR TÄNDER ÄR PARTITIONEN. Den läser modellens FAKTISKA kolumner ur
 * Prismas DMMF och kräver att varje kolumn står i exakt en av två mängder. En ny
 * kolumn på BankConsent kan då inte tyst hamna mellan dem — vilket är precis hur
 * ett fält blir synligt utan att någon bestämt att det ska vara det.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att någon gör en `findMany` på BankConsent UTAN selecten. Partitionen säger
 * vad selecten innehåller, inte att den används. Det bärs av att
 * `listConsents` är den enda läsvägen ut och att `psd2-consent-leak` skulle
 * fånga en utvidgning av just den — en ny läsväg är en ny sak att granska.
 */

import { Prisma } from '@prisma/client'
import { SAFE_BANK_CONSENT_FIELDS, UNSAFE_BANK_CONSENT_FIELDS } from '@eken/shared'

import { SAFE_BANK_CONSENT_SELECT } from './psd2-consent.service'

/** Skalärkolumnerna på modellen, lästa ur schemat och inte uppräknade för hand. */
function modellensKolumner(): string[] {
  const modell = Prisma.dmmf.datamodel.models.find((m) => m.name === 'BankConsent')
  if (!modell) throw new Error('BankConsent saknas i Prismas DMMF — skanningen har gått blind.')
  return modell.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name)
}

describe('SAFE_BANK_CONSENT_SELECT — allow-list', () => {
  it('KANARIEFÅGEL: DMMF ger faktiska kolumner, inte en tom mängd', () => {
    // Utan den här raden är en partition över noll kolumner grön för alltid —
    // exakt den blindhet en tom mängd alltid ser ut som.
    const kolumner = modellensKolumner()
    expect(kolumner.length).toBeGreaterThanOrEqual(10)
    // Diskriminerande: en kolumn som BEVISLIGEN finns och som är hemlig.
    expect(kolumner).toContain('accessTokenEnc')
    // …och en som bevisligen finns och är säker.
    expect(kolumner).toContain('provider')
  })

  it('selectens nycklar är EXAKT den delade fältmängden', () => {
    expect(Object.keys(SAFE_BANK_CONSENT_SELECT).sort()).toEqual(
      [...SAFE_BANK_CONSENT_FIELDS].sort(),
    )
  })

  it('varje nyckel i selecten är satt till true — ingen halvvald kolumn', () => {
    for (const värde of Object.values(SAFE_BANK_CONSENT_SELECT)) {
      expect(värde).toBe(true)
    }
  })

  it('PARTITION: varje kolumn på BankConsent står i EXAKT en av de två mängderna', () => {
    const säkra = new Set<string>(SAFE_BANK_CONSENT_FIELDS)
    const osäkra = new Set<string>(UNSAFE_BANK_CONSENT_FIELDS)

    // Listorna asserteras som LISTOR, inte som antal: ett tal säger att något är
    // fel, medlemmarna säger vad. (Jests `expect` tar inget meddelandeargument —
    // det är vitest — så innehållet måste bäras av värdet självt.)
    const oklassade = modellensKolumner().filter((k) => !säkra.has(k) && !osäkra.has(k))
    expect(oklassade).toEqual([])

    const iBåda = [...säkra].filter((k) => osäkra.has(k))
    expect(iBåda).toEqual([])

    // Åt andra hållet: en mängd får inte bära ett namn som inte finns i schemat.
    // En kvittering av en kolumn som inte existerar skyddar inget men ser ut att
    // göra det — samma regel som history-registrets R3.
    const kolumner = new Set(modellensKolumner())
    const spöken = [...säkra, ...osäkra].filter((k) => !kolumner.has(k))
    expect(spöken).toEqual([])
  })

  it('inget känsligt fält (särskilt tokens) är med i allow-listen', () => {
    for (const f of UNSAFE_BANK_CONSENT_FIELDS) {
      expect(SAFE_BANK_CONSENT_SELECT).not.toHaveProperty(f)
    }
  })
})
