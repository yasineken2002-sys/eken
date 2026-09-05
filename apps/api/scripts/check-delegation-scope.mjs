#!/usr/bin/env node
/**
 * CI-VAKT — EN DELEGATION FÅR BARA FINNAS FÖR ETT DELEGERBART VERKTYG.
 *
 * ── DEFEKTEN DEN FINNS FÖR ──────────────────────────────────────────────────
 *
 * En delegation är en STÅENDE rätt: agenten får utföra verktyget utan ett ja per
 * handling, tills någon återkallar den. Ges den för fel verktyg är felet inte en
 * enskild dålig handling utan en pågående behörighet — och den syns inte i något
 * test, eftersom ingenting går sönder. Den bara gäller.
 *
 * Planens Del 6 är uttrycklig: **"Aldrig delegerbart: allt klassat som
 * utåtriktat."**
 *
 * ── REGLERNA ────────────────────────────────────────────────────────────────
 *
 * R1  Tjänstens mängd är EXAKT den härledda. `delegation-scope.ts` räknar upp
 *     mängden ur katalogen; vakten räknar upp den en gång till, oberoende, och
 *     kräver att de är lika. Två uppräkningar som ska vara lika är inte en
 *     uppräkning — men skillnaden mellan dem är det enda som fångar att någon
 *     lagt till ett undantag i tjänsten.
 *
 * R2  Varje delegerbart verktyg uppfyller ALLA FYRA villkoren, prövade var för
 *     sig här och inte bara genom tjänstens svar:
 *       agentAllowlist === true
 *       authorityScope === 'EGEN_ORG'
 *       inga sänkor i tool-outward-capabilities.json
 *       supportsUndo.kind !== 'INGEN_EFFEKT'
 *
 * R3  OMFÅNG. Mängderna får inte vara tomma, och den delegerbara mängden får
 *     inte vara HELA katalogen. Båda ytterligheterna är gröna för de andra
 *     reglerna och mäter ingenting.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Att en delegation i DATABASEN pekar på ett verktyg som sedan slutat vara
 * delegerbart. Vakten läser kod, inte rader. Den grinden ägs av
 * `assertDelegated`, som prövar delegerbarheten FÖRE uppslaget just därför —
 * en rad som blivit ogiltig av en katalogändring nekas även om den finns kvar.
 * Det är prövat i `delegation.db.spec.ts`, inte här.
 *
 * Lokalt:    node apps/api/scripts/check-delegation-scope.mjs
 * Självtest: node apps/api/scripts/check-delegation-scope.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const DEKLARATIONER = join(SRC, 'ai', 'tools', 'effect-idempotency.ts')
const SCOPE_MODUL = join(SRC, 'ai', 'delegation', 'delegation-scope.ts')
const MANIFEST = join(HERE, 'tool-outward-capabilities.json')

/** Balanserad klammermatchning från index `i`, där `{` står. */
export function block(text, i) {
  if (text[i] !== '{') return null
  let d = 0
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') d++
    else if (text[j] === '}') {
      d--
      if (d === 0) return [i, j + 1]
    }
  }
  return null
}

/**
 * Deklarationerna, med de fyra fält reglerna behöver.
 *
 * `blankComments` och inte `codeMask`: värdena är STRÄNGAR (`'EGEN_ORG'`,
 * `kind: 'INGEN_EFFEKT'`), och `codeMask` blankar just stränginnehåll. En vy per
 * fråga.
 */
