#!/usr/bin/env node
/**
 * MASKERINGSLOGIKEN FÅR FINNAS PÅ ETT STÄLLE (#545).
 *
 * ── Varför vakten finns ─────────────────────────────────────────────────────
 *
 * `redactSensitive` fanns i två exemplar med identiska fältlistor men olika
 * kroppar: `Prisma.Decimal`-grenen från #168 (main `9f61bf1`) nådde bara
 * ägar-kopian. Hyresgäst-kopian stod utan den i sju månader, och ingenting i
 * kodbasen kunde se det.
 *
 * Två kopior av en maskeringsregel är värre än två kopior av vad som helst
 * annat: den dag ett mönster läggs till i den ena tror alla att det gäller
 * överallt, och den yta som glömdes läcker tyst. Sammanslagningen löser dagens
 * två — vakten är det som gör att en tredje inte kan uppstå.
 *
 * ── Vad som fälls ───────────────────────────────────────────────────────────
 *
 * 1. En andra DEFINITION av funktionen (`function redactSensitive`) utanför den
 *    kanoniska modulen. Anrop och importer är förstås fria.
 * 2. En andra fältlista — en samling literaler som innehåller minst
 *    `MIN_FIELD_OVERLAP` av de kanoniska fältnamnen.
 *
 * Punkt 2 finns för att en kopia inte behöver heta samma sak. En `scrubOutput`
 * eller `sanitizeToolResult` med samma lista är exakt samma defekt, och en regel
 * som bara letar efter NAMNET hade missat den. Det är samma läxa som formvakten
 * i #533: spärra formen, inte uppräkningen.
 *
 * ── Varför inte "identisk kod" ──────────────────────────────────────────────
 *
 * En textjämförelse mot den kanoniska funktionen hade bara fällt exakta kopior,
 * och en kopia som drivit isär är den farliga varianten — det var ju precis så
 * de två divergerade. Fältöverlappet fäller på det som gör kopian till en kopia.
 *
 * Kör:        node apps/api/scripts/check-redact-copies.mjs
 * Självtest:  node apps/api/scripts/check-redact-copies.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_ROOT = join(HERE, '..')
const SRC = join(API_ROOT, 'src')

/** Den enda filen som får definiera maskeringen. */
export const CANONICAL = 'common/redaction/redact-sensitive.ts'

/**
 * Så många kanoniska fältnamn i EN literal-samling räcker för att kalla det en
 * kopia. Tre är valt så att en fil som råkar nämna `token` och `apiKey` i annat
 * ärende inte fälls, medan en avskriven lista gör det: de två kopiorna hade
 * elva av elva.
 */
export const MIN_FIELD_OVERLAP = 3

/**
 * Markören `redact-copy-allow:` kräver ett skäl. En markör utan motivering är
 * en tyst avstängning — och de undantagna filerna RÄKNAS UPP i den gröna
 * utskriften, så att listan aldrig blir osynlig.
 */
export const MIN_REASON = 25

/** Fältnamnen som HÄRLEDS ur den kanoniska modulen — ingen andra lista här. */
export function canonicalFields(text) {
  const m = text.match(/SENSITIVE_FIELD_NAMES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)
  if (!m) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

function tsFiles(dir) {
  const ut = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) ut.push(...tsFiles(full))
    else if (namn.endsWith('.ts')) ut.push(full)
  }
  return ut
}

/**
 * Hittar kopior i en filtext.
 *
 * `.spec.ts` undantas INTE generellt: ett test får gärna innehålla en avskriven
 * kopia som jämförelsepunkt, men bara om det säger det. Filer som bär markören
 * `redact-copy-allow:` med en motivering hoppas över — samma inline-form som
 * design-token-vakten använder.
 */
