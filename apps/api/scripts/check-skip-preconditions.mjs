#!/usr/bin/env node
/**
 * CI-guard — en villkorlig överhoppning måste PRÖVA sin förutsättning i ett
 * block som ALLTID körs.
 *
 * ── FÖRHÅLLANDET TILL NOLL-KONTROLLEN ────────────────────────────────────────
 *
 * `check-no-skipped-tests.mjs` fångar ALLT: varje hoppat eller parkerat test,
 * oavsett mekanism och oavsett om någon tänkt på filen. Den är den bärande
 * kontrollen.
 *
 * Men den säger bara ETT TAL. "13 test hoppades över" berättar inte VILKEN
 * förutsättning som saknades — och det är just det man behöver veta klockan tre
 * på natten när CI blivit röd av att en tjänst inte startade.
 *
 * Den här regeln gör felet BEGRIPLIGT: villkorar en fil på `DATABASE_URL` ska
 * den också ha ett `expect(HAR_DB).toBe(true)` i ett block som alltid körs. Då
 * blir felet "sviten körs mot en RIKTIG databas" i stället för ett antal.
 *
 * Nollan fångar allt; den här gör utfallet läsbart. Den ena utan den andra är
 * antingen tyst eller obegriplig.
 *
 * ── VAD SOM RÄKNAS SOM VILLKORLIG ÖVERHOPPNING ───────────────────────────────
 *
 *     const beskriv = HAR_DB ? describe : describe.skip
 *
 * Alltså: `describe.skip` (eller `it.skip`) som VÄRDE i ett villkorsuttryck.
 * Ett rakt `describe.skip(...)`-ANROP är något annat — ett medvetet parkerat
 * block — och fälls redan av noll-kontrollen. Skillnaden är avsiktlig: den här
 * regeln handlar om FÖRUTSÄTTNINGAR, inte om parkerade tester.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  En fil med villkorlig överhoppning måste innehålla minst ett
 *     `expect(<villkorsvariabel>).toBe(true)`.
 * R2  Den assertionen måste ligga UTANFÖR varje villkorligt block. En
 *     förutsättningskontroll inuti det block den skyddar hoppas över precis när
 *     den behövs — det var defekten i ai-effect-extension.spec.ts (#562), och
 *     den upprepades i action-idempotency.spec.ts.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg.
 * Lokalt:      node apps/api/scripts/check-skip-preconditions.mjs
 * Självtest:   node apps/api/scripts/check-skip-preconditions.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** Alla spec-filer. */
export function specfiler(dir = SRC, ut = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) specfiler(p, ut)
    else if (e.name.endsWith('.spec.ts')) ut.push(p)
  }
  return ut
}

/**
 * Villkorsvariablerna i en fil: `const X = <villkor> ? describe : describe.skip`.
 *
 * Returnerar både aliaset (`beskriv`) och villkoret (`HAR_DB`) — aliaset för att
 * hitta de villkorliga blocken, villkoret för att veta vad som ska prövas.
 */
export function findConditionalSkips(text) {
  const re =
    /(?:const|let)\s+(\w+)\s*=\s*([\w.]+)\s*\?\s*(?:describe|it|test)\s*:\s*(?:describe|it|test)\.skip/g
  return [...text.matchAll(re)].map((m) => ({ alias: m[1], villkor: m[2] }))
}

