/**
 * TENANT_CREDENTIAL_KEYS SKA VARA FULLSTÄNDIG — och en enda lista.
 *
 * Listan fanns i två kopior och hade divergerat: portalkopian
 * (`tenant-auth.service.ts`) saknade `personalNumberEnc` och
 * `personalNumberHash`, som lades till i tenants-kopian när personnumret
 * krypterades utan att portalkopian följde med. Ingen bevakning jämförde dem.
 *
 * Det var inte en läcka men en LATENT sådan: `createSession` bygger sitt svar
 * från en bar `include` — alla skalärer — och strippade fem av sju. Att det inte
 * syntes berodde på att alla tre anropsställena råkade gå genom `tenantSummary`,
 * en allow-list med fem fält. En ofullständig blocklist maskerad av en allow-list.
 *
 * ── Vad testet bevakar, och vad det INTE gör ────────────────────────────────
 *
 * Det bevakar att listan är FULLSTÄNDIG: varje kolumn i Tenant-modellen som ser
 * credential-bärande ut måste stå i den, annars rött. Läggs `mfaSecret` till i
 * schemat faller testet tills någon klassat kolumnen.
 *
 * Det bevakar INTE att listan TILLÄMPAS. En komplett lista som en väg går runt
 * är fortfarande en läcka — och det är exakt B1-misstaget. Den halvan kan ett
 * namnbaserat test inte nå; den bärs av typspärren (#445, PR 2).
 *
 * Testet läser schemat, inte ett attrapp-svar — samma skäl som i
 * organization-select.spec.ts och invoice-bank-transaction-select.spec.ts.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { skaläraKolumner } from '../common/testing/schema-columns'
import { TENANT_CREDENTIAL_KEYS, stripTenantCredentialKeys } from './tenant-credential-keys'

const SRC = join(__dirname, '..')

/**
 * Formen på en kolumn som bär en hemlighet. Mönster, inte uppräkning — en
 * uppräkning hade haft exakt samma lucka som den lista den bevakar.
 *
 * `Enc` = chiffertext, `Hash` = hash eller blind-index, `Token`/`password` =
 * autentiseringsmaterial. `ExpiresAt`-kolumnerna hör till sina tokens: de röjer
 * inget själva, men strippas med dem eftersom en halvt struken token-triplett är
 * svårare att resonera om än en helt struken.
 */
const CREDENTIAL_FORM = /(hash|token|password|secret|salt)|enc$/i

/**
 * Kolumner som MATCHAR mönstret men INTE är credentials, med skälet.
 *
 * Tom idag. Formen finns för att en framtida kolumn — säg `tokenCount` — ska
 * kunna avfärdas med ett skrivet påstående i stället för genom att mönstret
 * luckras upp tills det slutar fånga något.
 */
const MATCHAR_MEN_INTE_CREDENTIAL: Record<string, string> = {}

describe('TENANT_CREDENTIAL_KEYS', () => {
  const lista = [...TENANT_CREDENTIAL_KEYS] as string[]

  it('täcker varje credential-bärande kolumn i Tenant-modellen', () => {
    const kolumner = skaläraKolumner('Tenant')
    // Golv mot en parser som slutat hitta fält — annars vore "inga saknade"
    // tomt-mängd-sant. Jfr #273:s rimlighetsgolv.
    expect(kolumner.length).toBeGreaterThanOrEqual(25)

    const misstänkta = kolumner.filter((k) => CREDENTIAL_FORM.test(k))
    // Golv nummer två: matchar mönstret ingenting har det slutat gälla schemat.
    expect(misstänkta.length).toBeGreaterThanOrEqual(7)

    const saknade = misstänkta.filter(
      (k) => !lista.includes(k) && !(k in MATCHAR_MEN_INTE_CREDENTIAL),
    )
    expect(saknade).toEqual([])
  })

  it('innehåller inga kolumner som inte längre finns i schemat', () => {
    // En post för en borttagen kolumn är en inaktuell text som döljer nästa
    // riktiga fråga — samma skäl som `declared` i authz-surfacens driftkontroll.
    const kolumner = skaläraKolumner('Tenant')
    const föråldrade = lista.filter((k) => !kolumner.includes(k))
    expect(föråldrade).toEqual([])
  })

  it('strippar faktiskt varje nyckel i listan', () => {
    // Konstanten och funktionen kan drifta isär: en nyckel läggs till i listan
    // men loopen råkar iterera över något annat. Billig kontroll, äkta risk.
    const objekt = Object.fromEntries([
      ...lista.map((k) => [k, 'HEMLIGT']),
      ['id', 't-1'],
      ['email', 'a@b.se'],
    ]) as Record<string, unknown>

    const strippat = stripTenantCredentialKeys(objekt)

    for (const k of lista) expect(strippat).not.toHaveProperty(k)
    expect(strippat['id']).toBe('t-1')
    expect(strippat['email']).toBe('a@b.se')
    // Muterar inte indata — anroparen får inte tappa fält den behöver.
    expect(objekt['passwordHash']).toBe('HEMLIGT')
  })

  it('listan finns bara på ETT ställe i kodbasen', () => {
    // Kärnan i det här arbetet. Två kopior hade divergerat i månader utan att
    // någon bevakning såg det; en tredje kopia ska falla direkt.
    const träffar: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
          const src = readFileSync(p, 'utf8')
          if (/const\s+TENANT_CREDENTIAL_KEYS\s*=\s*\[/.test(src)) träffar.push(p)
        }
      }
    }
    walk(SRC)
    expect(träffar.map((t) => t.replace(SRC, ''))).toEqual(['/tenants/tenant-credential-keys.ts'])
  })
})
