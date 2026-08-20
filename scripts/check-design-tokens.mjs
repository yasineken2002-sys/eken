#!/usr/bin/env node
/**
 * CI-guard (designsystem PR7) — håller den låsta paletten låst FRAMÅT.
 *
 * PR2–4 band apparnas färger till `--ev-*`-tokens, PR5–6 flyttade Modal och
 * DataTable till @eken/ui. Inget av det hindrar att nästa feature-PR skriver
 * `text-[#2563EB]` eller `background: #1a6b3c` igen — och varje sådan rad är en
 * yta som färgflippen INTE når. Den här guarden är spärren.
 *
 * ── Fyra lager ──────────────────────────────────────────────────────────────
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
 * 4. OMAPPADE TAILWIND-FAMILJER (#532) — lagren ovan fäller FÄRGLITERALER och
 *    kan därför inte se `bg-purple-50`: kulören sitter i Tailwinds palett, inte
 *    i strängen. Regeln HÄRLEDER mappade familjer ur varje apps tailwind.config
 *    och fäller varje familj som används men inte är mappad mot en @eken/ui-skala.
 *    Baslinjen (scripts/design-families.baseline.json) fäller åt BÅDA hållen —
 *    se motiveringen vid FAMILY_MIN_REASON. Portalen kör ingen Tailwind och är
 *    undantagen, men undantaget är BEVAKAT: dyker en config upp faller guarden.
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
const FAMILY_BASELINE_PATH = join(HERE, 'design-families.baseline.json')

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
// Ett nivås nästning måste med, annars kapas `rgb(var(--ev-brand-500-ch) / .12)`
// vid den INRE parentesen och matchen blir den obalanserade `rgb(var(--ev-brand-500-ch`
// — då kan kanalformen inte kännas igen (F5).
//
// GRINDHÅL som stängs här (F5): startgränsen var `\b`, och i en Tailwind-arbitrary
// separeras värden med UNDERSTRECK — `shadow-[0_1px_2px_rgba(37,99,235,0.3)]`. Mellan
// `_` och `r` står två ordtecken, alltså ingen ordgräns, alltså ingen match: hela
// familjen rgba-i-arbitrary har varit osynlig för grinden. Primärknappens blå skugga
// låg där. `(?<![a-zA-Z0-9])` släpper igenom efter `_` men fångar inte `myrgb(`.
const COLOR_FN_RE = /(?<![a-zA-Z0-9])(?:rgba?|hsla?)\(\s*(?:[^()]|\([^()]*\))*\)/g

/**
 * Inline-undantag:
 *   `design-tokens-allow: <motivering>`        — samma rad eller raden ovanför
 *   `design-tokens-allow-start: <motivering>`  — öppnar ett block …
 *   `design-tokens-allow-end`                  — … som stängs här
 * Alltid i en kommentar, alltid med motivering.
 */
/**
 * `rgb(var(--ev-brand-500-ch) / 0.12)` — token + alfa, inte en rå färg.
 * Kräver minst en `var(--ev-…)` och att INGET annat än var()-referenser,
 * separatorer och ett alfatal står i argumenten.
 */
export function isTokenizedColorFn(text) {
  const args = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))
  if (!/var\(\s*--ev-/.test(args)) return false
  const withoutVars = args.replace(/var\(\s*--ev-[a-z0-9-]+\s*\)/g, '')
  return /^[\s,/]*(?:0?\.\d+|[01](?:\.\d+)?|\d{1,3}%)?[\s,/]*$/.test(withoutVars)
}

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