/** Radintervall som ligger inuti ett villkorligt block (`alias(` … matchande `)`). */
export function conditionalRanges(text, alias) {
  const rader = text.split('\n')
  const intervall = []
  for (let i = 0; i < rader.length; i++) {
    if (!new RegExp(`(^|[^\\w.])${alias}\\s*\\(`).test(rader[i])) continue
    let djup = 0
    for (let j = i; j < rader.length; j++) {
      djup += (rader[j].match(/\(/g) ?? []).length - (rader[j].match(/\)/g) ?? []).length
      if (djup <= 0 && j > i) {
        intervall.push([i + 1, j + 1])
        i = j
        break
      }
    }
  }
  return intervall
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate(filer) {
  const problem = []
  let granskade = 0

  for (const { fil, text } of filer) {
    const villkor = findConditionalSkips(text)
    if (villkor.length === 0) continue
    granskade += 1

    const rader = text.split('\n')
    const intervall = villkor.flatMap((v) => conditionalRanges(text, v.alias))
    const inuti = (radnr) => intervall.some(([a, b]) => radnr >= a && radnr <= b)

    for (const v of villkor) {
      // R1 — finns assertionen alls?
      const re = new RegExp(`expect\\(\\s*${v.villkor}\\s*\\)\\s*\\.toBe\\(\\s*true\\s*\\)`)
      const träffar = rader
        .map((r, i) => (re.test(r) ? i + 1 : 0))
        .filter(Boolean)
      if (träffar.length === 0) {
        problem.push({
          fil,
          rule: `villkorar på \`${v.villkor}\` men prövar den aldrig`,
          detail:
            `Lägg ett \`expect(${v.villkor}).toBe(true)\` i ett block som ALLTID körs. ` +
            'Utan det hoppas sviten över TYST, och en hoppad svit är grön.',
        })
        continue
      }
      // R2 — ligger någon av dem utanför de villkorliga blocken?
      if (!träffar.some((r) => !inuti(r))) {
        problem.push({
          fil,
          line: träffar[0],
          rule: `prövar \`${v.villkor}\` bara INUTI ett villkorligt block`,
          detail:
            'Kontrollen hoppas då över precis när den behövs. Flytta den till ett block ' +
            'som alltid körs — det var defekten i ai-effect-extension.spec.ts (#562).',
        })
      }
    }
  }
  return { problem, granskade }
}

// ── självtest ────────────────────────────────────────────────────────────────
const UTAN_VILLKOR = { fil: 'a.spec.ts', text: "describe('x', () => { it('y', () => {}) })" }
const RÄTT = {
  fil: 'b.spec.ts',
  text: `const HAR_DB = Boolean(process.env.DATABASE_URL)
const beskriv = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('kanariefågel', () => {
    expect(HAR_DB).toBe(true)
  })
})

beskriv('mot databasen', () => {
  it('gör något', () => {})
})`,
}

function selfTest() {
  let ok = true
  const fail = (m) => {
    ok = false
    console.error(`❌ ${m}`)
  }
  const grön = (label, r) =>
    r.problem.length === 0
      ? console.log(`✅ inget falsklarm: ${label}`)
      : fail(`FALSKLARM: ${label} → ${r.problem[0].rule}`)
  const röd = (label, r, väntad) => {
    if (r.problem.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.problem.some((p) => p.rule.includes(väntad))) {
      return fail(`${label} fälldes av FEL regel: "${r.problem[0].rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r.problem[0].rule})`)
  }

  // ── KANARIEFÅGEL 1: mönsterläsningen måste ge utslag ─────────────────────
  const v = findConditionalSkips(RÄTT.text)
  if (v.length !== 1 || v[0].alias !== 'beskriv' || v[0].villkor !== 'HAR_DB') {
    fail(`kanariefågel: villkorsläsningen gav ${JSON.stringify(v)}, väntade beskriv/HAR_DB`)
  } else console.log('✅ kanariefågel: villkorsläsningen hittar alias och villkor i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ──────────────────────────────
  const riktiga = specfiler().map((p) => ({ fil: relative(SRC, p), text: readFileSync(p, 'utf8') }))
  const medVillkor = riktiga.filter((f) => findConditionalSkips(f.text).length > 0)
  if (medVillkor.length === 0) {
    fail('kanariefågel: NOLL villkorliga specar i den riktiga källan — skanningen har gått blind')
  } else {
    console.log(
      `✅ kanariefågel: ${medVillkor.length} villkorliga specar i den riktiga källan ` +
        `(${medVillkor.map((f) => f.fil.split('/').pop()).join(', ')})`,
    )
  }

  grön('fil utan villkorlig överhoppning', evaluate([UTAN_VILLKOR]))
  grön('fil som prövar förutsättningen utanför blocket', evaluate([RÄTT]))

  // ── R1 — DEFEKTEN I action-idempotency.spec.ts ──────────────────────────
  röd(
    'villkorar men prövar aldrig förutsättningen',
    evaluate([{ fil: 'c.spec.ts', text: RÄTT.text.replace(/describe\('förutsättningar'[\s\S]*?\}\)\n\n/, '') }]),
    'prövar den aldrig',
  )

  // ── R2 — DEFEKTEN I ai-effect-extension.spec.ts (#562) ──────────────────
  röd(
    'prövar förutsättningen INUTI det villkorliga blocket',
    evaluate([
      {
        fil: 'd.spec.ts',
        text: `const HAR_DB = Boolean(process.env.DATABASE_URL)
const beskriv = HAR_DB ? describe : describe.skip

beskriv('mot databasen', () => {
  it('kanariefågel', () => {
    expect(HAR_DB).toBe(true)
  })
})`,
      },
    ]),
    'bara INUTI ett villkorligt block',
  )

  // Två villkor i samma fil — båda måste prövas.
  röd(
    'två förutsättningar, bara den ena prövad',
    evaluate([
      {
        fil: 'e.spec.ts',
        text: `const HAR_DB = Boolean(process.env.DATABASE_URL)
const HAR_REDIS = Boolean(process.env.REDIS_URL)
const medDb = HAR_DB ? describe : describe.skip
const medRedis = HAR_REDIS ? describe : describe.skip

describe('förutsättningar', () => {
  it('c', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('a', () => {})
medRedis('b', () => {})`,
      },
    ]),
    'HAR_REDIS',
  )

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const filer = specfiler().map((p) => ({ fil: relative(SRC, p), text: readFileSync(p, 'utf8') }))
  if (filer.length === 0) {
    console.error('❌ NOLL spec-filer hittades — skanningen har gått blind.')
    process.exit(1)
  }
  const { problem, granskade } = evaluate(filer)

  if (problem.length > 0) {
    console.error('\n=== VILLKORLIG ÖVERHOPPNING UTAN PRÖVAD FÖRUTSÄTTNING (CI-guard) ===\n')
    for (const p of problem) {
      console.error(`❌ src/${p.fil}${p.line ? `:${p.line}` : ''}\n   ${p.rule}\n   ${p.detail}`)
    }
    console.error(
      '\nRegeln: nollkontrollen fångar ATT något hoppades över. Den här gör felet\n' +
        'begripligt — man ska få veta VILKEN förutsättning som saknades.\n',
    )
    process.exit(1)
  }
  console.log(
    `✅ ${granskade} spec-fil(er) med villkorlig överhoppning — alla prövar sin förutsättning ` +
      'i ett block som alltid körs.',
  )
}

main()
