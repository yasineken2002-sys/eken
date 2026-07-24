#!/usr/bin/env node
/**
 * CI-guard (designsystem PR7) — håller den låsta paletten låst FRAMÅT.
 *
 * PR2–4 band apparnas färger till `--ev-*`-tokens, PR5–6 flyttade Modal och
 * DataTable till @eken/ui. Inget av det hindrar att nästa feature-PR skriver
 * `text-[#2563EB]` eller `background: #1a6b3c` igen — och varje sådan rad är en
 * yta som färgflippen INTE når. Den här guarden är spärren.
 *
 * ── Tre lager ───────────────────────────────────────────────────────────────
 *
 * 1. HÅRDA REGLER (ingen tolerans, kan aldrig tystas)
 *    palette-hex   @eken/ui:s LÅSTA målvärden hårdkodade utanför packages/ui.
 *                  Det är precis de värdena som ska komma ur en token (eller
 *                  DEFAULT_BRAND_COLOR i API/PDF/mejl-leden).
 *    okänt värde   En färg som inte finns i KLASSIFICERINGEN nedan är per
 *                  definition ny → faller direkt, oavsett allowlist. Det är den
 *                  regel som gör att en helt ny hex inte kan smyga in.
 *
 * 2. ALLOWLIST (scripts/design-tokens.baseline.json) — FLIPP-SKULD.
 *    Varje post är knuten till en KATEGORI som har en `why`- och en `flip`-rad:
 *    varför den lämnades otokeniserad i PR2–6 och hur färgflippen löser den.
 *    CI faller när en fil får FLER träffar än sin post — aldrig på det gamla.
 *    Listan ska KRYMPA TILL NOLL i och med flippen. Städar man en fil sjunker
 *    antalet och listan snävas åt med --update-baseline.
 *
 * 3. INLINE-UNDANTAG — `design-tokens-allow: <motivering>` i en kommentar på
 *    samma rad eller raden ovanför. Endast för färger som ALDRIG ska
 *    tokeniseras (kunddata, falska positiver). De räknas och skrivs ut i varje
 *    CI-körning så att de förblir synliga, och de biter inte på palette-hex.
 *
 * Falsklarm undviks:
 *   • Kommentarer strippas (block, rad) — annars flaggas `/* mål #f6f4f0 *​/`
 *     i apparnas egna token-block, som ju är dokumentation av flippen.
 *   • packages/ui är källan och skannas aldrig.
 *   • Apparnas neutrala token-block (globals.css / tokens.css) är UNDANTAGNA:
 *     det är själva mekanismen — de SKA binda tokennamn till dagens hex, och de
 *     är också det enda stället flippen behöver röra.
 *
 * Rent statiskt (fs-only, inga beroenden) → eget CI-steg + del av `pnpm lint`.
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
// rgb()/hsl() är samma synd som rå hex och var tidigare en öppen kringgång:
// `background: rgb(37, 99, 235)` passerade hex-regeln obemärkt.
const COLOR_FN_RE = /\b(?:rgba?|hsla?)\(\s*[^)]*\)/g

/**
 * Inline-undantag:
 *   `design-tokens-allow: <motivering>`        — samma rad eller raden ovanför
 *   `design-tokens-allow-start: <motivering>`  — öppnar ett block …
 *   `design-tokens-allow-end`                  — … som stängs här
 * Alltid i en kommentar, alltid med motivering.
 */
const INLINE_ALLOW_RE = /design-tokens-allow:\s*(\S.*?)(?:\*\/|$)/
const REGION_START_RE = /design-tokens-allow-start:\s*(\S.*?)(?:\*\/|$)/
const REGION_END_RE = /design-tokens-allow-end\b/
const INLINE_MIN_REASON = 20

/**
 * ── KATEGORIER ──────────────────────────────────────────────────────────────
 * Varje allowlist-post pekar på en kategori. `why` = varför den lämnades
 * otokeniserad i PR2–6. `flip` = hur färgflippen tar bort den. Guarden kräver
 * att båda finns och är ifyllda — en post utan motivering är inte tillåten.
 */