// ─────────────────────────────────────────────────────────────────────────────
// LAGER 4 — OMAPPADE TAILWIND-FAMILJER (#532). Samma fråga, en nivå upp.
// ─────────────────────────────────────────────────────────────────────────────
//
// Reglerna ovan fäller FÄRGLITERALER. De kan inte fälla `bg-purple-50`, för det
// finns ingen färg i strängen att matcha — kulören sitter i Tailwinds egen
// palett. Följden är att en färg kan vara FEL utan att någon vakt märker det.
//
// F1/F2 löste det för de familjer man då kom ihåg: appens tailwind.config pekar
// `gray`/`blue`/`emerald`/`amber`/`red` på @eken/ui:s härledda skalor, så
// `text-gray-500` slår upp var(--ev-neutral-500) och blir varm av sig själv.
// Men INGENTING bevakade att listan var komplett. `tokens.ts` beskrev
// mekanismen redan då — "osynliga för färggrinden (ingen rå hex) men lika kalla
// som de hex-värden grinden fångar" — och ändå glred sju familjer igenom.
//
// Regeln spärrar FORMEN, inte uppräkningen: mängden mappade familjer HÄRLEDS ur
// varje apps tailwind.config.ts. Det finns med flit ingen lista här att glömma
// uppdatera. Mappar någon en ny familj krymper spärren av sig själv; inför någon
// en ny OMAPPAD familj faller den, även om ingen tänkt på just den kulören.

/** Tailwinds stock-palett. Namnrymden vi letar i — inte en policy, en definition. */
const TAILWIND_STOCK_FAMILIES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
]

/**
 * Utility-prefix som tar en färg. Härledd EMPIRISKT ur kodbasen (bg/text/border/
 * ring/divide/placeholder/from/to + border-l), och sedan breddad med de övriga
 * färgtagande prefixen så att en ny användning inte hamnar utanför mätningen.
 *
 * `border-[trblxy]` måste stå FÖRE `border` i alternationen — annars matchar
 * `border` först i `border-l-amber-500` och `l-amber-500` blir aldrig ett prefix.
 */
const COLOR_UTILITY_PREFIXES =
  'bg|text|border-[trblxy]|border|ring-offset|ring|divide|placeholder|from|via|to|' +
  'outline|decoration|accent|caret|shadow|fill|stroke'

/**
 * `bg-purple-50`, `hover:text-violet-600`, `border-l-amber-500`, `bg-gray-50/60`.
 *
 * `(?<![\w-])` före prefixet är inte kosmetika: den skiljer en utility från en
 * CSS-variabel. `--ev-neutral-500` innehåller bokstavligen en stock-familj
 * (`neutral`) och hade annars räknats som omappad användning — en falsk positiv
 * på precis det tokensystem regeln finns för att skydda.
 */
const FAMILY_CLASS_RE = new RegExp(
  `(?<![\\w-])(?:${COLOR_UTILITY_PREFIXES})-(${TAILWIND_STOCK_FAMILIES.join('|')})-\\d{2,3}(?![\\w-])`,
  'g',
)

/**
 * Appar som KÖR Tailwind → familjeregeln gäller. `config` läses för att härleda
 * de mappade familjerna.
 */
const FAMILY_SCAN_APPS = [
  { app: 'web', dir: 'apps/web/src', config: 'apps/web/tailwind.config.ts' },
  { app: 'admin', dir: 'apps/admin/src', config: 'apps/admin/tailwind.config.ts' },
]

/**
 * Appar som INTE kör Tailwind. Portalen konsumerar de råa CSS-variablerna
 * (`color: var(--ev-neutral-500)`) och har varken tailwind.config, postcss.config
 * eller tailwind-beroende — det finns alltså ingen familjemappning att sakna, och
 * `bg-purple-50` i portalen skulle inte generera någon CSS över huvud taget.
 *
 * Men "gäller inte" får inte betyda "faller ut tyst". Får portalen Tailwind
 * någon gång är den oskyddad utan att något blir rött — samma blinda vakt som
 * hela det här ärendet handlar om. Därför BEVAKAS undantaget: dyker en config
 * upp faller guarden och säger åt dig att flytta appen till FAMILY_SCAN_APPS.
 */
const NO_TAILWIND_APPS = [
  {
    app: 'portal',
    why: 'kör ingen Tailwind — läser var(--ev-*) direkt ur tokens.css',
    configCandidates: [
      'apps/portal/tailwind.config.ts',
      'apps/portal/tailwind.config.js',
      'apps/portal/tailwind.config.cjs',
      'apps/portal/tailwind.config.mjs',
    ],
  },
]

