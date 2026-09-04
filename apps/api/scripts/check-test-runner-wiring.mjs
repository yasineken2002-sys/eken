#!/usr/bin/env node
/**
 * Ett prov som ingen kör är inte täckning — det är en vakt med tom mängd.
 *
 * ── VARFÖR VAKTEN FINNS ─────────────────────────────────────────────────────
 *
 * Uppmätt i #719: `apps/portal` hade vitest, en konfiguration, en setup-fil och
 * ett prov. Provet kördes ALDRIG. CI kör `turbo test:ci`, och portal definierade
 * bara `test`, så turbo svarade `<NONEXISTENT>` och gick vidare — grönt, tyst,
 * i månader. Ingen befintlig kontroll kunde se det, eftersom ingenting var
 * trasigt: skriptet fanns, provet fanns, CI var grön.
 *
 * Det är den farligaste formen av defekt i den här kodbasen — inte att något
 * går sönder, utan att något SLUTAR MÄTA utan att sluta vara grönt. Ett paket
 * som skaffar prov men inte kopplar in dem ser ut precis som ett paket med
 * täckning, ända tills någon läser turbo-utdatan rad för rad.
 *
 * Vakten mäter därför fyra saker:
 *
 *   R1  Varje paket med PROVSPÅR (testkonfig eller *.spec/*.test under src/)
 *       har ett `test:ci`-skript.
 *   R2  `turbo.json` definierar uppgiften `test:ci`. Utan den når
 *       `turbo run test:ci` INGET paket, hur många skript som än finns.
 *   R3  `test:ci` anropar en riktig körare (vitest/jest). Utan R3 uppfyller
 *       `"test:ci": "true"` regel R1 och sviten är grön av ingenting.
 *   R4  Härledningen mätte faktiskt något. Utan R4 är R1 grön av tomhet den
 *       dag uppräkningen slutar hitta paket.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Den här vakten mäter att proven KÖRS. Den säger ingenting om att de är
 * MENINGSFULLA: ett `expect(true).toBe(true)` uppfyller varenda regel ovan, och
 * ett prov som slutat assertera på något verkligt är osynligt härifrån.
 *
 * Den ser inte heller att proven är gröna — bara att kedjan paket → skript →
 * turbo-uppgift är hel. Utfallet av körningen ägs av CI-jobben "Unit tests
 * (web, portal)" och "Tests"; att inga prov är överhoppade ägs av
 * check-no-skipped-tests.mjs.
 *
 * E2E ligger UTANFÖR mängden med flit. `apps/web/e2e/*.spec.ts` ligger inte
 * under `src/`, och Playwright-sviten körs av sitt eget CI-jobb med en egen
 * kanariefågel på antalet tester. Att räkna in den här hade gjort `test:ci`
 * till ett krav på ett paket vars prov redan körs på ett annat sätt.
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)

/** Kataloger i pnpm-workspace.yaml. Läses därifrån, skrivs inte här. */
const WORKSPACE_FIL = 'pnpm-workspace.yaml'

/** Uppgiften CI faktiskt anropar. Ändras den här måste ci.yml ändras med. */
const CI_UPPGIFT = 'test:ci'

/** Körare vi accepterar i R3. En körare som inte står här är inte förbjuden — den ska läggas till. */
const KÄNDA_KÖRARE = ['vitest', 'jest']

/**
 * Minsta antal paket med provspår för att R1 ska betyda något. Läs talet HÄR
 * innan du bygger en sond mot vakten: en sond som ger färre än så mäter R4, inte R1.
 * Dagens verkliga mängd är apps/api, apps/portal och apps/web.
 */
const MIN_PAKET_MED_PROVSPÅR = 2

/**
 * @param {{
 *   paket: Array<{rel: string, namn: string, skript: Record<string,string>, testkonfig: string[], specar: string[]}>,
 *   turboUppgifter: string[],
 * }} källor
 */
