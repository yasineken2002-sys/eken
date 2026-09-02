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
 * ── ALLA TRE FRÅGORNA STÄLLS MOT KOD ────────────────────────────────────────
 *
 * Vakten läste råtexten, och gjorde det på det värsta stället: den räknade
 * `(` och `)` per rad för att hitta blockslutet. Ett `')'` i en stränglitteral
 * — `it("stänger )", …)` — flyttade blockgränsen, och R2:s fråga "ligger
 * assertionen utanför blocket" besvarades mot ett felaktigt intervall.
 *
 * Värre ändå för R1: `expect(HAR_DB).toBe(true)` söktes i råtext, så en
 * UTKOMMENTERAD assertion uppfyllde kravet. Det är formen "en regel som frågar
 * prosa i stället för kod är alltid uppfylld" — och en fil vars enda
 * förutsättningskontroll är bortkommenterad är precis den defekt regeln finns
 * för.
 *
 * Alla tre — villkorsläsningen, parentesmatchningen och assertionen — går nu på
 * `codeMask(text)` ur scripts/lib/source-scan.mjs. Masken bevarar längd och
 * radbrytningar, så radnumren pekar fortfarande på råfilen, och den behåller
 * avgränsarna så parentesmatchningen fortfarande har något att räkna.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg.
 * Lokalt:      node apps/api/scripts/check-skip-preconditions.mjs
 * Självtest:   node apps/api/scripts/check-skip-preconditions.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, kanariefåglar, KANARIEFÅGEL_LÄGEN } from '../../../scripts/lib/source-scan.mjs'

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
 * IDENTIFIERARE ÄR UNICODE, INTE `\w` (#668, samma form som #640).
 *
 * `\w` är ASCII. En villkorsvariabel som heter `körsMedDb` eller ett villkor som
 * heter `HÄR_FINNS_DB` hade inte härletts alls — och utfallet är TYSTNAD: filen
 * hade sett ut att sakna villkorlig överhoppning, och vakten förblivit grön om en
 * spec vars förutsättning aldrig prövas.
 *
 * ── MÄTT FÖRE FIXEN, OCH SVARET VAR NOLL ────────────────────────────────────
 *
 * Alla villkorliga skips i `apps/api/src` räknades med både ASCII- och
 * unicode-formen: 35 mot 35, noll missade. Aliasen är `medDb` (32), `beskriv` (2)
 * och `medRedis` (1); villkoren `HAR_DB` (34) och `HAR_REDIS` (1).
 *
 * Vakten var alltså SÅRBAR men inte BLIND — och den skillnaden ska stå, eftersom
 * rangordningen i #668 gissade motsatsen. Konventionen ÄR svensk (`beskriv`,
 * `medDb`), orden råkar bara sakna å/ä/ö. Den här ändringen är en härdning, inte
 * en lagning av något som läckte.
 */
const IDENT = '[\\p{L}\\p{N}_$]+'
const IDENT_PUNKT = '[\\p{L}\\p{N}_$.]+'

/**
 * Villkorsvariablerna i en fil: `const X = <villkor> ? describe : describe.skip`.
 *
 * Returnerar både aliaset (`beskriv`) och villkoret (`HAR_DB`) — aliaset för att
 * hitta de villkorliga blocken, villkoret för att veta vad som ska prövas.
 */
export function findConditionalSkips(text) {
  const re = new RegExp(
    `(?:const|let)\\s+(${IDENT})\\s*=\\s*(${IDENT_PUNKT})\\s*\\?\\s*(?:describe|it|test)\\s*:\\s*(?:describe|it|test)\\.skip`,
    'gu',
  )
  return [...codeMask(text).matchAll(re)].map((m) => ({ alias: m[1], villkor: m[2] }))
}

/**
 * Radintervall som ligger inuti ett villkorligt block (`alias(` … matchande `)`).
 *
 * Räknar parenteser i `codeMask` — där är stränginnehåll blankat men
 * avgränsarna kvar, så ett `')'` i en testtitel inte längre kan stänga blocket
 * för tidigt. Att räkna parenteser i en MASKERAD källa är vad codeMask finns
 * till för; att göra det i råtext är att skriva sin egen förbehandlare.
 */