/**
 * Mappade familjer HÄRLEDS ur configtexten: `gray: evenoScales.neutral`.
 * Exporterad så självtestet kör exakt samma härledning som CI.
 */
export function mappedFamiliesFrom(configText) {
  const stripped = stripComments(configText, '.ts')
  const found = new Set()
  for (const m of stripped.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*evenoScales\s*\.\s*([\w$]+)/g)) {
    found.add(m[1])
  }
  return found
}

/** Familjeträffar i EN fil. Kommentarer strippas, precis som för färgliteraler. */
export function scanFamilies(rawText, relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.'))
  const stripped = stripComments(rawText, ext)
  const hits = []
  for (const m of stripped.matchAll(FAMILY_CLASS_RE)) {
    hits.push({ line: lineOf(stripped, m.index), family: m[1], value: m[0] })
  }
  return hits
}

/**
 * Hela familjemätningen → { entries: { "<app>/<familj>": {count, examples} }, mapped }.
 * `entries`-nyckeln är app-scopad: samma familj kan vara mappad i web och omappad
 * i admin, och då är det bara admin som är fel.
 */
export function collectFamilies() {
  const entries = {}
  const mapped = {}
  const missingConfigs = []
  for (const { app, dir, config } of FAMILY_SCAN_APPS) {
    const configPath = join(ROOT, config)
    if (!existsSync(configPath)) {
      missingConfigs.push(config)
      continue
    }
    const families = mappedFamiliesFrom(readFileSync(configPath, 'utf8'))
    mapped[app] = [...families].sort()
    for (const file of walk(join(ROOT, dir))) {
      const rel = toPosix(relative(ROOT, file))
      if (TEST_FILE_RE.test(rel)) continue
      for (const hit of scanFamilies(readFileSync(file, 'utf8'), rel)) {
        if (families.has(hit.family)) continue
        const key = `${app}/${hit.family}`
        entries[key] ??= { count: 0, examples: [] }
        entries[key].count++
        if (entries[key].examples.length < 3)
          entries[key].examples.push(`${rel}:${hit.line} ${hit.value}`)
      }
    }
  }
  // Appar utan Tailwind: undantaget ska vara bevakat, inte underförstått.
  const unexpectedTailwind = []
  for (const { app, configCandidates } of NO_TAILWIND_APPS) {
    for (const c of configCandidates) {
      if (existsSync(join(ROOT, c))) unexpectedTailwind.push({ app, config: c })
    }
  }
  return { entries, mapped, missingConfigs, unexpectedTailwind }
}

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
    // TOKENISERAD KANALFORM är inte en rå färg (F5). `rgb(var(--ev-brand-500-ch) / 0.12)`
    // är det ENDA sättet att ge en token-färg alfa: en hex bakom var() kan inte delas
    // upp, och color-mix() avviker ±1 i kompositeringen. Räknades den som skuld skulle
    // grinden straffa exakt det mönster den finns för att driva fram — och den enda
    // vägen att bli av med posten vore att gå tillbaka till literal rgb().
    // Snävt med flit: BARA var(--ev-*) + alfa passerar. `rgb(37 99 235 / .12)` och
    // `rgb(var(--nagot-annat))` faller som förut.
    if (isTokenizedColorFn(m[0])) continue
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

/**
 * ── FAMILJEBASLINJEN FÄLLER ÅT BÅDA HÅLLEN ──────────────────────────────────
 *
 * Flipp-skuldens allowlist ovan fäller bara UPPÅT: fler träffar är en regression,
 * färre är framsteg. Det är rätt för den, eftersom den listan är arbete som
 * pågår och ska krympa mot noll.
 *
 * Den HÄR baslinjen är något annat: den är ett PÅSTÅENDE om vad som finns. Ett
 * påstående som bara kan bli fel åt ena hållet slutar vara ett påstående. Städar
 * någon bort tio purple-klasser och posten står kvar på 25, då beskriver
 * baslinjen en kodbas som inte längre existerar — och nästa läsare tror att
 * skulden är större än den är. Värre: en post vars familj städats bort HELT blir
 * en evigt grön rad om ingen kollar nedåt.
 *
 * Därför krävs EXAKT LIKHET. Samma form som kvitteringsfilen i #513: den ska
 * fälla på okvitterat problem OCH på kvittering utan problem, annars överlever
 * listan sin egen sanning.
 *
 * Priset är att #531 måste köra `--update-baseline` när purple mappas. Det är
 * poängen, inte en olägenhet.
 */