export function evaluate({ paket, turboUppgifter }) {
  const fel = []

  const medProvspår = paket.filter((p) => p.testkonfig.length > 0 || p.specar.length > 0)

  // ── R2 ────────────────────────────────────────────────────────────────────
  // Först, för utan uppgiften i turbo.json är R1 meningslös: varje paket kan ha
  // ett perfekt test:ci-skript och ändå aldrig köras.
  if (!turboUppgifter.includes(CI_UPPGIFT)) {
    fel.push(
      `R2 turbo.json — uppgiften "${CI_UPPGIFT}" saknas i "tasks". ` +
        `\`turbo run ${CI_UPPGIFT}\` når då INGET paket, oavsett hur många ` +
        'som definierar skriptet. Kända uppgifter: ' +
        (turboUppgifter.length ? turboUppgifter.join(', ') : '(inga)'),
    )
  }

  // ── R1 + R3 ───────────────────────────────────────────────────────────────
  for (const p of medProvspår) {
    const spår = [
      ...p.testkonfig.map((f) => `konfig ${f}`),
      ...(p.specar.length ? [`${p.specar.length} spec/test-fil(er), t.ex. ${p.specar[0]}`] : []),
    ].join(' + ')

    const skript = p.skript[CI_UPPGIFT]
    if (skript === undefined) {
      fel.push(
        `R1 ${p.rel} (${p.namn}) — har provspår (${spår}) men inget "${CI_UPPGIFT}"-skript. ` +
          `CI kör \`turbo ${CI_UPPGIFT}\`, så turbo svarar <NONEXISTENT> och hoppar över ` +
          'paketet TYST OCH GRÖNT. Ett prov som ingen kör är inte täckning. ' +
          (p.skript['test'] !== undefined
            ? `Paketet har ett "test"-skript (${JSON.stringify(p.skript['test'])}) — det räcker inte, turbo anropar "${CI_UPPGIFT}".`
            : ''),
      )
      continue
    }

    if (!KÄNDA_KÖRARE.some((k) => skript.includes(k))) {
      fel.push(
        `R3 ${p.rel} (${p.namn}) — "${CI_UPPGIFT}" är ${JSON.stringify(skript)}, som inte ` +
          `nämner någon känd körare (${KÄNDA_KÖRARE.join(', ')}). Regel R1 kan uppfyllas av ` +
          'ett skript som inte kör något alls, och då är jobbet grönt av ingenting. ' +
          'Är det en ny körare: lägg till den i KÄNDA_KÖRARE och skriv varför.',
      )
    }
  }

  // ── R4 ────────────────────────────────────────────────────────────────────
  // Kanariefågeln inuti regeln själv. Krymper uppräkningen — en glob som slutar
  // matcha, en katalog som byter namn — blir R1 grön utan att något prövats.
  if (medProvspår.length < MIN_PAKET_MED_PROVSPÅR) {
    fel.push(
      `R4 uppräkningen hittade bara ${medProvspår.length} paket med provspår, ` +
        `tröskeln är ${MIN_PAKET_MED_PROVSPÅR}. R1 är då grön av TOMHET och inte av ` +
        `att kedjan är hel. Undersökta paket: ${paket.length} ` +
        `(${paket.map((p) => p.rel).join(', ') || 'inga'}).`,
    )
  }

  return {
    fel,
    mätt: {
      paket: paket.length,
      medProvspår: medProvspår.length,
      namn: medProvspår.map((p) => p.rel),
      kopplade: medProvspår.filter((p) => p.skript[CI_UPPGIFT] !== undefined).length,
    },
  }
}

// ── Läsning från disk ────────────────────────────────────────────────────────

/** Kataloger vi aldrig går ner i. `dist`/`build` kan innehålla kopierade specar. */
const HOPPA_ÖVER = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage'])

/** Formen på en provfil. MATCHAR FORM, inte ordet "spec" i en sökväg — se #567. */
const SPEC_FORM = /\.(spec|test)\.(ts|tsx|js|jsx|mts|cts)$/

/** Formen på en testkonfiguration i paketroten. */
const KONFIG_FORM = /^(vitest|jest)\.config\.(ts|js|mjs|cjs|mts|json)$/

function gåIgenom(katalog, rotLängd, träffar = []) {
  let poster
  try {
    poster = readdirSync(katalog)
  } catch {
    return träffar
  }
  for (const post of poster) {
    if (HOPPA_ÖVER.has(post)) continue
    const full = join(katalog, post)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) gåIgenom(full, rotLängd, träffar)
    else if (SPEC_FORM.test(post)) träffar.push(full.slice(rotLängd + 1))
  }
  return träffar
}

/**
 * Paketkatalogerna, härledda ur pnpm-workspace.yaml i stället för uppräknade
 * här. Läggs ett tredje mönster till i workspacen följer vakten med av sig själv.
 */
