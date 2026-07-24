#!/usr/bin/env node
/**
 * CI-guard (designsystem PR7) — håller den låsta paletten låst FRAMÅT.
 *
 * PR2–4 band apparnas färger till `--ev-*`-tokens, PR5–6 flyttade Modal och
 * DataTable till @eken/ui. Inget av det hindrar att nästa feature-PR skriver
 * `text-[#2563EB]` eller `background: #1a6b3c` igen — och varje sådan rad är en
 * yta som färgflippen INTE når. Den här guarden är spärren.
 *
 * Guarden är en SPÄRR (ratchet), inte ett krav på nollställning. Kodbasen har
 * hundratals rå-hex kvar som PR2–4 medvetet lät stå (input-kanter, chart-färger,
 * gradienter, sträng-konkatenering). De ligger i en committad baseline med antal
 * per fil och regel. CI faller när en fil får FLER träffar än sin baseline — dvs
 * på nytillskott, aldrig på det gamla. Städar man en fil sjunker antalet och
 * baselinen kan snävas åt med --update-baseline.
 *
 * Tre regler:
 *   palette-hex   Ett av @eken/ui:s LÅSTA målvärden hårdkodat utanför packages/ui.
 *                 Allvarligast: det är precis de värdena som ska komma ur en
 *                 token (eller DEFAULT_BRAND_COLOR i API/PDF/mejl-leden).
 *   raw-hex       Övriga hex-literaler i källkod/CSS.
 *   tw-arbitrary  Tailwinds `-[#rrggbb]` (t.ex. `border-[#EAEDF0]`) — samma sak
 *                 som raw-hex men den form ADR:n namnger explicit, och den som
 *                 är enklast att av misstag klistra in från en gammal fil.
 *
 * Falsklarm undviks:
 *   • Kommentarer strippas (block, rad, JSX) — annars flaggas `/* mål #f6f4f0 *​/`
 *     i apparnas egna token-block, som ju är dokumentation av flippen.
 *   • packages/ui är källan och skannas aldrig.
 *   • Apparnas neutrala token-block (globals.css / tokens.css) är UNDANTAGNA:
 *     det är själva mekanismen — de SKA binda tokennamn till dagens hex, och de
 *     är också det enda stället flippen behöver röra.
 *
 * Rent statiskt (fs-only, inga beroenden) → eget CI-steg.
 * Lokalt:      node scripts/check-design-tokens.mjs
 * Självtest:   node scripts/check-design-tokens.mjs --self-test
 * Uppdatera:   node scripts/check-design-tokens.mjs --update-baseline
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BASELINE_PATH = join(HERE, 'design-tokens.baseline.json')

/**
 * Kataloger som skannas (relativt repo-roten). packages/ui är KÄLLAN → aldrig.
 *
 * `ui: false` = bara `palette-hex` gäller. API:ets PDF- och mejlmallar renderas i
 * Puppeteer respektive mejlklienter, där CSS-variabler inte kan användas — där ÄR
 * literal hex rätt svar. Men varumärkesfärgen måste ändå komma ur
 * DEFAULT_BRAND_COLOR, annars missar en varumärkesändring tyst varenda PDF och
 * mejl. Samma sak för delade konstanter i @eken/shared.
 */
const SCAN_ROOTS = [
  { dir: 'apps/web/src', ui: true },
  { dir: 'apps/admin/src', ui: true },
  { dir: 'apps/portal/src', ui: true },
  { dir: 'apps/api/src', ui: false },
  { dir: 'packages/shared/src', ui: false },
]

const EXTENSIONS = ['.ts', '.tsx', '.css']

/** Tester får (och bör) påstå det konkreta värdet — annars blir påståendet cirkulärt. */
const TEST_FILE_RE = /\.(spec|test)\.tsx?$/

/**
 * Filer där rå hex är MENINGEN: apparnas neutrala token-block binder `--ev-*`
 * till dagens värden (PR2–4-mekaniken) och är det enda flippen rör.
 */
const TOKEN_BINDING_FILES = [
  'apps/web/src/app/globals.css',
  'apps/admin/src/app/globals.css',
  'apps/portal/src/styles/tokens.css',
]

