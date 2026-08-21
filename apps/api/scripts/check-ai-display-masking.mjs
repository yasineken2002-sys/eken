#!/usr/bin/env node
/**
 * VARJE LÄSVÄG SOM VISAR AI-INNEHÅLL FÖR EN MÄNNISKA SKA MASKERA (#507).
 *
 * ── Varför vakten finns ─────────────────────────────────────────────────────
 *
 * Maskeringen ligger på läsvägen, inte på skrivvägen — lagrad rad orörd,
 * modellen får den orörd, människan får den maskerad. Det gör listan över
 * läsvägar till den bärande delen: **en yta som glöms är hela bristen, inte en
 * delmängd av den.** Ärendet säger det själv, och det är därför en uppräkning i
 * en PR-beskrivning inte räcker — nästa yta läggs till utanför den.
 *
 * ── Vad som räknas som en läsväg ────────────────────────────────────────────
 *
 * En Prisma-läsning av en AI-samtalstabell (`aiConversation`,
 * `aiTenantConversation`) eller av meddelanderaderna (`aiMessage`,
 * `aiTenantMessage`) — alltså `findMany`/`findFirst`/`findUnique`. Filen som
 * innehåller en sådan läsning måste antingen importera
 * `maskAiContentForDisplay`, eller vara kvitterad med ett skäl.
 *
 * Kvitteringen finns för att alla läsningar INTE ska maskeras. Chattvägen läser
 * samma tabell för att ge modellen sin historik, och där vore maskering en
 * funktionsförsämring: assistenten skulle tappa minnet av vad som sagts. Den
 * skillnaden ska stå skriven, inte antas.
 *
 * ── Kvitteringen fäller åt BÅDA hållen ──────────────────────────────────────
 *
 * Samma form som färg-baslinjen (#543) och transaktionsgränserna (#544): en
 * okvitterad läsväg utan maskering är RÖD, och en kvittering som inte längre
 * motsvarar något i koden är också RÖD.
 *
 * Kör:        node apps/api/scripts/check-ai-display-masking.mjs
 * Självtest:  node apps/api/scripts/check-ai-display-masking.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_ROOT = join(HERE, '..')
const SRC = join(API_ROOT, 'src')
const ACK_PATH = join(HERE, 'ai-display-masking.ack.json')

/** Tabellerna som bär AI-innehåll skrivet av eller till en människa. */
export const AI_CONTENT_MODELS = [
  'aiConversation',
  'aiTenantConversation',
  'aiMessage',
  'aiTenantMessage',
]

const READ_METHODS = ['findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow']
const MASKER = 'maskAiContentForDisplay'
const MIN_REASON = 30

function tsFiles(dir) {
  const ut = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) ut.push(...tsFiles(full))
    else if (namn.endsWith('.ts') && !namn.endsWith('.spec.ts')) ut.push(full)
  }
  return ut
}

/** Läsningar av AI-innehåll i en filtext, som `{ model, method, line }`. */
export function findAiReads(text) {
  const träffar = []
  for (const model of AI_CONTENT_MODELS) {
    for (const method of READ_METHODS) {
      const nål = `${model}.${method}(`
      let i = 0
      while ((i = text.indexOf(nål, i)) !== -1) {
        träffar.push({ model, method, line: text.slice(0, i).split('\n').length })
        i += nål.length
      }
    }
  }
  return träffar.sort((a, b) => a.line - b.line)
}

/** Maskerar filen sitt innehåll? Importen räcker — tillämpningen bevakas av testerna. */
export function harMaskering(text) {
  return text.includes(MASKER)
}

export function measure(root = SRC) {
  const ut = {}
  for (const full of tsFiles(root)) {
    const rel = relative(root, full).split(sep).join('/')
    const text = readFileSync(full, 'utf8')
    const läsningar = findAiReads(text)
    if (läsningar.length === 0) continue
    if (harMaskering(text)) continue
    ut[rel] = { count: läsningar.length, lines: läsningar.map((l) => l.line) }
  }
  return ut
}

export function diffAcks(measured, ack) {
  const poster = ack.files ?? {}
  const okvitterade = []
  const stale = []
  const utanSkäl = []
  for (const [rel, m] of Object.entries(measured)) {
    const a = poster[rel]
    if (!a) okvitterade.push({ rel, count: m.count, acked: 0, lines: m.lines })
    else if (m.count > a.count)
      okvitterade.push({ rel, count: m.count, acked: a.count, lines: m.lines })
    else if (m.count < a.count) stale.push({ rel, count: m.count, acked: a.count })
  }
  for (const [rel, a] of Object.entries(poster)) {
    if (!measured[rel]) stale.push({ rel, count: 0, acked: a.count })
    if (!a.reason?.trim() || a.reason.trim().length < MIN_REASON) utanSkäl.push(rel)
  }
  return { okvitterade, stale, utanSkäl }
}

function loadAck() {
  try {
    return JSON.parse(readFileSync(ACK_PATH, 'utf8'))
  } catch {
    return { files: {} }
  }
}