function paketKataloger() {
  const yaml = readFileSync(join(ROT, WORKSPACE_FIL), 'utf8')
  const mönster = [...yaml.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1])
  if (mönster.length === 0) {
    throw new Error(
      `${WORKSPACE_FIL} gav noll paketmönster. Har filens form ändrats? ` +
        'En tom mängd här gör HELA vakten grön av tomhet.',
    )
  }
  const kataloger = []
  for (const m of mönster) {
    if (!m.endsWith('/*')) {
      if (existsSync(join(ROT, m))) kataloger.push(m)
      continue
    }
    const bas = m.slice(0, -2)
    let poster
    try {
      poster = readdirSync(join(ROT, bas))
    } catch {
      continue
    }
    for (const post of poster) {
      const rel = `${bas}/${post}`
      if (statSync(join(ROT, rel)).isDirectory()) kataloger.push(rel)
    }
  }
  return kataloger.sort()
}

export function frånDisk() {
  const paket = []
  for (const rel of paketKataloger()) {
    const pkgFil = join(ROT, rel, 'package.json')
    // apps/landing är övergiven och har ingen package.json — den är inget paket.
    if (!existsSync(pkgFil)) continue
    const pkg = JSON.parse(readFileSync(pkgFil, 'utf8'))

    const testkonfig = readdirSync(join(ROT, rel)).filter((f) => KONFIG_FORM.test(f))
    if (pkg.jest !== undefined) testkonfig.push('package.json#jest')

    const srcRot = join(ROT, rel, 'src')
    const specar = existsSync(srcRot) ? gåIgenom(srcRot, join(ROT, rel).length, []) : []

    paket.push({
      rel,
      namn: pkg.name ?? rel,
      skript: pkg.scripts ?? {},
      testkonfig,
      specar,
    })
  }

  const turbo = JSON.parse(readFileSync(join(ROT, 'turbo.json'), 'utf8'))
  const turboUppgifter = Object.keys(turbo.tasks ?? turbo.pipeline ?? {})

  return { paket, turboUppgifter }
}

// ── Självtest ────────────────────────────────────────────────────────────────

