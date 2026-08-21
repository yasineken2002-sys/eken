#!/usr/bin/env node
/**
 * VARJE `$transaction` SKA HA MEDVETNA GRÄNSER — eller vara kvitterad (#488).
 *
 * ── Varför regeln finns ─────────────────────────────────────────────────────
 *
 * Faktura- och avi-vägen hade explicita 8 s / 3 s. Bankavstämningens fyra
 * transaktioner — samma sorts arbete, radlås → läs → allokera → uppdatera →
 * bokför — ärvde Prismas defaults. Det var inte ett medvetet undantag; det var
 * att ingen skrev något, och ingenting i kodbasen kunde se skillnaden.
 *
 * En delad konstant löser dagens anropsställen. Den hindrar inte att någon
 * skriver ett nytt `$transaction` utan gränser nästa månad, och då är läget
 * exakt lika tyst igen. Därför den här vakten.
 *
 * ── Vad som krävs ───────────────────────────────────────────────────────────
 *
 * Varje `$transaction(` under `apps/api/src/` måste ANTINGEN
 *   • referera en gräns ur `common/prisma/transaction-limits.ts`
 *     (`PAYMENT_TX_LIMITS` eller `PRISMA_DEFAULT_TX_LIMITS`) inne i anropet,
 *   • ELLER vara kvitterad i `transaction-limits.ack.json` med ett skäl.
 *
 * ── Kvitteringen fäller ÅT BÅDA HÅLLEN ──────────────────────────────────────
 *
 * Samma form som färg-baslinjen i `scripts/design-tokens.baseline.json` (#543)
 * och familjebaslinjen (#532): en okvitterad förekomst är RÖD, och en
 * kvittering som inte längre motsvarar något i koden är också RÖD.
 *
 * Skälet är detsamma i alla tre fallen: en lista som bara kan bli fel åt ena
 * hållet slutar vara ett påstående. Posten ligger kvar för alltid, ser ut som
 * ett medvetet undantag, och ingen får veta att den slutat betyda något. Färg-
 * baslinjen hann bli osann i 26 dagar innan symmetrin byggdes; den här listan
 * ska inte få göra samma resa.
 *
 * Kvitteringen är per FIL med ett ANTAL, inte per rad: radnummer flyttar sig vid
 * varje redigering och hade gjort listan till brus. Antalet gör ändå att ett
 * NYTT `$transaction` i en redan kvitterad fil fäller — det är den vanligaste
 * vägen tillbaka till problemet.
 *
 * Kör:        node apps/api/scripts/check-transaction-limits.mjs
 * Självtest:  node apps/api/scripts/check-transaction-limits.mjs --self-test
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_ROOT = join(HERE, '..')
const SRC = join(API_ROOT, 'src')
const ACK_PATH = join(HERE, 'transaction-limits.ack.json')

/** Namnen som räknas som "medvetna gränser". Kommer ur transaction-limits.ts. */
export const LIMIT_IDENTIFIERS = ['PAYMENT_TX_LIMITS', 'PRISMA_DEFAULT_TX_LIMITS']

const MIN_REASON = 30

/** Filen som DEFINIERAR gränserna ska förstås inte kvittera sig själv. */
const SKIP_FILES = ['common/prisma/transaction-limits.ts']

function tsFiles(dir) {
  const ut = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) {
      ut.push(...tsFiles(full))
    } else if (namn.endsWith('.ts') && !namn.endsWith('.spec.ts')) {
      ut.push(full)
    }
  }
  return ut
}

/**
 * Hittar varje `$transaction(`-anrop och avgör om det bär en gräns.
 *
 * Parentesmatchning i stället för radläsning: anropen sträcker sig över hundratals
 * rader (bankavstämningens längsta är 200+), och gränsen står på sista raden. En
 * radbaserad regel hade missat exakt de anrop som är värda att bevaka.
 *
 * Strängar och kommentarer hoppas över vid matchningen — annars kan en parentes i
 * en felsträng flytta slutet på anropet.
 */