export const CATEGORIES = {
  'input-border': {
    why: 'Formulär-, modal- och tabellkanter (#DDDFE4, #E5E7EB m.fl.), nästan alltid som Tailwind-arbitrary på fältnivå. PR2–4 lämnade dem literala: kant-tokenens kontrast mot den nya varma bakgrunden var inte fastställd.',
    flip: 'Flippen byter hela familjen mot var(--ev-border) / border-line när kant-kontrasten är låst.',
  },
  'neutral-scale': {
    why: 'Neutral grå- och vitskala (#888, #aaa, #1a1a1a, #fff, #6B7280 …), mest i portalens CSS-moduler och äldre web-vyer. Neutraler bär inget varumärke och prioriterades ned i PR2–4.',
    flip: 'Flippen mappar skalan till --ev-text / --ev-text-muted / --ev-surface i ett svep.',
  },
  'brand-blue': {
    why: 'Dagens legacy-blå (#2563EB med syskon) i selection, SVG-ikoner, länkar och info-ytor. Exakt den yta flippen gör grön — men den sitter i props och SVG-attribut som PR2–4 inte rörde.',
    flip: 'Flippen ersätter dem med --ev-brand. Noll ska återstå; kategorin är flippens huvudmål.',
  },
  'green-legacy': {
    why: 'Portalens befintliga gröna varumärkesytor och gradienter (#164022, #1C5530, #218F52, ljusa gröna ytor) plus spridda gröna i web. Gradienter kan inte uttryckas med en enda färg-token.',
    flip: 'Flippen inför gradient- och yt-tokens i @eken/ui och byter ut hela familjen mot dem.',
  },
  'status-tints': {
    why: 'Ljusa status-par bg+text för success/warning/danger/info (t.ex. #ECFDF5 / #065F46). @eken/ui har status-FÄRGER men ännu inte de ljusa tint-paren, så PR2–4 hade inget att peka på.',
    flip: 'Flippen lägger tint-tokens (--ev-status-*-bg / -fg) och ersätter paren.',
  },
  'chart-colors': {
    why: 'Data-viz-serier i Recharts (stroke/fill-props) och KPI-kategoriprickar. Recharts tar färg som strängprop, inte som klass, och en datapalett har andra krav än UI-paletten: inbördes särskiljbarhet och färgblindhetssäkerhet.',
    flip: 'Flippen inför en SEPARAT, tillgänglighetsvaliderad chart-palett i @eken/ui. Den ärver inte UI-tokens rakt av — det är ett eget designbeslut.',
  },
  'alpha-concat': {
    why: 'Färg som konkateneras med alfa i JS (`${iconColor}14`, #FFFFFF18). En CSS-variabel bryter strängen — `var(--ev-brand)14` är ogiltig CSS, så tokenisering kräver att mönstret skrivs om först.',
    flip: 'Flippen byter mönstret mot color-mix() eller förberäknade tint-tokens; först då kan värdet tokeniseras.',
  },
  'shadow-alpha': {
    why: 'rgba() i box-shadow / ring. Skuggor är svart eller vitt med låg alfa, inte palettfärger, och PR2–4 rörde dem inte.',
    flip: 'Flippen inför --ev-shadow-* och ersätter dem. Lägst prioritet: de är varumärkesneutrala.',
  },
}

/**
 * ── KLASSIFICERING ──────────────────────────────────────────────────────────
 * Varje känt färgvärde → kategori. Ett värde som INTE står här är nytt och
 * faller hårt. Det är den regel som gör spärren tät: en ny färg kan inte glida
 * in på en befintlig fils allowlist-budget.
 */
const VALUE_CATEGORY = {}
const assign = (category, values) => {
  for (const v of values) VALUE_CATEGORY[v] = category
}

assign('input-border', [
  '#dddfe4', '#e5e7eb', '#d4d9e0', '#d1d5db', '#e8eaed', '#eaedf0', '#e2e8f0',
  '#eef0f3', '#ccc', '#f0f0f0',
])

assign('neutral-scale', [
  '#fff', '#ffffff', '#f9fafb', '#f3f4f6', '#f1f5f9', '#f5f5f5', '#f8fafb',
  '#f0f2f4', '#f1f3f5', '#888', '#aaa', '#444', '#555', '#1a1a1a', '#2a2a2a',
  '#111827', '#1f2937', '#374151', '#4b5563', '#6b7280', '#9ca3af', '#64748b',
  '#0f1117',
])

assign('brand-blue', [
  '#2563eb', '#1d4ed8', '#3b82f6', '#0b84d0', '#e8f0fd', '#eff6ff', '#e0f2fe',
  '#0284c7', '#0369a1',
])