function självtest() {
  const fel = []

  /** Ett paket som är korrekt kopplat — basen alla kanariefåglar avviker från. */
  const friskt = (rel, namn) => ({
    rel,
    namn,
    skript: { test: 'vitest', 'test:ci': 'vitest run' },
    testkonfig: ['vitest.config.ts'],
    specar: [`src/${namn}.spec.ts`],
  })

  const bas = {
    paket: [friskt('apps/ett', 'ett'), friskt('apps/tva', 'tva')],
    turboUppgifter: ['build', 'lint', 'test', 'test:ci'],
  }

  const kräv = (namn, utfall, regel) => {
    if (!utfall.fel.some((f) => f.startsWith(regel))) {
      fel.push(`${namn}: ${regel} fällde INTE. Utfall: ${JSON.stringify(utfall.fel)}`)
    }
  }

  // GRUND — den friska mängden ska vara grön, annars mäter inget nedan något.
  {
    const g = evaluate(bas)
    if (g.fel.length) fel.push(`GRUND: frisk mängd gav fel: ${JSON.stringify(g.fel)}`)
    if (g.mätt.medProvspår !== 2) fel.push(`GRUND: väntade 2 paket med provspår, fick ${g.mätt.medProvspår}`)
  }

  // KANARIE A — fixturpaket med SPEC men utan test:ci. Exakt portals läge i dag.
  kräv(
    'KANARIE A (spec men inget test:ci)',
    evaluate({
      ...bas,
      paket: [
        friskt('apps/ett', 'ett'),
        friskt('apps/tva', 'tva'),
        { rel: 'apps/fixtur', namn: 'fixtur', skript: { test: 'vitest run' }, testkonfig: [], specar: ['src/a.spec.ts'] },
      ],
    }),
    'R1',
  )

  // KANARIE A2 — samma fixtur MED test:ci ska vara GRÖN. Utan det här provet
  // kan man inte skilja "vakten fäller rätt sak" från "vakten fäller allt".
  {
    const g = evaluate({
      ...bas,
      paket: [
        friskt('apps/ett', 'ett'),
        friskt('apps/tva', 'tva'),
        { rel: 'apps/fixtur', namn: 'fixtur', skript: { 'test:ci': 'vitest run' }, testkonfig: [], specar: ['src/a.spec.ts'] },
      ],
    })
    if (g.fel.length) fel.push(`KANARIE A2: fixtur MED test:ci gav fel: ${JSON.stringify(g.fel)}`)
  }

  // KANARIE B — testKONFIG men ingen spec, och inget test:ci. Konfigurationen
  // ensam är ett provspår: den säger att paketet MENAR att köra prov.
  kräv(
    'KANARIE B (testkonfig men inget test:ci)',
    evaluate({
      ...bas,
      paket: [
        ...bas.paket,
        { rel: 'apps/fixtur', namn: 'fixtur', skript: {}, testkonfig: ['vitest.config.ts'], specar: [] },
      ],
    }),
    'R1',
  )

  // KANARIE C — paket UTAN provspår ska inte krävas på något. Annars blir
  // vakten ett krav på att varje paket har tester, vilket är en annan fråga.
  {
    const g = evaluate({
      ...bas,
      paket: [...bas.paket, { rel: 'packages/inget', namn: 'inget', skript: {}, testkonfig: [], specar: [] }],
    })
    if (g.fel.length) fel.push(`KANARIE C: paket utan provspår fälldes: ${JSON.stringify(g.fel)}`)
  }

  // KANARIE D — uppgiften saknas i turbo.json. Varje paket är perfekt kopplat
  // och ingenting körs ändå.
  kräv('KANARIE D (test:ci saknas i turbo.json)', evaluate({ ...bas, turboUppgifter: ['build', 'lint', 'test'] }), 'R2')

  // KANARIE E — test:ci finns men kör ingenting. R1 är uppfylld, sviten grön av
  // ingenting. Det är samma tomhet som vakten finns för att fånga.
  kräv(
    'KANARIE E (test:ci kör ingen känd körare)',
    evaluate({
      ...bas,
      paket: [friskt('apps/ett', 'ett'), { ...friskt('apps/tva', 'tva'), skript: { 'test:ci': 'true' } }],
    }),
    'R3',
  )

  // KANARIE F — tom uppräkning. Utan R4 hade ALLT ovan varit grönt här, vilket
  // är precis det tysta läget vakten skrevs mot.
  {
    const tom = evaluate({ paket: [], turboUppgifter: ['test:ci'] })
    if (!tom.fel.some((f) => f.startsWith('R4'))) {
      fel.push(`KANARIE F: R4 föll inte på tom paketmängd. Utfall: ${JSON.stringify(tom.fel)}`)
    }
    if (tom.fel.some((f) => f.startsWith('R1'))) {
      fel.push('KANARIE F: R1 fällde på tom mängd — den ska tiga och låta R4 tala.')
    }
  }

  // KANARIE G — uppräkningen från DISK hittar faktiskt paket. Skiljer
  // "inga fel" från "läste fel katalog", vilket ser likadant ut i utdatan.
  {
    const d = frånDisk()
    if (d.paket.length < 5) {
      fel.push(`KANARIE G: frånDisk() hittade bara ${d.paket.length} paket — förväntat minst 5 (apps + packages).`)
    }
    if (!d.paket.some((p) => p.rel === 'apps/api' && p.specar.length > 100)) {
      const api = d.paket.find((p) => p.rel === 'apps/api')
      fel.push(`KANARIE G: apps/api skulle ha hundratals specar, gav ${api ? api.specar.length : 'inget paket alls'}.`)
    }
    // Playwright-specarna ligger i apps/web/e2e, alltså UTANFÖR src. Kommer de
    // med är avgränsningen bruten och vakten kräver test:ci av fel skäl.
    const web = d.paket.find((p) => p.rel === 'apps/web')
    if (web && web.specar.some((f) => f.startsWith('e2e/'))) {
      fel.push(`KANARIE G: e2e-specar kom med i apps/web-mängden: ${web.specar.filter((f) => f.startsWith('e2e/')).join(', ')}`)
    }
  }

  if (fel.length) {
    console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    'SJÄLVTEST GRÖNT — 8 kanariefåglar prövade: spec utan test:ci fälls, samma fixtur MED ' +
      'test:ci är grön, konfig utan skript fälls, paket utan provspår lämnas ifred, ' +
      'saknad turbo-uppgift fälls, kör-lös test:ci fälls, tom mängd fälls av R4, ' +
      'och diskuppräkningen bevisas hitta något.',
  )
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-test-runner-wiring.mjs') ?? false
if (!KÖRS_DIREKT) {
  // importerad — kör ingenting
} else if (process.argv.includes('--self-test')) självtest()
else {
  const { fel, mätt } = evaluate(frånDisk())
  if (fel.length) {
    console.error(
      'Provkörarnas påkoppling är bruten — ett prov som ingen kör är inte täckning:\n  ' +
        fel.join('\n  '),
    )
    process.exit(1)
  }
  console.warn(
    `Provkörarna är påkopplade — ${mätt.medProvspår} av ${mätt.paket} paket har provspår ` +
      `(${mätt.namn.join(', ')}), och alla ${mätt.kopplade} har ett "${CI_UPPGIFT}"-skript ` +
      'som turbo når.',
  )
}
