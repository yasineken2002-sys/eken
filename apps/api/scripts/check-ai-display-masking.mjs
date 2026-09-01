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
 * ── FRÅGAN STÄLLS MOT KOD, INTE MOT PROSA ──────────────────────────────────
 *
 * Vakten läste tidigare råtexten, och blev då blind åt det farligaste hållet:
 * `harMaskering` var ett `text.includes('maskAiContentForDisplay')`, alltså
 * uppfyllt av en KOMMENTAR som nämner maskeraren. En refaktorering som tar bort
 * anropet men behåller raden som förklarar det — det troliga — hade lämnat
 * vakten grön. Samma sak åt andra hållet: ett `aiConversation.findMany(` i ett
 * kodexempel i en kommentar räknades som en läsväg och drev kvitteringens
 * siffror isär från koden.
 *
 * Båda frågorna ställs därför mot `codeMask(text)` ur scripts/lib/source-scan.mjs
 * — kommentarer och stränginnehåll blankade, längd och radnummer bevarade.
 *
 * Kör:        node apps/api/scripts/check-ai-display-masking.mjs
 * Självtest:  node apps/api/scripts/check-ai-display-masking.mjs --self-test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

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

/**
 * Läsningar av AI-innehåll i en filtext, som `{ model, method, line }`.
 *
 * Söker i `codeMask` — ett kodexempel i en kommentar är inte en läsväg, och en
 * modellsträng i en literal är inte ett anrop. Masken bevarar längd och
 * radbrytningar, så raderna pekar fortfarande på råfilen.
 */
export function findAiReads(text) {
  const kod = codeMask(text)
  const träffar = []
  for (const model of AI_CONTENT_MODELS) {
    for (const method of READ_METHODS) {
      const nål = `${model}.${method}(`
      let i = 0
      while ((i = kod.indexOf(nål, i)) !== -1) {
        träffar.push({ model, method, line: kod.slice(0, i).split('\n').length })
        i += nål.length
      }
    }
  }
  return träffar.sort((a, b) => a.line - b.line)
}

/**
 * Maskerar filen sitt innehåll? Importen räcker — tillämpningen bevakas av
 * testerna.
 *
 * MÅSTE fråga koden. Som `text.includes(MASKER)` var villkoret uppfyllt av
 * varje kommentar som nämnde maskeraren, och en vakt som kan uppfyllas av prosa
 * är alltid uppfylld.
 */
export function harMaskering(text) {
  return codeMask(text).includes(MASKER)
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

// ── OMFÅNGSKANARIEFÅGEL ─────────────────────────────────────────────────────
//
// `measure()` returnerar bara de filer som saknar maskering. Den mängden är
// TOM i ett friskt läge — den duger alltså inte som bevis på att vakten mäter
// något. Lärdomen av R5: regeln kan fungera medan mängden är tom.
//
// Det som får krympa tyst är i stället tre andra tal: filerna `tsFiles` hittar,
// läsvägarna som alls finns i koden, och filerna som faktiskt maskerar. Blir
// någon av dem noll har vakten inget kvar att uttala sig om, och ser lika grön
// ut som idag.
//
// Golven är MÄTTA mot e9aea18: 447 filer, 13 läsvägar i 5 filer, 3 maskerande.
const MIN_FILER = 300
const MIN_LÄSVÄGAR = 8
const MIN_FILER_MED_LÄSVÄG = 3
const MIN_FILER_MED_MASKERING = 2

export function mätOmfång(root = SRC) {
  let filer = 0
  let läsvägar = 0
  let filerMedLäsväg = 0
  let filerMedMaskering = 0
  for (const full of tsFiles(root)) {
    filer++
    const text = readFileSync(full, 'utf8')
    const n = findAiReads(text).length
    läsvägar += n
    if (n > 0) filerMedLäsväg++
    if (harMaskering(text)) filerMedMaskering++
  }
  const fel = []
  if (filer < MIN_FILER) fel.push(`omfång: ${filer} filer skannade, golv ${MIN_FILER}`)
  if (läsvägar < MIN_LÄSVÄGAR)
    fel.push(`omfång: ${läsvägar} AI-läsvägar i KOD, golv ${MIN_LÄSVÄGAR}`)
  if (filerMedLäsväg < MIN_FILER_MED_LÄSVÄG)
    fel.push(`omfång: ${filerMedLäsväg} filer med läsväg, golv ${MIN_FILER_MED_LÄSVÄG}`)
  if (filerMedMaskering < MIN_FILER_MED_MASKERING)
    fel.push(`omfång: ${filerMedMaskering} filer som maskerar, golv ${MIN_FILER_MED_MASKERING}`)
  return { fel, mätt: { filer, läsvägar, filerMedLäsväg, filerMedMaskering } }
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

  // ── DEN DELADE SKANNERNS KANARIEFÅGLAR ────────────────────────────────────
  //
  // Kravet metavakten (R2) ställer på varje konsument: går source-scan.mjs
  // sönder ska DEN HÄR vakten bli röd, inte tyst fortsätta mäta fel.
  const skanner = kanariefåglar()
  t('delad skanner: 7 kanariefåglar gröna', skanner.length === 0, skanner.join(' | '))

  // ── MASKENS SEMANTIK ──────────────────────────────────────────────────────
  //
  // De tre proven nedan var alla FEL i råtextversionen. De två första är
  // blindhet, det tredje ett falskt larm.
  t(
    'MASK: maskeraren i en KOMMENTAR uppfyller INTE kravet',
    !harMaskering('// resultatet körs genom maskAiContentForDisplay i anroparen\nconst x = 1'),
  )
  t(
    'MASK: maskeraren i en STRÄNG uppfyller INTE kravet',
    !harMaskering("const hint = 'använd maskAiContentForDisplay'"),
  )
  t(
    'MASK: en läsning i en KOMMENTAR är ingen läsväg',
    findAiReads('// exempel: this.prisma.aiConversation.findMany({})').length === 0,
  )
  t(
    'MASK: en riktig läsning EFTER en regex-literal med citattecken syns ändå',
    findAiReads(`const e = s.replace(/"/g, '&q;')\nawait this.prisma.aiMessage.findMany({})`).length === 1,
  )

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

  const omf = mätOmfång()
  t(
    'OMFÅNGSKANARIEFÅGEL: mängden vakten prövar är inte tom',
    omf.fel.length === 0,
    omf.fel.length
      ? omf.fel.join(' | ')
      : `${omf.mätt.filer} filer (golv ${MIN_FILER}), ${omf.mätt.läsvägar} läsvägar (golv ${MIN_LÄSVÄGAR}), ` +
        `${omf.mätt.filerMedLäsväg} filer med läsväg (golv ${MIN_FILER_MED_LÄSVÄG}), ` +
        `${omf.mätt.filerMedMaskering} maskerande (golv ${MIN_FILER_MED_MASKERING})`,
  )

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv[2] === '--self-test') selfTest()
else run()