const FAMILY_MIN_REASON = 30

function loadFamilyBaseline() {
  if (!existsSync(FAMILY_BASELINE_PATH)) return { entries: {} }
  return JSON.parse(readFileSync(FAMILY_BASELINE_PATH, 'utf8'))
}

function writeFamilyBaseline({ entries }) {
  const previous = loadFamilyBaseline().entries ?? {}
  const out = {}
  for (const key of Object.keys(entries).sort()) {
    out[key] = {
      count: entries[key].count,
      // Skälet är MÄNNISKANS text och ska överleva en omräkning. En ny post får
      // en tydlig platshållare som guarden sedan avvisar tills den fyllts i —
      // annars hade --update-baseline kunnat tysta ett nytt fynd automatiskt.
      reason:
        previous[key]?.reason ??
        'SKÄL SAKNAS — beskriv varför familjen är omappad och vad som ska hända med den',
      examples: entries[key].examples,
    }
  }
  const payload = {
    $comment:
      'GENERERAD BASLINJE — omappade Tailwind-familjer (#532). Varje post är en ' +
      'färgfamilj som ANVÄNDS i klassnamn men inte är mappad mot en @eken/ui-skala ' +
      'i appens tailwind.config.ts, och som därför renderar Tailwinds stock-kulör ' +
      'i stället för den varma paletten. Mängden mappade familjer HÄRLEDS ur ' +
      'configen — det finns ingen lista i guarden att glömma uppdatera.',
    $howto:
      'Denna baslinje fäller åt BÅDA hållen: fler träffar OCH färre. Har du mappat ' +
      'eller städat en familj, kör `node scripts/check-design-tokens.mjs ' +
      '--update-baseline` så att listan fortsätter beskriva verkligheten. Lägg ' +
      'ALDRIG till en post för hand för att tysta ett nytt fynd — mappa familjen.',
    total: Object.values(entries).reduce((a, e) => a + e.count, 0),
    entries: out,
  }
  writeFileSync(FAMILY_BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return payload.total
}

/**
 * Jämför mätning mot baslinje. Returnerar problem i tre former:
 *   nya      — familj som används men saknas i baslinjen (eller fler träffar)
 *   stale    — baslinjepost utan motsvarande användning (eller färre träffar)
 *   utan skäl— post som saknar en riktig motivering
 * Exporterad så självtestet kör exakt samma jämförelse som CI.
 */
export function diffFamilies(measured, baseline) {
  const base = baseline.entries ?? {}
  const nya = []
  const stale = []
  const utanSkal = []
  for (const [key, entry] of Object.entries(measured)) {
    const b = base[key]
    if (!b) {
      nya.push({ key, count: entry.count, budget: 0, examples: entry.examples })
    } else if (entry.count > b.count) {
      nya.push({ key, count: entry.count, budget: b.count, examples: entry.examples })
    } else if (entry.count < b.count) {
      stale.push({ key, count: entry.count, budget: b.count })
    }
  }
  for (const [key, b] of Object.entries(base)) {
    if (!measured[key]) stale.push({ key, count: 0, budget: b.count })
    if (
      !b.reason?.trim() ||
      b.reason.trim().length < FAMILY_MIN_REASON ||
      /SKÄL SAKNAS/.test(b.reason)
    )
      utanSkal.push(key)
  }
  return { nya, stale, utanSkal }
}

/** Familjelagret. Returnerar true om allt är grönt. */
function runFamilies() {
  const { entries, mapped, missingConfigs, unexpectedTailwind } = collectFamilies()
  const baseline = loadFamilyBaseline()

  if (missingConfigs.length) {
    console.error('\n❌ Designsystem: tailwind.config saknas för en app som skulle skannas\n')
    for (const c of missingConfigs) console.error(`  ${c}`)
    console.error(
      '\nUtan configen går mappade familjer inte att härleda, och regeln\nhade tyst slutat mäta appen. Rätta sökvägen i FAMILY_SCAN_APPS.\n',
    )
    return false
  }

  if (unexpectedTailwind.length) {
    console.error('\n❌ Designsystem: en app utan Tailwind har fått en tailwind.config\n')
    for (const u of unexpectedTailwind) console.error(`  ${u.app}: ${u.config}`)
    console.error(
      '\nAppen stod i NO_TAILWIND_APPS och undantogs därför från familjeregeln.\n' +
        'Nu kör den Tailwind och är alltså OSKYDDAD. Flytta den till FAMILY_SCAN_APPS.\n',
    )
    return false
  }

  const { nya, stale, utanSkal } = diffFamilies(entries, baseline)

  if (utanSkal.length) {
    console.error('\n❌ Designsystem: familjebaslinjen har poster utan riktigt skäl\n')
    for (const k of utanSkal) console.error(`  ${k}`)
    console.error(
      `\nVarje post kräver minst ${FAMILY_MIN_REASON} tecken som säger varför familjen är\n` +
        'omappad och vad som ska hända med den (mappas, kollapsas, tas bort).\n',
    )
    return false
  }

  if (nya.length || stale.length) {
    if (nya.length) {
      console.error('\n❌ Designsystem: omappad Tailwind-färgfamilj\n')
      for (const n of nya) {
        console.error(`  ${n.key}: ${n.count} klasser (baslinje ${n.budget})`)
        for (const ex of n.examples) console.error(`      ${ex}`)
      }
      console.error(
        '\nFamiljen används i klassnamn men är inte mappad mot en @eken/ui-skala i\n' +
          'appens tailwind.config.ts. Den renderar alltså Tailwinds stock-kulör — kall,\n' +
          'mitt i den varma paletten — och INGEN annan regel kan se det: det finns\n' +
          'ingen färgliteral i `bg-purple-50` att matcha.\n\n' +
          'Rätt åtgärd är att mappa familjen:\n' +
          '  colors: { purple: evenoScales.<skala> }   i apps/<app>/tailwind.config.ts\n' +
          'eller att använda en redan mappad familj. Att lägga till en baslinjepost för\n' +
          'hand är INTE en åtgärd.\n',
      )
    }
    if (stale.length) {
      console.error('\n❌ Designsystem: familjebaslinjen beskriver kod som inte finns\n')
      for (const st of stale)
        console.error(`  ${st.key}: baslinje ${st.budget}, faktisk användning ${st.count}`)
      console.error(
        '\nPosten påstår mer än vad kodbasen innehåller. En baslinje som bara kan bli\n' +
          'fel åt ena hållet slutar vara ett påstående — därför fäller den här åt BÅDA.\n' +
          'Har du mappat eller städat familjen: node scripts/check-design-tokens.mjs --update-baseline\n',
      )
    }
    return false
  }

  const total = Object.values(entries).reduce((a, e) => a + e.count, 0)
  const mappedText = Object.entries(mapped)
    .map(([app, fams]) => `${app}: ${fams.join('/')}`)
    .join(' · ')
  console.warn(
    `✅ Designsystem: inga nya omappade färgfamiljer (${total} klasser i ${Object.keys(entries).length} poster)`,
  )
  console.warn(`   mappade familjer (härledda ur tailwind.config): ${mappedText}`)
  for (const { app, why } of NO_TAILWIND_APPS)
    console.warn(`   ${app} undantagen och BEVAKAD — ${why}`)
  return true
}

function run() {
  let familiesOk = true
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
    // Kör familjelagret ändå: en PR ska se BÅDA problemen i en körning, inte
    // laga färgen, pusha, och först då få veta att familjen också är fel.
    runFamilies()
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
  // Familjelagret körs ALLTID, även när färglagret är grönt — det är en egen fråga.
  familiesOk = runFamilies()
  if (inline.length) {
    console.warn(`   ${inline.length} inline-undantag (färger som aldrig ska tokeniseras):`)
    for (const x of inline) console.warn(`     ${x.rel}:${x.line}  ${x.value} — ${x.reason}`)
  }
  if (improvements.length) {
    console.warn(`   ${improvements.length} post(er) ligger UNDER allowlisten — snäva åt med:`)
    console.warn('   node scripts/check-design-tokens.mjs --update-baseline')
  }
  if (!familiesOk) process.exit(1)
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

  // Kanalform (F5): token + alfa ska INTE räknas som rå färg.
  const chan = `.a { background: rgb(var(--ev-brand-500-ch) / 0.12); }`
  t('kanalform räknas inte som rå färg', scanSource(chan, 'apps/web/src/c.css').hits['raw-color-fn'].length === 0)
  const chanNoAlpha = `.a { color: rgb(var(--ev-neutral-500-ch)); }`
  t('kanalform utan alfa passerar också', scanSource(chanNoAlpha, 'apps/web/src/c2.css').hits['raw-color-fn'].length === 0)
  const fakeToken = `.a { background: rgb(var(--nagot-annat) / 0.12); }`
  t('var() som inte är --ev-* faller fortfarande', scanSource(fakeToken, 'apps/web/src/c3.css').hits['raw-color-fn'].length === 1)
  const litChannels = `.a { background: rgb(37 99 235 / 0.12); }`
  t('literala kanaler faller fortfarande', scanSource(litChannels, 'apps/web/src/c4.css').hits['raw-color-fn'].length === 1)
  const mixedArgs = `.a { background: rgb(var(--ev-brand-500-ch) 99 235); }`
  t('var() blandad med literala kanaler faller', scanSource(mixedArgs, 'apps/web/src/c5.css').hits['raw-color-fn'].length === 1)
  // Grindhålet: rgba inuti en Tailwind-arbitrary (understreck före) ska fångas.
  const twShadow = `const c = 'shadow-[0_1px_2px_rgba(37,99,235,0.3)]'`
  const hTw = scanSource(twShadow, 'apps/web/src/tw.tsx').hits['raw-color-fn']
  t('rgba i tw-arbitrary (efter understreck) fångas', hTw.length === 1, JSON.stringify(hTw.map((x) => x.value)))
  t('och klassas som shadow-alpha', hTw[0]?.category === 'shadow-alpha', String(hTw[0]?.category))
  const notAColorFn = `const myrgb = 1; const x = myrgb(2)`
  t('identifierare som slutar på rgb matchas inte', scanSource(notAColorFn, 'apps/web/src/id.ts').hits['raw-color-fn'].length === 0)

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


  // ── FAMILJELAGRET (#532) ──────────────────────────────────────────────────
  const cfg = `
    colors: {
      gray: evenoScales.neutral,
      blue: evenoScales.brand,
      emerald: evenoScales.success,
      // amber: evenoScales.warning,   ← bortkommenterad, ska INTE räknas som mappad
      input: 'var(--ev-input-border)',
    }
  `
  const fam = mappedFamiliesFrom(cfg)
  t(
    'härleder mappade familjer ur configen',
    fam.has('gray') && fam.has('blue') && fam.has('emerald'),
    [...fam].join(','),
  )
  t('bortkommenterad mappning räknas INTE som mappad', !fam.has('amber'))
  t('icke-skal-mappning (var()) räknas inte som familj', !fam.has('input'))

  const famTsx = `
const a = <div className="bg-purple-50 hover:text-violet-600 border-l-amber-500" />
const b = <div className="bg-gray-50/60 focus-visible:ring-blue-500/40" />
// bg-fuchsia-500 i en kommentar ska INTE räknas
const css = 'color: var(--ev-neutral-500)'
`
  const fh = scanFamilies(famTsx, 'apps/web/src/f.tsx')
  const fams = fh.map((h) => h.family)
  t('fångar bg-purple-50', fams.includes('purple'), fams.join(','))
  t('fångar prefix med variant (hover:text-violet-600)', fams.includes('violet'))
  t('fångar border-l-<familj> (prefixordningen)', fams.includes('amber'))
  t(
    'fångar familj med alfa-modifierare (bg-gray-50/60)',
    fams.filter((x) => x === 'gray').length === 1,
  )
  t('familj i kommentar räknas inte', !fams.includes('fuchsia'))
  // Den falska positiven som hade träffat själva tokensystemet:
  t('--ev-neutral-500 är INTE en familjeträff', !fams.includes('neutral'), fams.join(','))
  const evOnly = scanFamilies(
    `.a { color: var(--ev-neutral-500); border-color: var(--ev-neutral-200); }`,
    'apps/web/src/e.css',
  )
  t('CSS med bara --ev-* ger noll familjeträffar', evOnly.length === 0, JSON.stringify(evOnly))

  // diffFamilies — BÅDA hållen
  const base = { entries: { 'web/purple': { count: 2, reason: 'x'.repeat(FAMILY_MIN_REASON) } } }
  t(
    'ny omappad familj fälls',
    diffFamilies({ 'web/teal': { count: 1, examples: [] } }, base).nya.length === 1,
  )
  t(
    'fler träffar än baslinjen fälls',
    diffFamilies({ 'web/purple': { count: 3, examples: [] } }, base).nya.length === 1,
  )
  t(
    'FÄRRE träffar än baslinjen fälls också (stale)',
    diffFamilies({ 'web/purple': { count: 1, examples: [] } }, base).stale.length === 1,
  )
  t(
    'baslinjepost utan någon användning alls fälls (stale)',
    diffFamilies({}, base).stale.length === 1,
  )
  t(
    'exakt likhet är grönt',
    (() => {
      const d = diffFamilies({ 'web/purple': { count: 2, examples: [] } }, base)
      return d.nya.length === 0 && d.stale.length === 0
    })(),
  )
  t(
    'post utan riktigt skäl fälls',
    diffFamilies({}, { entries: { 'web/purple': { count: 0, reason: 'kort' } } }).utanSkal
      .length === 1,
  )
  t(
    'platshållarskäl fälls',
    diffFamilies(
      {},
      {
        entries: {
          'web/x': {
            count: 0,
            reason:
              'SKÄL SAKNAS — beskriv varför familjen är omappad och vad som ska hända med den',
          },
        },
      },
    ).utanSkal.length === 1,
  )

  // Undantaget för appar utan Tailwind ska vara BEVAKAT, inte underförstått.
  const famState = collectFamilies()
  t(
    'portal står som app utan Tailwind',
    NO_TAILWIND_APPS.some((a) => a.app === 'portal'),
  )
  t(
    'portal har faktiskt ingen tailwind.config',
    famState.unexpectedTailwind.length === 0,
    JSON.stringify(famState.unexpectedTailwind),
  )
  t(
    'båda Tailwind-apparna har en config som gick att läsa',
    famState.missingConfigs.length === 0,
    famState.missingConfigs.join(','),
  )
  t(
    'familjeregeln täcker web OCH admin',
    FAMILY_SCAN_APPS.map((a) => a.app).join(',') === 'web,admin',
  )

  // Baslinjen på disk måste vara internt konsistent.
  const famBase = loadFamilyBaseline()
  t(
    'familjebaslinjen matchar verkligheten exakt',
    (() => {
      const d = diffFamilies(famState.entries, famBase)
      return d.nya.length === 0 && d.stale.length === 0 && d.utanSkal.length === 0
    })(),
    JSON.stringify(diffFamilies(famState.entries, famBase)).slice(0, 200),
  )
  t(
    'varje familjepost har ett riktigt skäl',
    Object.values(famBase.entries ?? {}).every(
      (e) => e.reason && e.reason.trim().length >= FAMILY_MIN_REASON,
    ),
  )
  t(
    'purple-posten pekar på sitt ärende',
    /#531/.test(famBase.entries?.['web/purple']?.reason ?? ''),
  )

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

const arg = process.argv[2]
if (arg === '--self-test') selfTest()
else if (arg === '--update-baseline') {
  const total = writeBaseline(collect())
  console.warn(`Allowlist uppdaterad: ${total} kvarvarande träffar (flipp-skuld).`)
  const famTotal = writeFamilyBaseline(collectFamilies())
  console.warn(`Familjebaslinje uppdaterad: ${famTotal} klasser i omappade familjer.`)
} else run()