/** @eken/ui:s låsta målpalett. Hårdkodas dessa utanför paketet blir de osynliga för flippen. */
const LOCKED_PALETTE = [
  '#1a6b3c', // brand / status-success
  '#f6f4f0', // bg
  '#241f1a', // text
  '#5a5248', // text-muted
  '#ece7e0', // border
  '#b8791a', // status-warning
  '#c6402f', // status-danger
]
// #ffffff är medvetet INTE med: vitt är vitt, inte ett varumärkesbeslut.

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g
const TW_ARBITRARY_RE = /-\[#[0-9a-fA-F]{3,8}\]/g

/**
 * Ersätter kommentarer med lika många blanksteg (positioner bevaras) så att
 * radnummer och offsets stämmer i rapporten.
 */
export function stripComments(text, ext) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  if (ext === '.css') {
    return text.replace(/\/\*[\s\S]*?\*\//g, blank)
  }
  // ts/tsx: blockkommentar, radkommentar — men inte inuti strängar.
  let out = ''
  let i = 0
  let quote = null
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (quote) {
      if (ch === '\\') {
        out += text.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === quote) quote = null
      out += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += blank(text.slice(i, stop))
      i = stop
      continue
    }
    if (ch === '/' && next === '/') {
      let end = text.indexOf('\n', i)
      if (end === -1) end = text.length
      out += blank(text.slice(i, end))
      i = end
      continue
    }
    out += ch
    i++
  }
  return out
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/**
 * Skanna EN fil → träffar per regel. Exporterad så självtestet kör exakt samma
 * kod som CI.
 */
export function scanSource(rawText, relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.'))
  const text = stripComments(rawText, ext)
  const hits = { 'palette-hex': [], 'raw-hex': [], 'tw-arbitrary': [] }

  const arbitrarySpans = []
  for (const m of text.matchAll(TW_ARBITRARY_RE)) {
    arbitrarySpans.push([m.index, m.index + m[0].length])
    hits['tw-arbitrary'].push({ line: lineOf(text, m.index), value: m[0] })
  }

  for (const m of text.matchAll(HEX_RE)) {
    const value = m[0].toLowerCase()
    const rule = LOCKED_PALETTE.includes(value) ? 'palette-hex' : 'raw-hex'
    // En hex inuti `-[#..]` räknas i tw-arbitrary; undvik dubbelräkning i raw-hex.
    if (rule === 'raw-hex' && arbitrarySpans.some(([s, e]) => m.index >= s && m.index < e)) continue
    hits[rule].push({ line: lineOf(text, m.index), value: m[0] })
  }

  return hits
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full)
  }
  return out
}

const toPosix = (p) => p.split(sep).join('/')