assign('green-legacy', [
  '#218f52', '#1a7c45', '#196638', '#155a32', '#164022', '#1c5530', '#1a4a28',
  '#1e6b35', '#2d6e3e', '#2d8a46', '#2d8c54', '#0f2c17', '#1a2a20', '#1c2a20',
  '#2d3a30', '#e0e8e0', '#e8ede8', '#f0f4f0', '#e3ebe4', '#cfe0d2', '#c8e0d0',
  '#d4e4d8', '#d4ebdc', '#d0dcd2', '#d6ddd6', '#e5ebe5', '#e8f0e8', '#e8f4ee',
  '#f0f7f1', '#f0f9f4', '#f3f6f3', '#f3f8f3', '#f4f6f4', '#f4f7f4', '#f5f7f5',
  '#f7f9f7', '#f8faf8', '#fafcfa', '#b8c4b8', '#6c7a6e',
])

assign('status-tints', [
  // success
  '#059669', '#10b981', '#16a34a', '#047857', '#065f46', '#ecfdf5', '#dcfce7',
  '#f0fdf4',
  // warning
  '#d97706', '#f59e0b', '#b45309', '#ca8a04', '#92400e', '#ea580c', '#fffbeb',
  '#fef9c3', '#fff7ed', '#fef3e2', '#fff4e0', '#fdeede', '#fff8e0', '#f1e1a3',
  '#6a5a14',
  // danger
  '#dc2626', '#ef4444', '#991b1b', '#8a1f1f', '#fef2f2', '#fecaca', '#fee2e2',
  '#fce8e8', '#fff0f0', '#fff8f8', '#f4caca',
])

assign('chart-colors', [
  '#6366f1', '#8b5cf6', '#7c3aed', '#9333ea', '#6d28d9', '#db2777', '#4338ca',
  '#0d9488', '#0891b2', '#f0fdfa', '#eef2ff', '#fdf2f8', '#f5f3ff', '#f3e8ff',
  '#f0eaff',
])

assign('alpha-concat', ['#ffffff18'])

/**
 * Klassificera en träff. Sökvägs-/radkontext vinner över värdetabellen, för
 * samma värde kan vara olika synd på olika ställen (#2563EB är brand-blue i en
 * länk men alfa-konkatenering i StatCard).
 */
export function classify({ value, relPath, lineText, declText, rule }) {
  // Låst palettvärde: hård regel, men ge den ett eget namn så felmeddelandet
  // säger "LÅST PALETTVÄRDE" och inte "ny okänd färg".
  if (rule === 'palette-hex') return 'locked-palette'
  if (rule === 'raw-color-fn') {
    // Deklarationsnära kontext, inte hela raden: `background: rgb(...); box-shadow: … rgba(…)`
    // ligger ofta på samma rad och ska klassas var för sig.
    return /shadow|ring/i.test(declText) ? 'shadow-alpha' : 'neutral-scale'
  }
  const v = value.toLowerCase().replace(/^-\[/, '').replace(/\]$/, '')

  // Alfa-konkatenering: värdet sätts ihop med en alfa-suffixsträng i JS.
  if (/\$\{[^}]*\}[0-9a-fA-F]{2}|iconColor/.test(lineText)) return 'alpha-concat'
  // Recharts m.fl. tar färg som strängprop — chart även när värdet delas med UI.
  if (/\b(stroke|fill)=|CartesianGrid|dataKey/.test(lineText)) return 'chart-colors'

  return VALUE_CATEGORY[v] ?? null
}

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
 * Skanna EN fil → träffar per regel, med kategori och ev. inline-undantag.
 * Exporterad så självtestet kör exakt samma kod som CI.
 */