export function parseDeklarationer(rå) {
  const text = blankComments(rå)
  const i = text.indexOf('EFFECT_DECLARATIONS')
  if (i === -1) return new Map()
  const yttre = block(text, text.indexOf('{', i))
  if (!yttre) return new Map()
  const kropp = text.slice(yttre[0], yttre[1])
  const ut = new Map()
  const nyckel = /(^|\n)\s{2}([\p{Ll}\p{N}_]+):\s*\{/gu
  let m
  while ((m = nyckel.exec(kropp)) !== null) {
    const b = block(kropp, m.index + m[0].length - 1)
    if (!b) continue
    const p = kropp.slice(b[0], b[1])
    ut.set(m[2], {
      agentAllowlist: /agentAllowlist:\s*true/.test(p),
      authorityScope: (p.match(/authorityScope:\s*'([\p{Lu}_ÅÄÖ]+)'/u) ?? [])[1] ?? null,
      undoKind: (p.match(/supportsUndo:\s*\{[^}]*kind:\s*'([\p{Lu}_ÅÄÖ]+)'/u) ?? [])[1] ?? null,
    })
    nyckel.lastIndex = b[1]
  }
  return ut
}

/**
 * Vakten räknar upp mängden EN GÅNG TILL, oberoende av tjänsten.
 *
 * Det är avsiktligt en andra uppräkning: importerade vi tjänstens funktion hade
 * R1 jämfört en lista med sig själv, och det som faktiskt ska fångas — att någon
 * lagt ett undantag i tjänsten — hade blivit osynligt.
 */
export function härleddMängd(deklarationer, manifest) {
  const ut = []
  for (const [namn, d] of deklarationer) {
    if (!d.agentAllowlist) continue
    if (d.authorityScope !== 'EGEN_ORG') continue
    if (Object.keys(manifest.verktyg?.[namn] ?? {}).length > 0) continue
    if (d.undoKind === 'INGEN_EFFEKT') continue
    ut.push(namn)
  }
  return ut.sort()
}

/**
 * Tjänstens villkor, lästa som KOD ur `delegation-scope.ts`.
 *
 * Vakten kan inte köra tjänsten (den drar in halva Nest-grafen), så den läser
 * att de fyra villkoren FINNS i funktionen. Det är en kopplingskontroll och inte
 * en beteendekontroll — vad de gör ägs av `delegation-scope.spec.ts`, och den
 * gränsen står här så att grönt inte läses som mer än det är.
 */
export function villkorITjänsten(rå) {
  const kod = codeMask(rå)
  return {
    allowlist: /agentAllowlist/.test(kod),
    scope: /authorityScope\s*!==/.test(kod),
    sänkor: /sänkor\.length\s*>\s*0/.test(kod),
    ingenEffekt: /supportsUndo\?\.kind\s*===/.test(kod),
  }
}

export function evaluate({ deklarationer, manifest, scopeKälla, tjänstensMängd }) {
  const problem = []
  const härledd = härleddMängd(deklarationer, manifest)

  // ── R3 OMFÅNG ─────────────────────────────────────────────────────────────
  if (deklarationer.size === 0)
    problem.push({ regel: 'R3', detalj: 'NOLL deklarationer lästes — svepet har gått blint.' })
  if (härledd.length === 0)
    problem.push({
      regel: 'R3',
      detalj:
        'NOLL delegerbara verktyg härleddes. Kodbasen HAR delegerbara verktyg — en tom ' +
        'mängd betyder att uppräkningen slutat läsa, inte att inget får delegeras.',
    })
  if (deklarationer.size > 0 && härledd.length === deklarationer.size)
    problem.push({
      regel: 'R3',
      detalj:
        'ALLA verktyg räknas som delegerbara. Villkoren fäller då ingenting, och regeln ' +
        'är grön för allt.',
    })

  // ── R2 VILLKOREN, PRÖVADE VAR FÖR SIG ─────────────────────────────────────
  for (const namn of härledd) {
    const d = deklarationer.get(namn)
    if (!d.agentAllowlist)
      problem.push({ regel: 'R2', detalj: `\`${namn}\` är delegerbar utan agentAllowlist.` })
    if (d.authorityScope !== 'EGEN_ORG')
      problem.push({
        regel: 'R2',
        detalj: `\`${namn}\` är delegerbar med authorityScope: ${d.authorityScope}.`,
      })
    const sänkor = Object.keys(manifest.verktyg?.[namn] ?? {})
    if (sänkor.length > 0)
      problem.push({
        regel: 'R2',
        detalj:
          `\`${namn}\` är delegerbar men når ${sänkor.join(', ')}. Planens Del 6: aldrig ` +
          'delegerbart, allt klassat som utåtriktat.',
      })
    if (d.undoKind === 'INGEN_EFFEKT')
      problem.push({
        regel: 'R2',
        detalj: `\`${namn}\` är delegerbar utan effekt att delegera.`,
      })
  }

  // ── R1 TJÄNSTENS MÄNGD ÄR EXAKT DEN HÄRLEDDA ──────────────────────────────
  if (tjänstensMängd) {
    const extra = tjänstensMängd.filter((n) => !härledd.includes(n))
    const saknade = härledd.filter((n) => !tjänstensMängd.includes(n))
    for (const n of extra)
      problem.push({
        regel: 'R1',
        detalj:
          `Tjänsten säger att \`${n}\` är delegerbart, men de fyra villkoren gör den inte ` +
          'det. En stående rätt för fel verktyg går inte sönder — den bara gäller.',
      })
    for (const n of saknade)
      problem.push({
        regel: 'R1',
        detalj: `\`${n}\` uppfyller villkoren men saknas i tjänstens mängd.`,
      })
  }

  // Kopplingen: de fyra villkoren finns i modulen.
  const v = villkorITjänsten(scopeKälla)
  for (const [nyckel, finns] of Object.entries(v)) {
    if (!finns)
      problem.push({
        regel: 'R1',
        detalj: `Villkoret "${nyckel}" finns inte längre i delegation-scope.ts som KOD.`,
      })
  }

  return { problem, härledd }
}

// ── körning ─────────────────────────────────────────────────────────────────

function kör() {
  const deklarationer = parseDeklarationer(readFileSync(DEKLARATIONER, 'utf8'))
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const scopeKälla = readFileSync(SCOPE_MODUL, 'utf8')
  const { problem, härledd } = evaluate({ deklarationer, manifest, scopeKälla })

  if (problem.length > 0) {
    console.error('\n=== DELEGATIONENS OMFÅNG STÄMMER INTE (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.regel}\n   ${p.detalj}\n`)
    console.error(
      'En delegation är en STÅENDE rätt. Ges den för fel verktyg går ingenting\n' +
        'sönder — den bara gäller, tills någon återkallar den.\n',
    )
    process.exit(1)
  }
  console.warn(
    `✅ ${härledd.length} av ${deklarationer.size} verktyg är delegerbara — ${härledd.join(', ')}.`,
  )
}

// ── självtest ───────────────────────────────────────────────────────────────

const FIXTUR = `export const EFFECT_DECLARATIONS = {
  ren_intern: {
    effectIdempotency: 'IDEMPOTENT',
    agentAllowlist: true,
    authorityScope: 'EGEN_ORG',
    supportsUndo: { kind: 'VÄG', fil: 'x/x.ts', symbol: 'y' },
  },
  utan_effekt: {
    effectIdempotency: 'IDEMPOTENT',
    agentAllowlist: true,
    authorityScope: 'EGEN_ORG',
    supportsUndo: { kind: 'INGEN_EFFEKT' },
  },
  mot_hyresgast: {
    effectIdempotency: 'IDEMPOTENT',
    agentAllowlist: false,
    authorityScope: 'MOT_HYRESGAST',
    supportsUndo: { kind: 'VÄG', fil: 'x/x.ts', symbol: 'y' },
  },
  mejlare: {
    effectIdempotency: 'IDEMPOTENT',
    agentAllowlist: true,
    authorityScope: 'EGEN_ORG',
    supportsUndo: { kind: 'VÄG', fil: 'x/x.ts', symbol: 'y' },
  },
}
`
const SCOPE_FIXTUR = `
export function prövaDelegerbarhet(n, d, s) {
  if (!d[n].agentAllowlist) return false
  if (d[n].authorityScope !== 'EGEN_ORG') return false
  const sänkor = Object.keys(s[n] ?? {})
  if (sänkor.length > 0) return false
  if (d[n].supportsUndo?.kind === 'INGEN_EFFEKT') return false
  return true
}
`

function selfTest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`  ${ok ? '✅' : '❌'} ${namn}${extra ? ` — ${extra}` : ''}`)
    if (!ok) fel++
  }

  const dekl = parseDeklarationer(FIXTUR)
  const manifest = { verktyg: { mejlare: { MAIL: ['x.y'] } } }
  const bas = (över = {}) => ({
    deklarationer: dekl,
    manifest,
    scopeKälla: SCOPE_FIXTUR,
    ...över,
  })

  t('parsern läser alla fyra posterna', dekl.size === 4, `${dekl.size}`)
  t('parsern läser supportsUndo.kind ur strängen',
    dekl.get('utan_effekt').undoKind === 'INGEN_EFFEKT', dekl.get('utan_effekt').undoKind)

  {
    const r = evaluate(bas())
    t('BASLINJE: bara `ren_intern` är delegerbar', r.härledd.join() === 'ren_intern', r.härledd.join())
    t('BASLINJE: inga fynd', r.problem.length === 0, JSON.stringify(r.problem))
  }

  // ── R1: ETT UTÅTRIKTAT VERKTYG I TJÄNSTENS LISTA → RÖTT ──────────────────
  {
    const r = evaluate(bas({ tjänstensMängd: ['ren_intern', 'mejlare'] }))
    t('R1 KANARIE: ett UTÅTRIKTAT verktyg i tjänstens lista → RÖTT',
      r.problem.some((p) => p.regel === 'R1' && p.detalj.includes('mejlare')),
      JSON.stringify(r.problem.map((p) => p.detalj.slice(0, 40))))
  }
  {
    const r = evaluate(bas({ tjänstensMängd: ['ren_intern', 'utan_effekt'] }))
    t('R1 KANARIE: ett verktyg UTAN EFFEKT i tjänstens lista → RÖTT',
      r.problem.some((p) => p.regel === 'R1' && p.detalj.includes('utan_effekt')))
  }
  {
    const r = evaluate(bas({ tjänstensMängd: [] }))
    t('R1 KANARIE: ett delegerbart verktyg SAKNAS i tjänsten → RÖTT',
      r.problem.some((p) => p.regel === 'R1' && p.detalj.includes('saknas i tjänstens mängd')))
  }
  {
    const r = evaluate(bas({ tjänstensMängd: ['ren_intern'] }))
    t('R1 MOTPROV: exakt rätt mängd → TYST', r.problem.length === 0, JSON.stringify(r.problem))
  }

  // ── R1: ETT BORTTAGET VILLKOR I MODULEN → RÖTT ───────────────────────────
  {
    const utan = SCOPE_FIXTUR.replace(/if \(d\[n\]\.supportsUndo\?\.kind === 'INGEN_EFFEKT'\) return false/, '')
    const r = evaluate(bas({ scopeKälla: utan }))
    t('R1 KANARIE: villkoret om INGEN_EFFEKT borttaget ur modulen → RÖTT',
      r.problem.some((p) => p.detalj.includes('ingenEffekt')),
      JSON.stringify(r.problem.map((p) => p.detalj.slice(0, 40))))
  }
  {
    // KOD, INTE PROSA: villkoret bara i en kommentar duger inte.
    const prosa = SCOPE_FIXTUR.replace(
      /if \(d\[n\]\.supportsUndo\?\.kind === 'INGEN_EFFEKT'\) return false/,
      "// d[n].supportsUndo?.kind === 'INGEN_EFFEKT' — beskrivet men inte gjort",
    )
    const r = evaluate(bas({ scopeKälla: prosa }))
    t('R1 KOMMENTARKANARIE: villkoret bara i en KOMMENTAR → fortfarande RÖTT',
      r.problem.some((p) => p.detalj.includes('ingenEffekt')))
  }

  // ── R3 OMFÅNG ────────────────────────────────────────────────────────────
  t('R3: tom deklarationsmängd → RÖTT',
    evaluate(bas({ deklarationer: new Map() })).problem.some((p) => p.regel === 'R3'))
  {
    // Alla delegerbara: villkoren fäller ingenting.
    const alla = parseDeklarationer(FIXTUR.replace(/agentAllowlist: false/g, 'agentAllowlist: true')
      .replace(/authorityScope: 'MOT_HYRESGAST'/g, "authorityScope: 'EGEN_ORG'")
      .replace(/supportsUndo: \{ kind: 'INGEN_EFFEKT' \}/g, "supportsUndo: { kind: 'VÄG' }"))
    const r = evaluate({ deklarationer: alla, manifest: { verktyg: {} }, scopeKälla: SCOPE_FIXTUR })
    t('R3: ALLA verktyg delegerbara → RÖTT',
      r.problem.some((p) => p.regel === 'R3' && p.detalj.includes('ALLA')),
      `${r.härledd.length}/${alla.size}`)
  }

  // ── DEN DELADE KÄLLSKANNERNS EGNA KANARIEFÅGLAR ──────────────────────────
  for (const f of kanariefåglar()) {
    fel++
    console.error(`  ❌ delad källskanner: ${f}`)
  }

  if (fel > 0) {
    console.error(`\nSJÄLVTEST: ${fel} kontroll(er) FÖLL.\n`)
    process.exit(1)
  }
  console.warn('\n✅ Självtest grönt — R1:s fyra kanariefåglar, kommentarkanariefågeln och R3 fäller alla.\n')
}

/**
 * `--lista` — mängden på STDOUT, ett namn per rad.
 *
 * Finns för `delegation-scope.spec.ts`, som jämför tjänstens mängd med vaktens.
 * Specen skulle annars ha fått parsa vaktens prosarad, och den är skör: ett
 * tankstreck, en punkt eller en omformulering hade gjort provet rött av fel
 * skäl. En maskinläsbar utdata är billigare än ett prov som mäter formatering.
 *
 * STDOUT och inte stderr, till skillnad från vaktens vanliga utskrifter — det är
 * hela poängen med flaggan.
 */
function lista() {
  const deklarationer = parseDeklarationer(readFileSync(DEKLARATIONER, 'utf8'))
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  for (const n of härleddMängd(deklarationer, manifest)) process.stdout.write(`${n}\n`)
}

// ── main ────────────────────────────────────────────────────────────────────
const ÄR_PROGRAM = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (ÄR_PROGRAM) {
  if (process.argv.includes('--self-test')) selfTest()
  else if (process.argv.includes('--lista')) lista()
  else kör()
}