export function conditionalRanges(text, alias) {
  const rader = codeMask(text).split('\n')
  const intervall = []
  for (let i = 0; i < rader.length; i++) {
    // GRÄNSEN ÄR OCKSÅ UNICODE (#668). `[^\w.]` räknar å, ä och ö som
    // ICKE-ordtecken, så ett alias kunde matcha INUTI en längre identifierare så
    // fort tecknet före var svenskt — `ömedDb(` hade sett ut som `medDb(`. Det är
    // falsklarmsriktningen, till skillnad från härledningen ovan.
    if (!new RegExp(`(^|[^\\p{L}\\p{N}_.$])${alias}\\s*\\(`, 'u').test(rader[i])) continue
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

    // R1/R2 läser KOD: en utkommenterad assertion uppfyller ingenting.
    const rader = codeMask(text).split('\n')
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

// ── OMFÅNGETS GOLV ──────────────────────────────────────────────────────────
//
// Kanariefågeln nedan krävde tidigare bara "fler än noll". Ett golv på noll
// säger att skanningen inte är HELT död — inte att den mäter det den ska. Talen
// är MÄTTA mot e9aea18: 336 spec-filer, 14 med villkorlig överhoppning, 15
// villkor totalt.
const MIN_SPECFILER = 200
const MIN_VILLKORLIGA = 6

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

  // ── DEN DELADE SKANNERNS KANARIEFÅGLAR (metavaktens R2) ──────────────────
  const skanner = kanariefåglar()
  if (skanner.length) fail(`DEN DELADE SKANNERN ÄR TRASIG: ${skanner.join(' | ')}`)
  else console.log(`✅ delad skanner: kanariefåglarna gröna över ${KANARIEFÅGEL_LÄGEN.length} lägen`)

  // ── IDENTIFIERARFORMEN (#668) ────────────────────────────────────────────
  //
  // `\w` är ASCII. Ett alias eller villkor med å/ä/ö härleddes inte alls, och
  // utfallet var TYSTNAD: filen såg ut att sakna villkorlig överhoppning, och
  // vakten förblev grön om en spec vars förutsättning aldrig prövas.
  //
  // MÄTT FÖRE FIXEN: 35 mot 35, noll missade. Vakten var SÅRBAR men inte BLIND —
  // aliasen råkar sakna å/ä/ö (`medDb`, `beskriv`, `medRedis`). Kanariefågeln
  // finns för att det inte ska förbli en slump.
  {
    const svenskaNamn = {
      fil: 'svensk.spec.ts',
      text: `const HÄR_FINNS_DB = Boolean(process.env.DATABASE_URL)
const körsMotDb = HÄR_FINNS_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('kanariefågel', () => {
    expect(HÄR_FINNS_DB).toBe(true)
  })
})

körsMotDb('mot databasen', () => {})`,
    }

    const härledda = findConditionalSkips(svenskaNamn.text)
    if (
      härledda.length === 1 &&
      härledda[0].alias === 'körsMotDb' &&
      härledda[0].villkor === 'HÄR_FINNS_DB'
    ) {
      console.log('✅ IDENTIFIERARFORM: alias och villkor med å/ä/ö härleds')
    } else {
      fail(
        `IDENTIFIERARFORM: ett svenskt alias/villkor härleddes inte — fick ` +
          `${härledda.length} (${härledda.map((h) => `${h.alias}/${h.villkor}`).join(',') || 'inga'}). ` +
          `Är regexen tillbaka på \\w (ASCII)?`,
      )
    }

    // …och den ska MÄTAS av regeln, inte bara härledas. Med en prövad
    // förutsättning ska den vara TYST.
    //
    // ⚠️ DEN HÄR RADEN BÄR INTE KANARIEFÅGELN, och det ska stå. `grön()` prövar
    // FRÅNVARO av fynd, och kan därför inte skilja "korrekt tyst" från "såg
    // ingenting alls". I negativkontrollen (IDENT tillbaka på `\w`) förblev just
    // den här GRÖN — härledningen gav noll, så det fanns inget att fälla.
    //
    // Lasten bärs av de två raderna omkring: härledningen ovan, som kräver ett
    // TAL, och den röda nedan, som kräver en NAMNGIVEN regel. Båda föll.
    grön('IDENTIFIERARFORM: en svensknamngiven, PRÖVAD förutsättning är tyst', evaluate([svenskaNamn]))

    // ⚠️ REGELN NAMNGES. Läxan från #640/#667: ett prov som bara kräver "något
    // fälls" kan bli grönt av omfångsregeln i stället för av sin egen — och då
    // mäter det inte det dess namn påstår.
    const svenskUtanProv = {
      fil: 'svensk-oprovad.spec.ts',
      text: `const HÄR_FINNS_DB = Boolean(process.env.DATABASE_URL)
const körsMotDb = HÄR_FINNS_DB ? describe : describe.skip

körsMotDb('mot databasen', () => {})`,
    }
    röd(
      'IDENTIFIERARFORM: en svensknamngiven OPRÖVAD förutsättning fälls',
      evaluate([svenskUtanProv]),
      'prövar den aldrig',
    )
  }

  // ── MASKENS SEMANTIK ─────────────────────────────────────────────────────
  //
  // Tre prov som alla var fel i råtextversionen.
  {
    // R1 fick INTE uppfyllas av en bortkommenterad assertion. Det var den
    // farliga riktningen: filen ser prövad ut och är det inte.
    const kommenteradAssertion = {
      fil: 'f.spec.ts',
      text: `const HAR_DB = Boolean(process.env.DATABASE_URL)
const beskriv = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('kanariefågel', () => {
    // expect(HAR_DB).toBe(true)
  })
})

beskriv('mot databasen', () => {})`,
    }
    röd(
      'MASK: en UTKOMMENTERAD assertion uppfyller inte R1',
      evaluate([kommenteradAssertion]),
      'prövar den aldrig',
    )

    // Parentesmatchningen får inte luras av ett `)` i en testtitel. Utan masken
    // stängs blocket på fel rad och R2 svarar mot ett felaktigt intervall.
    const parentesITitel = {
      fil: 'g.spec.ts',
      text: `const HAR_DB = Boolean(process.env.DATABASE_URL)
const beskriv = HAR_DB ? describe : describe.skip

beskriv('stänger ) i titeln', () => {
  it('kanariefågel', () => {
    expect(HAR_DB).toBe(true)
  })
})`,
    }
    röd(
      'MASK: `)` i en testtitel flyttar inte blockgränsen',
      evaluate([parentesITitel]),
      'bara INUTI ett villkorligt block',
    )

    // Och åt andra hållet: ett villkor som bara står i prosa är inget villkor.
    grön(
      'MASK: ett villkorsuttryck i en KOMMENTAR är ingen villkorlig överhoppning',
      evaluate([
        {
          fil: 'h.spec.ts',
          text: "// const beskriv = HAR_DB ? describe : describe.skip\ndescribe('x', () => {})",
        },
      ]),
    )
  }

  // ── KANARIEFÅGEL 1: mönsterläsningen måste ge utslag ─────────────────────
  const v = findConditionalSkips(RÄTT.text)
  if (v.length !== 1 || v[0].alias !== 'beskriv' || v[0].villkor !== 'HAR_DB') {
    fail(`kanariefågel: villkorsläsningen gav ${JSON.stringify(v)}, väntade beskriv/HAR_DB`)
  } else console.log('✅ kanariefågel: villkorsläsningen hittar alias och villkor i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ──────────────────────────────
  const riktiga = specfiler().map((p) => ({ fil: relative(SRC, p), text: readFileSync(p, 'utf8') }))
  const medVillkor = riktiga.filter((f) => findConditionalSkips(f.text).length > 0)
  // Golv, inte "fler än noll": en mängd som krympt från 14 till 1 mäter nästan
  // ingenting men klarar ett nollgolv. Se MIN_* ovan.
  if (riktiga.length < MIN_SPECFILER) {
    fail(`omfång: ${riktiga.length} spec-filer hittade, golv ${MIN_SPECFILER}`)
  } else if (medVillkor.length < MIN_VILLKORLIGA) {
    fail(
      `omfång: ${medVillkor.length} villkorliga specar i den riktiga källan, golv ` +
        `${MIN_VILLKORLIGA} — skanningen har gått blind eller mängden har krympt`,
    )
  } else {
    console.log(
      `✅ omfång: ${riktiga.length} spec-filer (golv ${MIN_SPECFILER}), ` +
        `${medVillkor.length} med villkorlig överhoppning (golv ${MIN_VILLKORLIGA})`,
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