export function findCopies(text, fields, { rel } = {}) {
  const problem = []
  if (rel === CANONICAL) return problem
  const markör = text.match(/redact-copy-allow:\s*(.+)/)
  if (markör && markör[1].trim().length >= MIN_REASON) return problem

  if (/function\s+redactSensitive\b/.test(text)) {
    problem.push({ kind: 'definition', detalj: 'function redactSensitive' })
  }

  // Literal-samlingar: new Set([...]) eller [...] med citerade strängar.
  for (const m of text.matchAll(/(?:new Set\(\[|\[)([\s\S]{0,600}?)\]/g)) {
    const literaler = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    const överlapp = literaler.filter((l) => fields.includes(l))
    if (överlapp.length >= MIN_FIELD_OVERLAP) {
      problem.push({ kind: 'fältlista', detalj: `${överlapp.length} kanoniska fältnamn` })
    }
  }
  return problem
}

export function scanTree(root = SRC) {
  const kanonisk = readFileSync(join(root, CANONICAL), 'utf8')
  const fields = canonicalFields(kanonisk)
  if (fields.length === 0) {
    throw new Error('Kunde inte läsa fältlistan ur den kanoniska modulen — vakten mäter ingenting.')
  }
  const fynd = []
  const undantagna = []
  for (const full of tsFiles(root)) {
    const rel = relative(root, full).split(sep).join('/')
    const text = readFileSync(full, 'utf8')
    const markör = text.match(/redact-copy-allow:\s*(.+)/)
    if (rel !== CANONICAL && markör && markör[1].trim().length >= MIN_REASON) {
      undantagna.push({ rel, skäl: markör[1].trim() })
    }
    for (const p of findCopies(text, fields, { rel })) fynd.push({ rel, ...p })
  }
  return { fields, fynd, undantagna }
}

function run() {
  const { fields, fynd, undantagna } = scanTree()
  if (fynd.length) {
    console.error('\n❌ Maskeringslogiken finns i mer än ett exemplar\n')
    for (const f of fynd) console.error(`  ${f.rel}  — ${f.kind}: ${f.detalj}`)
    console.error(
      `\nMaskeringen ska definieras i src/${CANONICAL} och ingen annanstans.\n` +
        'Två kopior av en maskeringsregel är värre än två kopior av vad som helst\n' +
        'annat: läggs ett mönster till i den ena tror alla att det gäller överallt,\n' +
        'och den yta som glömdes läcker tyst. Det var precis så Decimal-grenen från\n' +
        '#168 aldrig nådde hyresgäst-vägen.\n\n' +
        'Importera i stället:\n' +
        "  import { redactSensitive } from '<...>/common/redaction/redact-sensitive'\n\n" +
        'Behöver en fil verkligen räkna upp fältnamnen (t.ex. ett test som jämför mot\n' +
        'den gamla formen)? Sätt `redact-copy-allow: <varför>` i en kommentar i filen.\n',
    )
    process.exit(1)
  }
  console.warn(
    `✅ Maskeringslogiken finns på ETT ställe (${fields.length} fältnamn i src/${CANONICAL})`,
  )
  if (undantagna.length) {
    console.warn(`   ${undantagna.length} fil(er) undantagna — egna listor, inte kopior:`)
    for (const u of undantagna) console.warn(`     ${u.rel} — ${u.skäl}`)
  }
}

// ── självtest ───────────────────────────────────────────────────────────────
function selfTest() {
  let failed = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) failed++
  }
  const FÄLT = ['personalNumber', 'passwordHash', 'sessionToken', 'apiKey', 'token']

  t(
    'en avskriven funktion fälls',
    findCopies('function redactSensitive<T>(v: T) { return v }', FÄLT).length === 1,
  )
  t(
    'en avskriven fältlista fälls ÄVEN om funktionen heter något annat',
    findCopies(
      "const HEMLIGA = new Set(['personalNumber', 'passwordHash', 'sessionToken'])",
      FÄLT,
    ).some((p) => p.kind === 'fältlista'),
  )
  t(
    'en fil som nämner ETT fältnamn fälls inte',
    findCopies("const x = ['token']", FÄLT).length === 0,
  )
  t('den kanoniska filen fäller inte sig själv', findCopies('function redactSensitive() {}', FÄLT, { rel: CANONICAL }).length === 0)
  t(
    'en motiverad markör tystar filen',
    findCopies(
      '// redact-copy-allow: jämförelsepunkt mot den gamla formen i ett test\nfunction redactSensitive() {}',
      FÄLT,
    ).length === 0,
  )
  t(
    'en markör UTAN riktigt skäl tystar INTE',
    findCopies('// redact-copy-allow: x\nfunction redactSensitive() {}', FÄLT).length === 1,
  )
  t('ett ANROP är inte en kopia', findCopies('result.data = redactSensitive(result.data)', FÄLT).length === 0)
  t(
    'en IMPORT är inte en kopia',
    findCopies("import { redactSensitive } from '../../common/redaction/redact-sensitive'", FÄLT)
      .length === 0,
  )

  // ── KANARIEFÅGEL ──────────────────────────────────────────────────────────
  //
  // Kontrollerna ovan är namngivna negativkontroller. De upptäcker inte att
  // mekanismen gått blind — en `findCopies` som alltid returnerar [] gör dem
  // röda en och en, men en som tappat EN av de två detektionsvägarna kan annars
  // passera. Kanariefågeln matar in en kopia av VARJE form och kräver utslag på
  // båda, plus ett motpar som kräver att ren kod förblir tyst.
  t(
    'KANARIEFÅGEL: båda detektionsvägarna ger utslag',
    (() => {
      const somFunktion = findCopies('function redactSensitive(v) { return v }', FÄLT)
      const somLista = findCopies(
        "const S = new Set(['personalNumber', 'passwordHash', 'apiKey'])",
        FÄLT,
      )
      return (
        somFunktion.some((p) => p.kind === 'definition') && somLista.some((p) => p.kind === 'fältlista')
      )
    })(),
  )
  t(
    'KANARIEFÅGEL: och ren kod ger INGET utslag (vakten fäller inte allt)',
    findCopies("const s = 'hej'\nexport function annat() { return 1 }", FÄLT).length === 0,
  )
  t(
    'KANARIEFÅGEL: fältlistan HÄRLEDS ur modulen — tom lista är ett fel, inte grönt',
    canonicalFields('inget här').length === 0,
  )

  // Kodbasen på riktigt.
  const { fields, fynd } = scanTree()
  t('kodbasen har exakt en kopia', fynd.length === 0, JSON.stringify(fynd).slice(0, 200))
  t('fältlistan gick att läsa ur den kanoniska modulen', fields.length >= 10, `${fields.length} fält`)

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv[2] === '--self-test') selfTest()
else run()
