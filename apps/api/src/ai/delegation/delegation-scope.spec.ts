import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { delegerbaraVerktyg, kräverFrekvensvillkor, prövaDelegerbarhet } from './delegation-scope'
import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'

import type { EffectDeclaration } from '../tools/effect-idempotency'

/**
 * TJÄNSTENS MÄNGD ÄR EXAKT VAKTENS.
 *
 * ── VARFÖR TVÅ UPPRÄKNINGAR ─────────────────────────────────────────────────
 *
 * `delegation-scope.ts` räknar upp mängden ur den IMPORTERADE katalogen; vakten
 * räknar upp den ur KÄLLTEXTEN. Två vägar till samma svar, och skillnaden mellan
 * dem är det enda som fångar att någon lagt ett undantag i tjänsten — en
 * jämförelse mot sig själv hade varit grön för allt.
 *
 * Det är samma form som `VALIDATED_ENV_VARS`: två uppräkningar som ska vara lika
 * är inte en uppräkning.
 */
const MANIFEST = join(__dirname, '..', '..', '..', 'scripts', 'tool-outward-capabilities.json')

/**
 * Vaktens uppräkning — hämtad genom att KÖRA vakten, inte importera den.
 *
 * `check-delegation-scope.mjs` är ESM och jest kan inte `require` den. Att köra
 * den som en subprocess är dessutom det ärligare valet: uppräkningarna blir då
 * oberoende hela vägen — egen process, egen parser, egen läsning av källtexten —
 * och provet bevisar på köpet att vakten faktiskt går att köra.
 *
 * `--lista` skriver mängden på stdout, ett namn per rad. Att i stället parsa
 * vaktens prosarad hade gjort provet rött av ett tankstreck.
 */
function mangdFranVakten(): string[] {
  const ut = execFileSync(
    process.execPath,
    [join(__dirname, '..', '..', '..', 'scripts', 'check-delegation-scope.mjs'), '--lista'],
    { encoding: 'utf8' },
  )
  return `${ut}`
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
    .sort()
}

describe('delegerbarhetens mängd', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    verktyg: Record<string, unknown>
  }

  it('tjänstens mängd är EXAKT vaktens — namn för namn, inte antal', () => {
    const frånTjänsten = delegerbaraVerktyg(undefined, manifest.verktyg)
    const frånVakten = mangdFranVakten()
    // Namn, aldrig bara antal: en falsk positiv och en falsk negativ tar ut
    // varandra i en summa, och då ser siffran bekräftad ut medan listan är fel.
    expect(frånTjänsten).toEqual(frånVakten)
  })

  it('KANARIEFÅGEL: mängden är varken tom eller allt', () => {
    const dugliga = delegerbaraVerktyg(undefined, manifest.verktyg)
    const alla = Object.keys(EFFECT_DECLARATIONS)

    console.warn(`[delegation] ${dugliga.length} av ${alla.length}: ${dugliga.join(', ')}`)
    expect(dugliga.length).toBeGreaterThan(0)
    expect(dugliga.length).toBeLessThan(alla.length)
  })

  it('export_sie4 är ALLOWLISTAD men INTE delegerbar — det fjärde villkoret', () => {
    // Skillnaden mellan de två fälten, i ett enda verktyg: `agentAllowlist`
    // svarar "får en agent göra detta obevakat" (ja), det fjärde villkoret
    // svarar "finns det något att delegera" (nej — den bygger en buffert).
    expect(EFFECT_DECLARATIONS['export_sie4']?.agentAllowlist).toBe(true)
    const r = prövaDelegerbarhet('export_sie4', undefined, manifest.verktyg)
    expect(r.delegerbar).toBe(false)
    if (!r.delegerbar) expect(r.skäl).toBe('INGEN_EFFEKT')
  })

  it('varje delegerbart verktyg uppfyller alla fyra villkoren', () => {
    for (const n of delegerbaraVerktyg(undefined, manifest.verktyg)) {
      const d = EFFECT_DECLARATIONS[n]!
      expect(d.agentAllowlist).toBe(true)
      expect(d.authorityScope).toBe('EGEN_ORG')
      expect(Object.keys(manifest.verktyg[n] ?? {})).toEqual([])
      expect(d.supportsUndo.kind).not.toBe('INGEN_EFFEKT')
    }
  })
})

describe('reglerna var för sig, mot påhittade deklarationer', () => {
  const bas = EFFECT_DECLARATIONS['create_property']!
  const med = (över: Partial<EffectDeclaration>): Record<string, EffectDeclaration> => ({
    zz_delegationssond: { ...bas, ...över },
  })

  it('baslinjen är delegerbar', () => {
    expect(prövaDelegerbarhet('zz_delegationssond', med({})).delegerbar).toBe(true)
  })

  it.each([
    ['agentAllowlist: false', { agentAllowlist: false }, 'EJ_ALLOWLISTAD'],
    ['MOT_HYRESGAST', { authorityScope: 'MOT_HYRESGAST' as const }, 'FEL_SCOPE'],
    ['MOT_TREDJE_PART', { authorityScope: 'MOT_TREDJE_PART' as const }, 'FEL_SCOPE'],
    ['INGEN_EFFEKT', { supportsUndo: { kind: 'INGEN_EFFEKT' as const } }, 'INGEN_EFFEKT'],
  ])('%s → inte delegerbar', (_namn, över, skäl) => {
    const r = prövaDelegerbarhet('zz_delegationssond', med(över as Partial<EffectDeclaration>))
    expect(r.delegerbar).toBe(false)
    if (!r.delegerbar) expect(r.skäl).toBe(skäl)
  })

  it('en sänka i vakt 7:s manifest → inte delegerbar', () => {
    const r = prövaDelegerbarhet('zz_delegationssond', med({}), {
      zz_delegationssond: { MAIL: ['x.y'] },
    })
    expect(r.delegerbar).toBe(false)
    if (!r.delegerbar) expect(r.skäl).toBe('UTÅTRIKTAD')
  })

  it('okänt verktyg → inte delegerbar', () => {
    expect(prövaDelegerbarhet('finns_inte').delegerbar).toBe(false)
  })
})

describe('frekvensvillkoret', () => {
  it('DEDUPLICERBAR kräver ett tak, IDEMPOTENT gör det inte', () => {
    // Skillnaden är mätt och inte antagen: en DEDUPLICERBAR omkörning ger en
    // ANDRA rad, en IDEMPOTENT ger samma tillstånd.
    const dedup = Object.entries(EFFECT_DECLARATIONS)
      .filter(([, d]) => d.effectIdempotency === 'DEDUPLICERBAR')
      .map(([n]) => n)
    expect(dedup.length).toBeGreaterThan(0)
    for (const n of dedup) expect(kräverFrekvensvillkor(n)).toBe(true)

    const idem = Object.entries(EFFECT_DECLARATIONS)
      .filter(([, d]) => d.effectIdempotency === 'IDEMPOTENT')
      .map(([n]) => n)
    for (const n of idem) expect(kräverFrekvensvillkor(n)).toBe(false)
  })

  it('tre av de åtta delegerbara kräver ett tak', () => {
    // Talet står i provet och inte bara i prosan: ändras klassificeringen ska
    // det här falla tills någon läst om varför.
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      verktyg: Record<string, unknown>
    }
    const medTak = delegerbaraVerktyg(undefined, manifest.verktyg).filter((n) =>
      kräverFrekvensvillkor(n),
    )
    expect(medTak).toEqual(['create_inspection', 'create_invoice', 'create_maintenance_ticket'])
  })
})