export function scanTransactions(text) {
  const träffar = []
  const NEEDLE = '$transaction('
  let i = 0
  while ((i = text.indexOf(NEEDLE, i)) !== -1) {
    const öppen = i + NEEDLE.length - 1
    const slut = matchParen(text, öppen)
    const kropp = slut === -1 ? text.slice(öppen) : text.slice(öppen, slut + 1)
    träffar.push({
      line: text.slice(0, i).split('\n').length,
      hasLimit: LIMIT_IDENTIFIERS.some((id) => kropp.includes(id)),
    })
    i = öppen + 1
  }
  return träffar
}

/** Index för den parentes som stänger den på `start`, eller -1. */
function matchParen(text, start) {
  let djup = 0
  let i = start
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i === -1) return -1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i)
      if (i === -1) return -1
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i = hoppaSträng(text, i)
      continue
    }
    if (c === '(') djup++
    else if (c === ')') {
      djup--
      if (djup === 0) return i
    }
    i++
  }
  return -1
}

function hoppaSträng(text, start) {
  const q = text[start]
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === q) return i + 1
    i++
  }
  return text.length
}

/** Mät kodbasen: fil → antal `$transaction` utan gräns. */
export function measure(root = SRC) {
  const ut = {}
  for (const full of tsFiles(root)) {
    const rel = relative(API_ROOT, full).split(sep).join('/').replace(/^src\//, '')
    if (SKIP_FILES.includes(rel)) continue
    const träffar = scanTransactions(readFileSync(full, 'utf8'))
    const utan = träffar.filter((t) => !t.hasLimit)
    if (utan.length) ut[rel] = { count: utan.length, lines: utan.map((t) => t.line) }
  }
  return ut
}

/**
 * Jämför mätning mot kvittering — BÅDA hållen.
 *   okvitterade — förekomst utan gräns som inte är kvitterad (eller fler än kvitterat)
 *   stale       — kvittering utan motsvarighet i koden (eller färre än kvitterat)
 *   utanSkäl    — kvittering med för tunt skäl
 */
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
  if (!existsSync(ACK_PATH)) return { files: {} }
  return JSON.parse(readFileSync(ACK_PATH, 'utf8'))
}