export function scanSource(rawText, relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.'))
  const stripped = stripComments(rawText, ext)
  // Inline-undantagen läses ur ORIGINALET (de bor ju i kommentarer).
  const rawLines = rawText.split('\n')
  const strippedLines = stripped.split('\n')

  // Blockmarkerade regioner: rad → motivering.
  const regionReason = new Map()
  let openReason = null
  for (let i = 0; i < rawLines.length; i++) {
    const start = rawLines[i].match(REGION_START_RE)
    if (start) {
      openReason = start[1].trim()
      continue
    }
    if (REGION_END_RE.test(rawLines[i])) {
      openReason = null
      continue
    }
    if (openReason !== null) regionReason.set(i + 1, openReason)
  }

  const inlineReasonFor = (line) => {
    for (const candidate of [rawLines[line - 1], rawLines[line - 2]]) {
      const m = candidate?.match(INLINE_ALLOW_RE)
      if (m) return m[1].trim()
    }
    return regionReason.get(line) ?? null
  }

  const hits = { 'palette-hex': [], 'raw-hex': [], 'tw-arbitrary': [], 'raw-color-fn': [] }
  const inlineAllowed = []
  const badInline = []

  const push = (rule, index, value) => {
    const line = lineOf(stripped, index)
    const lineText = strippedLines[line - 1] ?? ''
    // Närmaste deklaration före träffen (efter `;`, `{` eller radbrytning).
    const declStart = Math.max(
      stripped.lastIndexOf(';', index),
      stripped.lastIndexOf('{', index),
      stripped.lastIndexOf('\n', index),
    )
    const declText = stripped.slice(declStart + 1, index + value.length)
    const reason = inlineReasonFor(line)
    // palette-hex kan ALDRIG tystas inline — annars vore den låsta paletten inte låst.
    if (reason !== null && rule !== 'palette-hex') {
      if (reason.length < INLINE_MIN_REASON) badInline.push({ line, value, reason })
      else inlineAllowed.push({ line, value, reason, rule })
      return
    }
    const category = classify({ value, relPath, lineText, declText, rule })
    hits[rule].push({ line, value, category })
  }

  const arbitrarySpans = []
  for (const m of stripped.matchAll(TW_ARBITRARY_RE)) {
    arbitrarySpans.push([m.index, m.index + m[0].length])
    push('tw-arbitrary', m.index, m[0])
  }

  for (const m of stripped.matchAll(HEX_RE)) {
    const value = m[0].toLowerCase()
    const rule = LOCKED_PALETTE.includes(value) ? 'palette-hex' : 'raw-hex'
    // En hex inuti `-[#..]` räknas i tw-arbitrary; undvik dubbelräkning i raw-hex.
    if (rule === 'raw-hex' && arbitrarySpans.some(([s, e]) => m.index >= s && m.index < e)) continue
    push(rule, m.index, m[0])
  }

  for (const m of stripped.matchAll(COLOR_FN_RE)) {
    push('raw-color-fn', m.index, m[0].replace(/\s+/g, ' '))
  }

  return { hits, inlineAllowed, badInline }
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
  const inline = []
  const badInline = []
  for (const { dir, ui } of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = toPosix(relative(ROOT, file))
      if (TOKEN_BINDING_FILES.includes(rel)) continue
      if (TEST_FILE_RE.test(rel)) continue
      const scanned = scanSource(readFileSync(file, 'utf8'), rel)
      const h = { ...scanned.hits }
      if (!ui) {
        h['raw-hex'] = []
        h['tw-arbitrary'] = []
        h['raw-color-fn'] = []
      }
      for (const x of scanned.inlineAllowed) inline.push({ rel, ...x })
      for (const x of scanned.badInline) badInline.push({ rel, ...x })
      // → { kategori: { regel: antal } }
      const byCategory = {}
      for (const [rule, list] of Object.entries(h)) {
        for (const hit of list) {
          const cat = hit.category ?? '__okänd__'
          byCategory[cat] ??= {}
          byCategory[cat][rule] = (byCategory[cat][rule] ?? 0) + 1
        }
      }
      if (Object.keys(byCategory).length) result[rel] = { byCategory, hits: h }
    }
  }
  return { files: result, inline, badInline }
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { files: {} }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline({ files }) {
  const out = {}
  for (const rel of Object.keys(files).sort()) {
    const cats = {}
    for (const [cat, rules] of Object.entries(files[rel].byCategory)) {
      // palette-hex och okategoriserade värden är HÅRDA → aldrig i allowlisten.
      if (cat === '__okänd__') continue
      const { 'palette-hex': _hard, ...rest } = rules
      if (Object.keys(rest).length) cats[cat] = rest
    }
    if (Object.keys(cats).length) out[rel] = cats
  }
  const perCategory = {}
  let total = 0
  for (const cats of Object.values(out)) {
    for (const [cat, rules] of Object.entries(cats)) {
      const n = Object.values(rules).reduce((a, b) => a + b, 0)
      perCategory[cat] = (perCategory[cat] ?? 0) + n
      total += n
    }
  }
  const payload = {
    $comment:
      'GENERERAD ALLOWLIST — FLIPP-SKULD, inte en regel-lucka. Varje post är rå ' +
      'färg som PR2–6 medvetet lämnade otokeniserad, knuten till en kategori i ' +
      'CATEGORIES (scripts/check-design-tokens.mjs) som säger VARFÖR den står kvar ' +
      'och HUR färgflippen tar bort den. CI faller på fler träffar — aldrig på ' +
      'färre. Listan ska krympa till noll när flippen är gjord.',
    $howto:
      'Städat en fil? Kör `node scripts/check-design-tokens.mjs --update-baseline` ' +
      'så snävas spärren åt. Lägg ALDRIG till rader här för hand för att tysta ett ' +
      'nytt fynd — en ny färg ska tokeniseras, inte allowlistas.',
    total,
    perCategory: Object.fromEntries(Object.entries(perCategory).sort((a, b) => b[1] - a[1])),
    files: out,
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return total
}

/** Allowlisten måste vara självförklarande: varje kategori den nämner ska ha why + flip. */
function validateBaselineShape(baseline) {
  const problems = []
  for (const [cat, meta] of Object.entries(CATEGORIES)) {
    if (!meta.why?.trim() || !meta.flip?.trim())
      problems.push(`kategorin "${cat}" saknar why/flip-motivering`)
  }
  for (const [rel, cats] of Object.entries(baseline.files ?? {})) {
    for (const cat of Object.keys(cats)) {
      if (cat === '__okänd__')
        problems.push(`${rel}: okategoriserat värde kan inte allowlistas`)
      else if (!CATEGORIES[cat]) problems.push(`${rel}: okänd kategori "${cat}"`)
    }
  }
  return problems
}

function run() {
  const { files: current, inline, badInline } = collect()
  const baseline = loadBaseline()
  const allowed = baseline.files ?? {}

  const shapeProblems = validateBaselineShape(baseline)
  if (shapeProblems.length) {
    console.error('\n❌ Designsystem: allowlisten är inte självförklarande\n')
    for (const p of shapeProblems) console.error(`  ${p}`)
    console.error('\nVarje post måste peka på en kategori i CATEGORIES med why + flip.\n')
    process.exit(1)
  }

  if (badInline.length) {
    console.error('\n❌ Designsystem: inline-undantag utan riktig motivering\n')
    for (const b of badInline)
      console.error(`  ${b.rel}:${b.line}  ${b.value}  → "${b.reason}"`)
    console.error(
      `\n\`design-tokens-allow:\` kräver minst ${INLINE_MIN_REASON} tecken som säger varför ` +
        'färgen ALDRIG ska tokeniseras (kunddata, falsk positiv). Är den bara otokeniserad ' +
        'än så länge hör den hemma i allowlisten, inte här.\n',
    )
    process.exit(1)
  }

  const regressions = []
  const unknowns = []
  const improvements = []

  for (const [rel, { byCategory, hits }] of Object.entries(current)) {
    for (const [cat, rules] of Object.entries(byCategory)) {
      for (const [rule, count] of Object.entries(rules)) {
        // Hårda regler: palette-hex och okända värden har alltid budget 0.
        const isHard = rule === 'palette-hex' || cat === '__okänd__'
        const budget = isHard ? 0 : (allowed[rel]?.[cat]?.[rule] ?? 0)
        if (count <= budget) continue
        const examples = hits[rule]
          .filter((h) => (h.category ?? '__okänd__') === cat)
          .slice(-(count - budget))
        ;(cat === '__okänd__' ? unknowns : regressions).push({
          rel,
          rule,
          cat,
          count,
          budget,
          examples,
        })
      }
    }
  }
  for (const [rel, cats] of Object.entries(allowed)) {
    for (const [cat, rules] of Object.entries(cats)) {
      for (const [rule, budget] of Object.entries(rules)) {
        const count = current[rel]?.byCategory?.[cat]?.[rule] ?? 0
        if (count < budget) improvements.push({ rel, cat, rule, count, budget })
      }
    }
  }

  if (unknowns.length || regressions.length) {
    console.error('\n❌ Designsystem: nya rå färgvärden utanför @eken/ui\n')
    for (const u of unknowns) {
      console.error(`  ${u.rel}  — NY FÄRG (finns inte i paletten och kan inte allowlistas)`)
      for (const ex of u.examples) console.error(`      rad ${ex.line}: ${ex.value}`)
    }
    for (const r of regressions) {
      console.error(`  ${r.rel}`)
      console.error(
        `    ${r.rule} / ${r.cat}: ${r.count} träffar (allowlist ${r.budget})` +
          (r.rule === 'palette-hex' ? '  ← LÅST PALETTVÄRDE (kan aldrig allowlistas)' : ''),
      )
      for (const ex of r.examples) console.error(`      rad ${ex.line}: ${ex.value}`)
    }
    console.error(
      '\nAnvänd en token i stället:\n' +
        '  Tailwind (web/admin):  bg-canvas | text-ink | text-ink-muted | border-line |\n' +
        '                         bg-brand | text-brand | bg-success | bg-warning | bg-danger\n' +
        '  CSS (portal + alla):   var(--ev-bg) | var(--ev-text) | var(--ev-border) | var(--ev-brand) …\n' +
        '  Varumärkesfärg i API/PDF/mejl: DEFAULT_BRAND_COLOR från @eken/shared\n' +
        'Saknas en token för ytan? Lägg en KOMPONENT-VARIABEL med palett-härledd default\n' +
        'i packages/ui/src/tokens.ts (se ADR:n) — hårdkoda inte hex.\n' +
        'Är färgen kunddata eller en falsk positiv? Sätt `design-tokens-allow: <varför>`\n' +
        'i en kommentar på raden (eller raden ovanför) — med en riktig motivering.\n',
    )
    process.exit(1)
  }

  const total = Object.values(allowed).reduce(
    (acc, cats) =>
      acc +
      Object.values(cats).reduce(
        (a, rules) => a + Object.values(rules).reduce((x, y) => x + y, 0),
        0,
      ),
    0,
  )
  console.warn(`✅ Designsystem: inga nya rå färgvärden (${total} kvar i flipp-skulden)`)
  if (inline.length) {
    console.warn(`   ${inline.length} inline-undantag (färger som aldrig ska tokeniseras):`)
    for (const x of inline) console.warn(`     ${x.rel}:${x.line}  ${x.value} — ${x.reason}`)
  }
  if (improvements.length) {
    console.warn(`   ${improvements.length} post(er) ligger UNDER allowlisten — snäva åt med:`)
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
  const cats = (h) => h.map((x) => x.category)

  const tsx = `
const a = <div className="border-[#EAEDF0] bg-white" />
const brand = '#1a6b3c'
// kommentar med #ff0000 ska INTE räknas
/* blockkommentar med #00ff00 heller */
const other = '#6b7280'
`
  const r1 = scanSource(tsx, 'apps/web/src/x.tsx')
  const h1 = r1.hits
  t('fångar tailwind -[#..]', h1['tw-arbitrary'].length === 1, JSON.stringify(h1['tw-arbitrary']))
  t('fångar låst palettvärde', h1['palette-hex'].length === 1, JSON.stringify(h1['palette-hex']))
  t(
    'räknar inte -[#..] en gång till som raw-hex',
    h1['raw-hex'].length === 1 && h1['raw-hex'][0].value === '#6b7280',
    JSON.stringify(h1['raw-hex']),
  )
  t(
    'ignorerar hex i rad-/blockkommentar',
    !JSON.stringify(h1).includes('ff0000') && !JSON.stringify(h1).includes('00ff00'),
  )
  t('klassificerar kända värden', cats(h1['raw-hex'])[0] === 'neutral-scale', String(cats(h1['raw-hex'])))
  t('klassificerar arbitrary-kant', cats(h1['tw-arbitrary'])[0] === 'input-border')

  const css = `
:root { --x: #d1d5db; }
/* mål #f6f4f0 → dagens #f7f8fa */
.a { color: #1A6B3C; }
`
  const h2 = scanSource(css, 'apps/portal/src/y.css').hits
  t('css: kommentar strippad', h2['palette-hex'].length === 1, JSON.stringify(h2['palette-hex']))
  t('css: skiftlägesokänslig palettmatchning', h2['palette-hex'][0].value === '#1A6B3C')
  t('css: övrig hex räknas', h2['raw-hex'].length === 1)

  const strings = `const s = "// inte en kommentar #111827"`
  const h3 = scanSource(strings, 'apps/web/src/z.ts').hits
  t('hex i sträng som liknar kommentar räknas', h3['raw-hex'].length === 1)

  const clean = `import { DEFAULT_BRAND_COLOR } from '@eken/shared'\nexport const c = DEFAULT_BRAND_COLOR`
  const h4 = scanSource(clean, 'apps/web/src/ok.ts').hits
  t(
    'ren fil ger noll fynd',
    Object.values(h4).every((l) => l.length === 0),
  )

  // NY FÄRG → okategoriserad → hård
  const novel = `const c = '#ff00ff'`
  const h5 = scanSource(novel, 'apps/web/src/new.tsx').hits
  t('okänd färg blir okategoriserad (hård)', h5['raw-hex'][0].category === null)

  // rgb()/hsl() — tidigare öppen kringgång
  t('låst palettvärde får egen kategori', h1['palette-hex'][0].category === 'locked-palette')

  // Samma rad, två olika synder — klassificeringen måste vara deklarationsnära.
  const fn = `.a { background: rgb(37, 99, 235); box-shadow: 0 1px 2px rgba(0,0,0,.06); }`
  const h6 = scanSource(fn, 'apps/web/src/f.css').hits
  t('fångar rgb()/rgba()', h6['raw-color-fn'].length === 2, JSON.stringify(h6['raw-color-fn'].map(x=>x.value)))
  t(
    'skiljer skugg-rgba från färg-rgb',
    h6['raw-color-fn'][0].category === 'neutral-scale' &&
      h6['raw-color-fn'][1].category === 'shadow-alpha',
    String(cats(h6['raw-color-fn'])),
  )

  // inline-undantag
  const inl = `const c = '#ff00ff' // design-tokens-allow: kunddata, färgen väljs av hyresvärden och sparas i DB`
  const r7 = scanSource(inl, 'apps/web/src/i.tsx')
  t('inline-undantag tystar fyndet', r7.hits['raw-hex'].length === 0 && r7.inlineAllowed.length === 1)
  const inlShort = `const c = '#ff00ff' // design-tokens-allow: nej`
  const r8 = scanSource(inlShort, 'apps/web/src/i2.tsx')
  t('inline-undantag utan riktig motivering avvisas', r8.badInline.length === 1)
  const inlPalette = `const c = '#1a6b3c' // design-tokens-allow: försöker tysta det låsta palettvärdet`
  const r9 = scanSource(inlPalette, 'apps/web/src/i3.tsx')
  t('inline-undantag biter INTE på palette-hex', r9.hits['palette-hex'].length === 1)

  // alfa-konkatenering vinner över värdetabellen
  const alpha = `<div style={{ background: \`\${iconColor}14\` }} />`
  const h10 = scanSource(alpha.replace('iconColor', "'#2563EB'"), 'apps/web/src/a.tsx').hits
  t('alfa-konkat klassas som alpha-concat', h10['raw-hex'][0]?.category === 'alpha-concat', String(cats(h10['raw-hex'])))

  t('token-bindande filer är undantagna', TOKEN_BINDING_FILES.length === 3)
  t('packages/ui skannas aldrig', !SCAN_ROOTS.some((r) => r.dir.startsWith('packages/ui')))
  t(
    'API/shared skannas bara för palette-hex',
    SCAN_ROOTS.filter((r) => !r.ui).map((r) => r.dir).join(',') === 'apps/api/src,packages/shared/src',
  )
  t('testfiler undantas', TEST_FILE_RE.test('apps/api/src/x.spec.ts') && !TEST_FILE_RE.test('apps/api/src/x.ts'))

  // allowlistens form
  const baseline = loadBaseline()
  t('allowlisten validerar (varje post har why + flip)', validateBaselineShape(baseline).length === 0,
    validateBaselineShape(baseline).slice(0, 3).join('; '))
  const hardBaselined = Object.values(baseline.files ?? {}).some((cats) =>
    Object.values(cats).some((rules) => 'palette-hex' in rules),
  )
  t('palette-hex finns inte i allowlisten', !hardBaselined)
  t('varje kategori har why + flip', Object.values(CATEGORIES).every((c) => c.why && c.flip))

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

const arg = process.argv[2]
if (arg === '--self-test') selfTest()
else if (arg === '--update-baseline') {
  const total = writeBaseline(collect())
  console.warn(`Allowlist uppdaterad: ${total} kvarvarande träffar (flipp-skuld).`)
} else run()