function collect() {
  const result = {}
  for (const { dir, ui } of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = toPosix(relative(ROOT, file))
      if (TOKEN_BINDING_FILES.includes(rel)) continue
      if (TEST_FILE_RE.test(rel)) continue
      const hits = scanSource(readFileSync(file, 'utf8'), rel)
      if (!ui) {
        hits['raw-hex'] = []
        hits['tw-arbitrary'] = []
      }
      const counts = {}
      for (const [rule, list] of Object.entries(hits)) if (list.length) counts[rule] = list.length
      if (Object.keys(counts).length) result[rel] = { counts, hits }
    }
  }
  return result
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { files: {} }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline(current) {
  const files = {}
  for (const rel of Object.keys(current).sort()) {
    // palette-hex är hård → hamnar aldrig i baselinen, ens vid --update-baseline.
    const { 'palette-hex': _hard, ...rest } = current[rel].counts
    if (Object.keys(rest).length) files[rel] = rest
  }
  const total = Object.values(files).reduce(
    (acc, c) => acc + Object.values(c).reduce((a, b) => a + b, 0),
    0,
  )
  const payload = {
    $comment:
      'GENERERAD SPÄRR-BASELINE. Antal rå-hex per fil och regel som fanns när ' +
      'guarden infördes (PR7). CI faller på fler — aldrig på färre. Städar du en ' +
      'fil: kör `node scripts/check-design-tokens.mjs --update-baseline` så snävas ' +
      'spärren åt. Lägg ALDRIG till rader här för hand för att tysta ett nytt fynd.',
    total,
    files,
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return total
}

function run() {
  const current = collect()
  const baseline = loadBaseline().files ?? {}
  const regressions = []
  const improvements = []

  for (const [rel, { counts, hits }] of Object.entries(current)) {
    for (const [rule, count] of Object.entries(counts)) {
      // palette-hex är HÅRD: noll tolerans, ingen baseline kan tysta den. Det är
      // de värden flippen ska styra — en enda hårdkodad kopia gör flippen ofullständig.
      const allowed = rule === 'palette-hex' ? 0 : (baseline[rel]?.[rule] ?? 0)
      if (count > allowed) {
        const examples = hits[rule].slice(-(count - allowed))
        regressions.push({ rel, rule, count, allowed, examples })
      }
    }
  }
  for (const [rel, counts] of Object.entries(baseline)) {
    for (const [rule, allowed] of Object.entries(counts)) {
      const count = current[rel]?.counts[rule] ?? 0
      if (count < allowed) improvements.push({ rel, rule, count, allowed })
    }
  }

  if (regressions.length) {
    console.error('\n❌ Designsystem: nya rå färgvärden utanför @eken/ui\n')
    for (const r of regressions) {
      console.error(`  ${r.rel}`)
      console.error(`    regel ${r.rule}: ${r.count} träffar (baseline ${r.allowed})`)
      for (const ex of r.examples) console.error(`      rad ${ex.line}: ${ex.value}`)
    }
    console.error(
      '\nAnvänd en token i stället:\n' +
        '  Tailwind (web/admin):  bg-canvas | text-ink | text-ink-muted | border-line |\n' +
        '                         bg-brand | text-brand | bg-success | bg-warning | bg-danger\n' +
        '  CSS (portal + alla):   var(--ev-bg) | var(--ev-text) | var(--ev-border) | var(--ev-brand) …\n' +
        '  Varumärkesfärg i API/PDF/mejl: DEFAULT_BRAND_COLOR från @eken/shared\n' +
        'Saknas en token för ytan? Lägg en KOMPONENT-VARIABEL med palett-härledd default\n' +
        'i packages/ui/src/tokens.ts (se ADR:n) — hårdkoda inte hex.\n',
    )
    process.exit(1)
  }

  const total = Object.values(current).reduce(
    (acc, f) => acc + Object.values(f.counts).reduce((a, b) => a + b, 0),
    0,
  )
  console.warn(`✅ Designsystem: inga nya rå färgvärden (${total} kvar i spärr-baselinen)`)
  if (improvements.length) {
    console.warn(`   ${improvements.length} fil/regel-par ligger UNDER baselinen — snäva åt med:`)
    console.warn('   node scripts/check-design-tokens.mjs --update-baseline')
  }
}

// ── självtest ───────────────────────────────────────────────────────────────
function selfTest() {
  let failed = 0
  const t = (name, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`)
    if (!ok) failed++
  }

  const tsx = `
const a = <div className="border-[#EAEDF0] bg-white" />
const brand = '#1a6b3c'
// kommentar med #ff0000 ska INTE räknas
/* blockkommentar med #00ff00 heller */
const other = '#abcdef'
`
  const h1 = scanSource(tsx, 'apps/web/src/x.tsx')
  t('fångar tailwind -[#..]', h1['tw-arbitrary'].length === 1, JSON.stringify(h1['tw-arbitrary']))
  t('fångar låst palettvärde', h1['palette-hex'].length === 1, JSON.stringify(h1['palette-hex']))
  t(
    'räknar inte -[#..] en gång till som raw-hex',
    h1['raw-hex'].length === 1 && h1['raw-hex'][0].value === '#abcdef',
    JSON.stringify(h1['raw-hex']),
  )
  t(
    'ignorerar hex i rad-/blockkommentar',
    !JSON.stringify(h1).includes('ff0000') && !JSON.stringify(h1).includes('00ff00'),
  )

  const css = `
:root { --x: #123456; }
/* mål #f6f4f0 → dagens #f7f8fa */
.a { color: #1A6B3C; }
`
  const h2 = scanSource(css, 'apps/portal/src/y.css')
  t('css: kommentar strippad', h2['palette-hex'].length === 1, JSON.stringify(h2['palette-hex']))
  t('css: skiftlägesokänslig palettmatchning', h2['palette-hex'][0].value === '#1A6B3C')
  t('css: övrig hex räknas', h2['raw-hex'].length === 1)

  const strings = `const s = "// inte en kommentar #111827"`
  const h3 = scanSource(strings, 'apps/web/src/z.ts')
  t(
    'hex i sträng som liknar kommentar räknas',
    h3['raw-hex'].length === 1,
    JSON.stringify(h3['raw-hex']),
  )

  const clean = `import { DEFAULT_BRAND_COLOR } from '@eken/shared'\nexport const c = DEFAULT_BRAND_COLOR`
  const h4 = scanSource(clean, 'apps/web/src/ok.ts')
  t(
    'ren fil ger noll fynd',
    h4['raw-hex'].length === 0 && h4['palette-hex'].length === 0 && h4['tw-arbitrary'].length === 0,
  )

  t('token-bindande filer är undantagna', TOKEN_BINDING_FILES.length === 3)
  t('packages/ui skannas aldrig', !SCAN_ROOTS.some((r) => r.dir.startsWith('packages/ui')))
  t(
    'API/shared skannas bara för palette-hex',
    SCAN_ROOTS.filter((r) => !r.ui)
      .map((r) => r.dir)
      .join(',') === 'apps/api/src,packages/shared/src',
  )
  t(
    'testfiler undantas',
    TEST_FILE_RE.test('apps/api/src/x.spec.ts') && !TEST_FILE_RE.test('apps/api/src/x.ts'),
  )

  // palette-hex får ALDRIG kunna tystas av baselinen
  const hardBaselined = Object.values(loadBaseline().files ?? {}).some((c) => 'palette-hex' in c)
  t('palette-hex finns inte i baselinen', !hardBaselined)

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

const arg = process.argv[2]
if (arg === '--self-test') selfTest()
else if (arg === '--update-baseline') {
  const total = writeBaseline(collect())
  console.warn(`Baseline uppdaterad: ${total} kvarvarande träffar.`)
} else run()