function run() {
  const measured = measure()
  const ack = loadAck()
  const { okvitterade, stale, utanSkäl } = diffAcks(measured, ack)

  if (utanSkäl.length) {
    console.error('\n❌ Transaktionsgränser: kvittering utan riktigt skäl\n')
    for (const r of utanSkäl) console.error(`  ${r}`)
    console.error(
      `\nVarje kvittering kräver minst ${MIN_REASON} tecken som säger varför just den\n` +
        'transaktionen inte behöver en medveten gräns.\n',
    )
    process.exit(1)
  }

  if (okvitterade.length) {
    console.error('\n❌ Transaktionsgränser: $transaction utan medveten gräns\n')
    for (const o of okvitterade) {
      console.error(`  ${o.rel}: ${o.count} utan gräns (kvitterat ${o.acked})`)
      console.error(`      rader: ${o.lines.join(', ')}`)
    }
    console.error(
      '\nEtt $transaction utan gränser ärver Prismas defaults (5 s / 2 s) — inte för\n' +
        'att någon valt dem, utan för att ingen skrev något. Det var precis så\n' +
        'bankavstämningen hamnade utanför regeln i #488.\n\n' +
        'Rätt åtgärd: skicka en gräns ur common/prisma/transaction-limits.ts som andra\n' +
        'argument till $transaction — PAYMENT_TX_LIMITS för pengavägar (radlås → läs →\n' +
        'allokera → uppdatera → bokför), PRISMA_DEFAULT_TX_LIMITS för att uttryckligen\n' +
        'behålla dagens beteende.\n\n' +
        'Är gränsen genuint irrelevant här: kvittera i\n' +
        'apps/api/scripts/transaction-limits.ack.json med ett skäl som säger varför.\n',
    )
    process.exit(1)
  }

  if (stale.length) {
    console.error('\n❌ Transaktionsgränser: kvitteringen beskriver kod som inte finns\n')
    for (const st of stale)
      console.error(`  ${st.rel}: kvitterat ${st.acked}, faktisk förekomst ${st.count}`)
    console.error(
      '\nPosten påstår mer än vad koden innehåller. En kvittering som bara kan bli fel\n' +
        'åt ena hållet slutar vara ett påstående — den ligger kvar och ser ut som ett\n' +
        'medvetet undantag långt efter att den slutat betyda något.\n' +
        'Har du gett transaktionen en gräns, eller tagit bort den: uppdatera antalet.\n',
    )
    process.exit(1)
  }

  const utanGräns = Object.values(measured).reduce((a, m) => a + m.count, 0)
  console.warn(
    `✅ Transaktionsgränser: varje $transaction har en medveten gräns eller en kvittering ` +
      `(${utanGräns} kvitterade i ${Object.keys(measured).length} filer)`,
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
    'scanTransactions hittar ett anrop UTAN gräns',
    (() => {
      const s = scanTransactions('await this.prisma.$transaction(async (tx) => { await tx.a() })')
      return s.length === 1 && s[0].hasLimit === false
    })(),
  )
  t(
    'scanTransactions ser gränsen som sista argument',
    (() => {
      const s = scanTransactions(
        'await this.prisma.$transaction(async (tx) => { await tx.a() }, PAYMENT_TX_LIMITS)',
      )
      return s.length === 1 && s[0].hasLimit === true
    })(),
  )
  t(
    'en parentes i en STRÄNG flyttar inte slutet på anropet',
    (() => {
      const s = scanTransactions(
        "await this.prisma.$transaction(async (tx) => { throw new Error('oj :-(') }, PAYMENT_TX_LIMITS)",
      )
      return s.length === 1 && s[0].hasLimit === true
    })(),
  )
  t(
    'en parentes i en KOMMENTAR flyttar inte heller slutet',
    (() => {
      const s = scanTransactions(
        'await this.prisma.$transaction(async (tx) => {\n  // ) inte ett slut\n  await tx.a()\n}, PAYMENT_TX_LIMITS)',
      )
      return s.length === 1 && s[0].hasLimit === true
    })(),
  )

  // diffAcks — båda hållen
  const m = (rel, count) => ({ [rel]: { count, lines: [1] } })
  const a = (rel, count, reason = 'ett skäl som är långt nog för att räknas som ett skäl') => ({
    files: { [rel]: { count, reason } },
  })

  t('diffAcks: okvitterad förekomst → röd', diffAcks(m('x.ts', 1), { files: {} }).okvitterade.length === 1)
  t('diffAcks: FLER än kvitterat → röd', diffAcks(m('x.ts', 3), a('x.ts', 2)).okvitterade.length === 1)
  t('diffAcks: FÄRRE än kvitterat → stale', diffAcks(m('x.ts', 1), a('x.ts', 2)).stale.length === 1)
  t('diffAcks: kvittering utan kod alls → stale', diffAcks({}, a('x.ts', 2)).stale.length === 1)
  t('diffAcks: för kort skäl → utanSkäl', diffAcks({}, a('x.ts', 0, 'kort')).utanSkäl.length === 1)
  t(
    'diffAcks: EXAKT paritet → tyst i alla tre formerna',
    (() => {
      const d = diffAcks(m('x.ts', 2), a('x.ts', 2))
      return d.okvitterade.length === 0 && d.stale.length === 0 && d.utanSkäl.length === 0
    })(),
  )

  // ── KANARIEFÅGEL ──────────────────────────────────────────────────────────
  //
  // Kontrollerna ovan är namngivna negativkontroller. De upptäcker inte att
  // mekanismen gått blind på ett håll — och det är exakt den defekten hela
  // ändringen handlar om: en regel som bara gäller åt ena hållet slutar mäta
  // utan att sluta vara grön.
  //
  // Kanariefågeln matar in ett läge som MÅSTE ge utslag åt VARJE håll och kräver
  // att alla tre riktningarna svarar.
  t(
    'KANARIEFÅGEL: alla tre riktningarna ger utslag',
    (() => {
      const utslag = {
        okvitterad: diffAcks(m('kanarie.ts', 5), { files: {} }).okvitterade.length,
        stale: diffAcks({}, a('kanarie.ts', 5)).stale.length,
        utanSkäl: diffAcks({}, a('kanarie.ts', 1, 'nej')).utanSkäl.length,
      }
      return utslag.okvitterad === 1 && utslag.stale === 1 && utslag.utanSkäl === 1
    })(),
  )
  t(
    'KANARIEFÅGEL: och paritet ger INGET utslag (vakten fäller inte allt)',
    (() => {
      const d = diffAcks(m('kanarie.ts', 4), a('kanarie.ts', 4))
      return d.okvitterade.length === 0 && d.stale.length === 0 && d.utanSkäl.length === 0
    })(),
  )

  // Kvitteringen på disk måste vara i exakt paritet med kodbasen.
  t(
    'kvitteringsfilen matchar verkligheten exakt',
    (() => {
      const d = diffAcks(measure(), loadAck())
      return d.okvitterade.length === 0 && d.stale.length === 0 && d.utanSkäl.length === 0
    })(),
    JSON.stringify(diffAcks(measure(), loadAck())).slice(0, 200),
  )
  t(
    'pengavägarna är INTE kvitterade — de bär en riktig gräns',
    (() => {
      const ack = loadAck().files ?? {}
      return !['invoices/invoices.service.ts', 'avisering/avisering.service.ts',
        'reconciliation/reconciliation.service.ts'].some((f) => (ack[f]?.count ?? 0) > 0 &&
          measure()[f] === undefined)
    })(),
  )

  console.warn(failed === 0 ? '\nSjälvtest: ALLA GRÖNA' : `\nSjälvtest: ${failed} FALLERADE`)
  process.exit(failed === 0 ? 0 : 1)
}