function run() {
  const measured = measure()
  const { okvitterade, stale, utanSkäl } = diffAcks(measured, loadAck())

  if (utanSkäl.length) {
    console.error('\n❌ AI-maskering: kvittering utan riktigt skäl\n')
    for (const r of utanSkäl) console.error(`  ${r}`)
    console.error(`\nVarje kvittering kräver minst ${MIN_REASON} tecken.\n`)
    process.exit(1)
  }

  if (okvitterade.length) {
    console.error('\n❌ AI-maskering: läsväg som visar AI-innehåll utan att maskera\n')
    for (const o of okvitterade) {
      console.error(`  ${o.rel}: ${o.count} läsning(ar) (kvitterat ${o.acked})`)
      console.error(`      rader: ${o.lines.join(', ')}`)
    }
    console.error(
      '\nLagrad rad orörd, modellen får den orörd, MÄNNISKAN får den maskerad.\n' +
        'Visar den här vägen innehåll för en människa: kör resultatet genom\n' +
        `${MASKER} från common/redaction/mask-display.\n\n` +
        'Matar den i stället modellen (historik, minne) ska den INTE maskera —\n' +
        'kvittera då i apps/api/scripts/ai-display-masking.ack.json med skälet.\n',
    )
    process.exit(1)
  }

  if (stale.length) {
    console.error('\n❌ AI-maskering: kvitteringen beskriver kod som inte finns\n')
    for (const st of stale)
      console.error(`  ${st.rel}: kvitterat ${st.acked}, faktisk förekomst ${st.count}`)
    console.error(
      '\nEn kvittering som bara kan bli fel åt ena hållet slutar vara ett påstående.\n',
    )
    process.exit(1)
  }

  const kvitterade = Object.values(measured).reduce((a, m) => a + m.count, 0)
  console.warn(
    `✅ AI-maskering: varje läsväg maskerar eller är kvitterad (${kvitterade} kvitterade läsningar)`,
  )
}

// ── självtest ───────────────────────────────────────────────────────────────
function selfTest() {
  let failed = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) failed++
  }

  t(
    'findAiReads hittar en samtalsläsning',
    findAiReads('await this.prisma.aiConversation.findMany({})').length === 1,
  )
  t(
    'findAiReads hittar hyresgäst-tabellen också',
    findAiReads('this.prisma.aiTenantConversation.findFirst({})').length === 1,
  )
  t(
    'en skrivning är inte en läsning',
    findAiReads('await this.prisma.aiConversation.create({})').length === 0,
  )
  t('harMaskering ser importen', harMaskering("import { maskAiContentForDisplay } from 'x'"))
  t('harMaskering ser inte något annat', !harMaskering('const x = 1'))

  const m = (rel, count) => ({ [rel]: { count, lines: [1] } })
  const a = (rel, count, reason = 'ett skäl som är tillräckligt långt för att räknas') => ({
    files: { [rel]: { count, reason } },
  })
  t('diffAcks: okvitterad läsväg → röd', diffAcks(m('x.ts', 1), { files: {} }).okvitterade.length === 1)
  t('diffAcks: fler än kvitterat → röd', diffAcks(m('x.ts', 3), a('x.ts', 2)).okvitterade.length === 1)
  t('diffAcks: färre än kvitterat → stale', diffAcks(m('x.ts', 1), a('x.ts', 2)).stale.length === 1)
  t('diffAcks: kvittering utan kod → stale', diffAcks({}, a('x.ts', 1)).stale.length === 1)
  t('diffAcks: för kort skäl → utanSkäl', diffAcks({}, a('x.ts', 0, 'kort')).utanSkäl.length === 1)

  // ── KANARIEFÅGEL ──────────────────────────────────────────────────────────
  //
  // De namngivna kontrollerna ovan skyddar mot specifika återfall. De upptäcker
  // inte att detektionen gått blind på EN modell — och det är just så en yta
  // glöms: någon lägger till en läsning av en tabell som listan inte känner.
  // Kanariefågeln kräver utslag för VARJE modell i AI_CONTENT_MODELS, så att en
  // tappad post gör testet rött i stället för tyst grönt.
  t(
    'KANARIEFÅGEL: varje AI-innehållsmodell ger utslag',
    AI_CONTENT_MODELS.every(
      (model) => findAiReads(`this.prisma.${model}.findMany({})`).length === 1,
    ),
    AI_CONTENT_MODELS.join(', '),
  )
  t(
    'KANARIEFÅGEL: och en fil utan AI-läsning ger INGET utslag (fäller inte allt)',
    findAiReads('await this.prisma.invoice.findMany({})').length === 0,
  )

  const measured = measure()
  const d = diffAcks(measured, loadAck())
  t(
    'kodbasen är i paritet med kvitteringen',
    d.okvitterade.length === 0 && d.stale.length === 0 && d.utanSkäl.length === 0,
    JSON.stringify(d).slice(0, 200),
  )

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv[2] === '--self-test') selfTest()
else run()