// Kör bara när skriptet anropas direkt. Utan den här grinden startar en import
// (självtest, återanvändning) en full körning som avslutar processen — vakten
// hade då varit omöjlig att bygga verktyg ovanpå.
const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const arg = process.argv[2]
if (!körsDirekt) {
  // importerad — exportera bara
} else if (arg === '--self-test') selfTest()
else if (arg === '--update-ack') {
  const measured = measure()
  const previous = loadAck().files ?? {}
  const files = {}
  for (const rel of Object.keys(measured).sort()) {
    files[rel] = {
      count: measured[rel].count,
      reason:
        previous[rel]?.reason ??
        'SKÄL SAKNAS — beskriv varför transaktionen inte behöver en medveten gräns',
    }
  }
  const payload = {
    $comment:
      'KVITTERINGAR — $transaction utan medveten gräns. Varje post säger varför just ' +
      'den transaktionen ärver Prismas defaults i stället för att välja en gräns ur ' +
      'common/prisma/transaction-limits.ts.',
    $howto:
      'Listan fäller ÅT BÅDA HÅLLEN: en okvitterad förekomst är röd, och en kvittering ' +
      'som inte längre motsvarar något i koden är också röd. Gav du transaktionen en ' +
      'gräns? Sänk antalet. Lägg ALDRIG till en post för hand för att tysta ett nytt ' +
      'fynd — välj en gräns i stället.',
    total: Object.values(files).reduce((a, f) => a + f.count, 0),
    files,
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(ACK_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  console.warn(`Kvitteringsfil uppdaterad: ${payload.total} förekomster i ${Object.keys(files).length} filer.`)
} else run()
