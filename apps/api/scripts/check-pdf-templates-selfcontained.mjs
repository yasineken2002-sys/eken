#!/usr/bin/env node
/**
 * PDF-mallarna får inte hämta något utifrån.
 *
 * ── VARFÖR VAKTEN FINNS ─────────────────────────────────────────────────────
 *
 * `PdfService` väntar `load` i stället för `networkidle0` (mätningen står i
 * src/invoices/pdf-wait-until.ts: ~1970 ms väntan på NOLL nätverksanrop). Hela
 * grunden för att `load` räcker är att sidan hämtar ingenting utifrån — allt,
 * logotypen inkluderad, bäddas in som `data:`-URL i Node innan HTML:en når
 * webbläsaren.
 *
 * Den dagen någon lägger in ett typsnitt från Google Fonts är antagandet
 * brutet. Det ska synas HÄR, i CI — inte som en PDF utan logotyp hos en kund.
 *
 * ── MALLMÄNGDEN HÄRLEDS UR KODEN, INTE UR EN HANDLISTA ──────────────────────
 *
 * Renderingsställena (`page.setContent`) läses ur källan. Varje anrop till
 * `generateFromHtml`/`generateContractFromHtml` resolveras till sin PRODUCENT,
 * och därifrån följs anropskedjan genom FUNKTIONSKROPPAR — in i lokala
 * importer, genom re-exporter. Så kommer den delade shellen
 * (`branded-pdf-shell.ts`) och kontraktsskalet med utan att stå i någon lista.
 *
 * Granskningen är avgränsad till kropparna, inte till filerna. Skälet är mätt:
 * med filgranularitet drogs `platform-invoices.service.ts` E-POSTMALLAR in
 * (`href="${this.webAppUrl}/settings"`) — riktig HTML, men inte en PDF. En vakt
 * som larmar om sådant blir avstängd, och då mäter den ingenting.
 *
 * Registret nedan är alltså INTE mängden som granskas. Det är kvittensen på att
 * en människa sett varje producent, och det faller åt BÅDA hållen: en
 * oregistrerad producent är röd, och en registerpost utan producent likaså.
 *
 * `--self-test` kör samma `evaluate()` som CI kör, även med muterad källkod.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { codeMask, templateLiterals, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('..', import.meta.url).pathname)
const SRC = join(ROT, 'src')
const PDF_SERVICE = 'src/invoices/pdf.service.ts'
const WAIT_KONST = 'src/invoices/pdf-wait-until.ts'

/**
 * KVITTENS — varje PDF-mallproducent som koden leder till. Att lägga till en
 * rad är att intyga: den här mallen bygger ett SJÄLVFÖRSÖRJANDE dokument.
 */
const REGISTER = [
  ['src/avisering/avisering.service.ts', 'buildNoticePdfHtml', 'hyresavi'],
  ['src/avisering/rent-reminder.service.ts', 'buildReminderPdfHtml', 'påminnelse'],
  ['src/collections/collection-export.service.ts', 'buildPdfHtml', 'inkassoexport (faktura)'],
  ['src/collections/rent-collection-export.service.ts', 'buildPdfHtml', 'inkassoexport (avi)'],
  ['src/notifications/monthly-report.service.ts', 'generateMonthlyReportHtml', 'månadsrapport'],
  ['src/inspections/inspections.service.ts', 'buildBrandedPdfHtml', 'besiktningsprotokoll'],
  ['src/platform/invoices/platform-invoices.service.ts', 'generatePlatformInvoiceHtml', 'plattformsfaktura'],
  ['src/invoices/pdf.service.ts', 'generateInvoiceHtml', 'kundfaktura'],
  ['src/contracts/contract-template.service.ts', 'renderHtml', 'hyreskontrakt'],
  ['src/ai/tools/tool-executor.service.ts', 'executeToolUnsafe', 'AI-verktyg: kontrakt + dokumentleverans'],
]

/**
 * Beständig HTML saknar en direkt anropskant mellan läsare och producent.
 * Detta är en VERIFIERAD lagringsbrygga, inte en undantagen renderingsplats:
 * callback → schemakonstruktor → validerad DB-skrivning → validerad läsare.
 * Alla länkar måste finnas i körbar kod. Producenten härleds ur callbacken
 * och går sedan genom samma REGISTER och R5/R6 som en direkt renderad mall.
 */
const SPARAD_HTML = [{
  schemaFil: 'src/avisering/notice-dispatch.ts',
  schema: 'NoticeDispatchSnapshotSchema',
  läsare: 'readNoticeSnapshot',
  skrivFil: 'src/customer-credit/customer-credit.service.ts',
  skrivare: 'prepareNoticeForSend',
  callback: 'buildSnapshot',
  modell: 'rentNoticeSend',
  fält: 'snapshot',
  htmlFält: 'html',
}]

/**
 * KVITTENS — varje `src=`/`href=` i en mall vars värde är en INTERPOLATION och
 * därför inte kan läsas som `data:` av vakten. Faller åt båda hållen.
 */
const DATAINTERPOLATIONER = [
  ['src/common/branding/branded-pdf-shell.ts', 'input.logoDataUrl', 'getLogoDataUrl → data: eller null'],
  ['src/contracts/contract-template.shared.ts', 'logoDataUrl', 'getLogoDataUrl → data: eller null'],
]

const FÖRBJUDNA = [
  [/https?:\/\//, 'http(s)://'],
  [/(?:^|[\s"'(=])\/\/[\p{L}\p{N}]/u, 'protokollrelativ //'],
  [/@import/, '@import'],
  [/url\(/, 'url('],
  [/<link\b/i, '<link'],
  [/<script\b/i, '<script'],
  [/@font-face/i, '@font-face'],
]

// ── källskanner ─────────────────────────────────────────────────────────────

/**
 * Maskerad källa + varje markup-bärande mallsträng, ur den DELADE skannern
 * (scripts/lib/source-scan.mjs).
 *
 * Den här filen hade sin EGEN skanner. Den kände inte regex-literaler och läste
 * `"` i `.replace(/"/g, …)` som en strängstart — 11 629 tecken av
 * platform-invoices.service.ts maskerades och vakten var GRÖN om hela filen.
 * Rättad i #567, delad här: samma defekt fanns i fyra andra vakter, och var och
 * en som skriver sin egen skanner skriver förr eller senare samma bugg.
 */
function skanna(kalla) {
  return {
    mask: codeMask(kalla),
    literaler: templateLiterals(kalla).filter((l) => /<[\p{L}!]/u.test(l.text)),
  }
}

const rel = (p) => relative(ROT, p).replaceAll('\\', '/')
const läs = (r) => readFileSync(join(ROT, r), 'utf8')
const cache = new Map()
function fil(r) {
  if (!cache.has(r)) { const k = läs(r); cache.set(r, { kalla: k, ...skanna(k) }) }
  return cache.get(r)
}

function allaTs(dir, ut = []) {
  for (const namn of readdirSync(dir)) {
    const p = join(dir, namn)
    if (statSync(p).isDirectory()) allaTs(p, ut)
    else if (namn.endsWith('.ts') && !namn.endsWith('.spec.ts') && !namn.endsWith('.d.ts')) ut.push(p)
  }
  return ut
}

// ── funktionskroppar ────────────────────────────────────────────────────────

const DEKL = /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:private\s+|public\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?(?:function\s+)?([\p{L}\p{N}_$]+)\s*(?:<[^>]*>)?\s*\(/gu
/** Nyckelord som ser ut som deklarationer. `switch (` matchar annars DEKL och
 *  blir en "producent" som ingen kan kvittera. */
const EJ_FUNKTION = new Set([
  'switch', 'if', 'for', 'while', 'catch', 'return', 'typeof', 'await', 'do',
  'else', 'new', 'delete', 'void', 'yield', 'constructor', 'super', 'with',
])

/** Alla funktions-/metodkroppar i en fil, med index-intervall. */
function kroppar(filRel) {
  const f = fil(filRel)
  if (f.kroppar) return f.kroppar
  const ut = []
  DEKL.lastIndex = 0
  let m
  while ((m = DEKL.exec(f.mask))) {
    // Hitta matchande ) och sedan { — allt på den maskerade källan.
    let p = f.mask.indexOf('(', m.index + m[0].length - 1)
    if (p === -1) continue
    let d = 0, k = p
    for (; k < f.mask.length; k++) {
      if (f.mask[k] === '(') d++
      else if (f.mask[k] === ')') { d--; if (d === 0) break }
    }
    let b = k + 1
    while (b < f.mask.length && /[\s:<>|&\][\p{L}\p{N}_$,.'"]/u.test(f.mask[b])) b++
    if (f.mask[b] !== '{') continue
    let bd = 0, e = b
    for (; e < f.mask.length; e++) {
      if (f.mask[e] === '{') bd++
      else if (f.mask[e] === '}') { bd--; if (bd === 0) break }
    }
    if (!EJ_FUNKTION.has(m[1])) ut.push({ namn: m[1], start: b, slut: e })
  }
  f.kroppar = ut
  return ut
}

/** Resolverar en lokal modulspecifikator till en filsökväg. */
function modul(filRel, spec) {
  const bas = resolve(dirname(join(ROT, filRel)), spec)
  for (const k of [`${bas}.ts`, join(bas, 'index.ts')]) if (existsSync(k)) return rel(k)
  return null
}

/** Hittar var en symbol är DEKLARERAD — följer importer och re-exporter. */
function hittaFunktion(filRel, symbol, sedda = new Set()) {
  const nyckel = `${filRel}#${symbol}`
  if (sedda.has(nyckel)) return null
  sedda.add(nyckel)
  if (!existsSync(join(ROT, filRel))) return null
  const egen = kroppar(filRel).find((k) => k.namn === symbol)
  if (egen) return { fil: filRel, ...egen }
  const f = fil(filRel)
  for (const m of f.kalla.matchAll(/(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const namn = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim())
    if (!namn.includes(symbol)) continue
    const nästa = modul(filRel, m[2])
    if (nästa) { const t = hittaFunktion(nästa, symbol, sedda); if (t) return t }
  }
  for (const m of f.kalla.matchAll(/export\s+\*\s+from\s*['"](\.[^'"]+)['"]/g)) {
    const nästa = modul(filRel, m[1])
    if (nästa) { const t = hittaFunktion(nästa, symbol, sedda); if (t) return t }
  }
  return null
}

// ── härledning ──────────────────────────────────────────────────────────────

const IDENT = '[\\p{L}\\p{N}_$]+'
const ID_START = '(?<![\\p{L}\\p{N}_$])'
const ID_SLUT = '(?![\\p{L}\\p{N}_$])'
const rx = (text, flags = 'u') => new RegExp(text, flags)
const citera = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Balanserar kod, efter att delade skannern maskerat strängar/kommentarer. */
function parSlut(mask, start, öppna, stäng) {
  if (mask[start] !== öppna) return -1
  let djup = 0
  for (let i = start; i < mask.length; i++) {
    if (mask[i] === öppna) djup++
    else if (mask[i] === stäng && --djup === 0) return i
  }
  return -1
}

function importerar(filRel, symbol, ursprung) {
  if (filRel === ursprung) return true
  const f = fil(filRel)
  for (const m of f.kalla.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    if (!f.mask.slice(m.index).startsWith('import')) continue
    if (m[1].split(',').some((s) => s.trim() === symbol) && modul(filRel, m[2]) === ursprung) return true
  }
  return false
}

function harMutation(mask, namn) {
  // Även en const kan få sitt HTML-fält ändrat efter schemavalideringen.
  return rx(`(?<![\\p{L}\\p{N}_$])${citera(namn)}\\s*(?:\\.${IDENT}|\\[[^\\]]*\\])+\\s*(?:=(?!=)|\\+=|\\?\\?=|\\|\\|=)`).test(mask)
}

/**
 * Begränsad, fail-closed härledning för den deklarerade JSON-bryggan. Ett
 * nytt uttryck eller en annan skrivväg kräver att härledningen utökas och
 * motprovas; variabelnamnet `snapshot` ger aldrig ett frikort. Detta är
 * syntaktisk bevisning, inte full dataproveniens: alias, indirekta/nästlade
 * Prisma-skrivningar och rå SQL härleds inte. Nya sådana lagringsvägar kräver
 * egen granskning och utökade motprov, inte en ny undantagsrad.
 */
function sparadProducent(filRel, argument, index, filer) {
  const medlem = argument.match(rx(`^(${IDENT})\\.(${IDENT})$`))
  if (!medlem) return null
  const f = fil(filRel)
  const om = kroppar(filRel).filter((k) => k.start < index && index < k.slut).sort((a, b) => b.start - a.start)[0]
  if (!om) return null
  const före = f.mask.slice(om.start, index)
  const bindningar = [...före.matchAll(rx(`\\bconst\\s+${citera(medlem[1])}\\s*=\\s*(${IDENT})\\s*\\(\\s*(${IDENT})\\s*\\)`, 'gu'))]
  if (bindningar.length !== 1 || harMutation(före, medlem[1])) return null
  const brygga = SPARAD_HTML.find((b) => b.läsare === bindningar[0][1] && b.htmlFält === medlem[2])
  if (!brygga || !importerar(filRel, brygga.läsare, brygga.schemaFil)) return null
  if (rx(`\\b(?:const|let|function)\\s+${citera(brygga.läsare)}${ID_SLUT}`).test(före)) return null

  const läsare = hittaFunktion(brygga.schemaFil, brygga.läsare)
  const skrivare = hittaFunktion(brygga.skrivFil, brygga.skrivare)
  if (!läsare || !skrivare || !importerar(brygga.skrivFil, brygga.schema, brygga.schemaFil)) return null
  const läskod = fil(läsare.fil).mask.slice(läsare.start, läsare.slut)
  const skrivkod = fil(skrivare.fil).mask.slice(skrivare.start, skrivare.slut)
  const läst = läskod.match(rx(`\\bconst\\s+(${IDENT})\\s*=\\s*${brygga.schema}\\.safeParse\\(\\s*${IDENT}\\.${brygga.fält}\\s*\\)`))
  if (!läst || [...läskod.matchAll(/\breturn\b/g)].length !== 1 || !rx(`!${citera(läst[1])}\\.success`).test(läskod) ||
      !rx(`\\breturn\\s+${citera(läst[1])}\\.data\\s*(?:;|$)`, 'mu').test(läskod) || harMutation(läskod, läst[1])) return null

  const indata = skrivkod.match(rx(`\\bconst\\s*\\{[^}]*${ID_START}${brygga.fält}${ID_SLUT}[^}]*\\}\\s*=\\s*await\\s+${IDENT}\\.${brygga.callback}\\(`))
  const validerat = skrivkod.match(rx(`\\bconst\\s+(${IDENT})\\s*=\\s*${brygga.schema}\\.safeParse\\(\\s*${brygga.fält}\\s*\\)`))
  if (!indata || !validerat || !rx(`!${citera(validerat[1])}\\.success`).test(skrivkod) ||
      harMutation(skrivkod, validerat[1]) || harMutation(skrivkod, brygga.fält)) return null

  let skrivningar = 0
  const konstruktörer = []
  for (const abs of filer) {
    const r = rel(abs)
    const kod = fil(r).mask
    const koppladeAnrop = new Set()
    // Varje direkt skrivning av JSON-kolumnen måste vara den validerade
    // create-vägen. En ny create/update med fri HTML blir inte osynlig.
    for (const m of kod.matchAll(rx(`\\.${brygga.modell}\\.(create|createMany|update|updateMany|upsert)\\s*\\(`, 'gu'))) {
      const start = m.index + m[0].lastIndexOf('(')
      const slut = parSlut(kod, start, '(', ')')
      const anrop = kod.slice(start, slut)
      if (!/\bdata\s*:\s*\{/.test(anrop) || /\.\.\./.test(anrop)) return null
      // Objektets shorthandfält är också en skrivning: `{ snapshot }`
      // får inte försvinna bara för att det saknar kolon.
      if (!rx(`${ID_START}${brygga.fält}\\s*(?::|[,}])`).test(anrop)) continue
      if (r !== skrivare.fil || m.index < skrivare.start || m.index > skrivare.slut || m[1] !== 'create' ||
          !rx(`${ID_START}${brygga.fält}\\s*:\\s*${citera(validerat[1])}\\.data\\s*[,}]`).test(anrop)) return null
      skrivningar++
    }
    for (const m of kod.matchAll(rx(`${ID_START}${brygga.schema}\\.parse\\s*\\(`, 'gu'))) {
      if (!importerar(r, brygga.schema, brygga.schemaFil)) return null
      const start = m.index + m[0].lastIndexOf('(')
      const slut = parSlut(kod, start, '(', ')')
      const objekt = kod.slice(start + 1, slut).trim()
      if (!objekt.startsWith('{') || /\.\.\./.test(objekt)) return null
      const html = [...objekt.matchAll(rx(`${ID_START}${brygga.htmlFält}\\s*:\\s*(?:await\\s+)?(?:this\\.)?(${IDENT})\\s*\\(`, 'gu'))]
      if (html.length !== 1 || [...objekt.matchAll(rx(`${ID_START}${brygga.htmlFält}\\s*:`, 'gu'))].length !== 1) return null
      const htmlStart = html[0].index + html[0][0].lastIndexOf('(')
      const htmlSlut = parSlut(objekt, htmlStart, '(', ')')
      if (htmlSlut < 0 || !/^\s*[,}]/.test(objekt.slice(htmlSlut + 1))) return null

      // Konstruktionen ska verkligen vara i callbacken som skickas till
      // skrivtjänsten och returnera samma lokala const, inte en namnlika kopia.
      let kopplad = false
      for (const anrop of kod.matchAll(rx(`\\.${brygga.skrivare}\\s*\\(\\s*\\{`, 'gu'))) {
        const a = anrop.index + anrop[0].indexOf('(')
        const b = parSlut(kod, a, '(', ')')
        if (m.index < a || m.index > b) continue
        const call = kod.slice(a, b)
        const cb = call.match(rx(`${ID_START}${brygga.callback}\\s*:\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`))
        if (!cb) continue
        const cbStart = a + cb.index + cb[0].lastIndexOf('{')
        const cbSlut = parSlut(kod, cbStart, '{', '}')
        if (m.index < cbStart || m.index > cbSlut) continue
        const callbackKod = kod.slice(cbStart, cbSlut)
        const namn = kod.slice(cbStart, m.index).match(rx(`\\bconst\\s+(${IDENT})\\s*=\\s*$`))?.[1]
        if (!namn || harMutation(callbackKod, namn) || /\.\.\./.test(callbackKod)) continue
        if (rx(`\\breturn\\s*\\{\\s*${brygga.fält}(?:\\s*:\\s*${citera(namn)})?\\s*[,}]`).test(callbackKod) &&
            (namn === brygga.fält || rx(`${ID_START}${brygga.fält}\\s*:\\s*${citera(namn)}\\s*[,}]`).test(callbackKod))) {
          kopplad = true
          koppladeAnrop.add(anrop.index)
        }
      }
      if (!kopplad) return null
      konstruktörer.push([r, html[0][1]])
    }
    for (const anrop of kod.matchAll(rx(`\\.${brygga.skrivare}\\s*\\(`, 'gu')))
      if (!koppladeAnrop.has(anrop.index)) return null
  }
  if (skrivningar !== 1 || konstruktörer.length === 0) return null
  const unika = new Set(konstruktörer.map(([r, symbol]) => `${r}#${symbol}`))
  if (unika.size !== 1 || konstruktörer[0][0] !== filRel) return null
  return konstruktörer[0][1]
}

/** Resolverar HTML-argumentet vid ett renderingsanrop till en producentsymbol. */
function producent(filRel, argument, index, filer) {
  const arg = argument.trim().replace(/^await\s+/, '')
  if (arg.includes(':')) return null // typannotering ⇒ metoddeklaration, inte anrop
  if (arg.includes('.')) {
    const sparad = sparadProducent(filRel, arg, index, filer)
    if (sparad) return sparad
  }
  const anrop = arg.match(/^(?:this\.)?([\p{L}\p{N}_$]+)\s*\(/u)
  if (anrop) return anrop[1]
  const ident = arg.match(/^([\p{L}\p{N}_$]+)$/u)
  if (!ident) return null
  const f = fil(filRel)
  const före = f.kalla.slice(0, index)
  const t = [...före.matchAll(new RegExp(`const\\s+${ident[1]}\\s*=\\s*(await\\s+)?([\\s\\S]{0,40})`, 'g'))].pop()
  if (!t) return null
  const uttryck = t[2].trim()
  if (uttryck.startsWith('`')) {
    // Inline-literal: producenten är den omslutande metoden.
    const idx = före.length - (t[0].length - (t[1]?.length ?? 0)) + t[0].indexOf('`')
    const om = kroppar(filRel).filter((k) => k.start <= idx && idx <= k.slut).sort((a, b) => b.start - a.start)[0]
    return om ? om.namn : null
  }
  const s = uttryck.match(/^(?:this\.)?([\p{L}\p{N}_$]+)\s*\(/u)
  return s ? s[1] : null
}

export function evaluate(filer) {
  const fel = []
  let renderingsställen = 0
  const producenter = new Set()
  const startpunkter = []

  for (const abs of filer) {
    const filRel = rel(abs)
    const f = fil(filRel)

    // R1 — renderingsställen bara i den grindade tjänsten.
    for (const m of f.mask.matchAll(/\.setContent\(/g)) {
      renderingsställen++
      if (filRel !== PDF_SERVICE) {
        const rad = f.kalla.slice(0, m.index).split('\n').length
        fel.push(`R1 ${filRel}:${rad} — page.setContent utanför ${PDF_SERVICE}. En ny renderingsväg går förbi vakten.`)
      }
    }

    // R3 — varje renderingsanrop knyts till en producent.
    for (const m of f.mask.matchAll(/generate(?:Contract)?FromHtml\(([^,)]*)/g)) {
      const symbol = producent(filRel, m[1], m.index, filer)
      if (symbol === null) {
        if (m[1].includes(':')) continue // metoddeklarationen i pdf.service
        const rad = f.kalla.slice(0, m.index).split('\n').length
        fel.push(`R3 ${filRel}:${rad} — HTML-argumentet "${m[1].trim()}" går inte att knyta till en producent. Vakten kan inte veta vilken mall som renderas.`)
        continue
      }
      producenter.add(`${filRel}#${symbol}`)
      startpunkter.push([filRel, symbol])
    }
    if (filRel === PDF_SERVICE) {
      for (const m of f.mask.matchAll(/const html = (generateInvoiceHtml)\(/g)) {
        producenter.add(`${filRel}#${m[1]}`)
        startpunkter.push([filRel, m[1]])
      }
    }
  }

  if (renderingsställen === 0) {
    fel.push('R1 — inga page.setContent hittades alls. Vakten mäter ingenting; har renderingen flyttat?')
  }

  // R2 — väntan är den delade konstanten, och den är 'load'.
  const svc = fil(PDF_SERVICE)
  for (const m of svc.mask.matchAll(/setContent\([^)]*waitUntil:\s*([^,}\s]+)/g)) {
    if (m[1] !== 'PDF_WAIT_UNTIL') {
      const rad = svc.kalla.slice(0, m.index).split('\n').length
      // Läs det SKRIVNA värdet ur källan, inte ur masken — där är stränginnehåll
      // blankat, och meddelandet hade sagt `waitUntil är "'"` i stället för att
      // namnge värdet. Ett felmeddelande som inte säger vad som står är en
      // ledtråd mindre för den som ska rätta det.
      const radtext = svc.kalla.split('\n')[rad - 1] ?? ''
      const skrivet = (radtext.match(/waitUntil:\s*([^,}\s]+)/)?.[1] ?? m[1]).trim()
      fel.push(`R2 ${PDF_SERVICE}:${rad} — waitUntil är ${skrivet}, inte den delade PDF_WAIT_UNTIL. Mätningen och motiveringen bor i ${WAIT_KONST}; en egen literal här kringgår båda.`)
    }
  }
  const värde = existsSync(join(ROT, WAIT_KONST))
    ? fil(WAIT_KONST).kalla.match(/PDF_WAIT_UNTIL[^=]*=\s*'([^']+)'/)
    : null
  if (!värde) fel.push(`R2 ${WAIT_KONST} — PDF_WAIT_UNTIL saknas eller går inte att läsa.`)
  else if (värde[1] === 'domcontentloaded')
    fel.push(`R2 ${WAIT_KONST} — PDF_WAIT_UNTIL är 'domcontentloaded'. Den väntar INTE in bilder. Skillnaden mot 'load' är ~1 ms; garantin är inte värd att sälja för den.`)
  else if (värde[1] !== 'load')
    fel.push(`R2 ${WAIT_KONST} — PDF_WAIT_UNTIL är '${värde[1]}', inte 'load'.`)

  // R3/R4 — registret faller åt båda hållen.
  const kvitterade = new Set(REGISTER.map(([f, s]) => `${f}#${s}`))
  for (const h of producenter)
    if (!kvitterade.has(h))
      fel.push(`R3 ${h} — mallproducent som koden leder till men som ingen kvitterat. Lägg en rad i REGISTER och intyga att mallen är självförsörjande.`)
  for (const k of kvitterade)
    if (!producenter.has(k))
      fel.push(`R4 ${k} — kvitterad producent som koden inte längre leder till. En kvittens som överlever sin mall gör registret till fiktion.`)

  // Anropskedjan från varje producent, genom funktionskroppar.
  const granskade = new Set()
  const kö = [...startpunkter]
  const literaler = []
  while (kö.length) {
    const [f0, s0] = kö.pop()
    const träff = hittaFunktion(f0, s0)
    if (!träff) continue
    const nyckel = `${träff.fil}#${träff.namn}#${träff.start}`
    if (granskade.has(nyckel)) continue
    granskade.add(nyckel)
    const d = fil(träff.fil)
    for (const lit of d.literaler)
      if (lit.start > träff.start && lit.start < träff.slut) literaler.push({ fil: träff.fil, ...lit })
    const kropp = d.mask.slice(träff.start, träff.slut)
    for (const m of kropp.matchAll(/(?<![\p{L}\p{N}_$])([\p{L}\p{N}_$]{3,})\s*\(/gu)) kö.push([träff.fil, m[1]])
  }

  // R5/R6 — innehållet i mallarnas markup.
  const sedda = new Set()
  for (const lit of literaler) {
    for (const [re, namn] of FÖRBJUDNA)
      if (re.test(lit.text))
        fel.push(`R5 ${lit.fil}:${lit.rad} — mallen innehåller "${namn}". PDF-mallar måste vara självförsörjande; ett externt anrop bryter antagandet bakom waitUntil: 'load'.`)
    for (const m of lit.text.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) {
      const v = m[1].trim()
      if (v.startsWith('data:')) continue
      const kvitto = DATAINTERPOLATIONER.find(([f, i]) => f === lit.fil && v.includes(i))
      if (kvitto) { sedda.add(`${kvitto[0]}#${kvitto[1]}`); continue }
      fel.push(`R6 ${lit.fil}:${lit.rad} — resursattributet "${v}" är varken en data:-URL eller en kvitterad interpolation.`)
    }
  }
  for (const [f, i] of DATAINTERPOLATIONER)
    if (!sedda.has(`${f}#${i}`))
      fel.push(`R6 ${f} — kvitterad datainterpolation "${i}" förekommer inte längre. Kvittensen har överlevt sin förekomst.`)

  return {
    fel,
    mätt: {
      renderingsställen,
      producenter: producenter.size,
      producentlista: [...producenter].sort(),
      funktioner: granskade.size,
      literaler: literaler.length,
      filer: new Set(literaler.map((l) => l.fil)).size,
    },
  }
}

// ── kanariefåglar ───────────────────────────────────────────────────────────

function självtest() {
  const fel = []
  const bas = evaluate(allaTs(SRC))
  if (bas.fel.length) fel.push(`baslinjen är inte grön:\n    ${bas.fel.join('\n    ')}`)

  // KANARIE 1 — mönsterlistan fäller en Google Fonts-<link>. Utan den kan
  // FÖRBJUDNA ha tömts eller trasigats utan att någon regel slutar vara grön.
  const prov = '<head><link rel="stylesheet" href="https://fonts.googleapis.com/css?x"></head>'
  const träff = FÖRBJUDNA.filter(([re]) => re.test(prov)).map(([, n]) => n)
  for (const krav of ['<link', 'http(s)://'])
    if (!träff.includes(krav)) fel.push(`KANARIE 1: mönsterlistan fäller inte "${krav}" (fällde: ${träff.join(', ') || 'inget'})`)

  // KANARIE 2 — skannern hittar markup i en RIKTIG mallfil, och kommentarer
  // maskeras utan att ta template-literaler med sig. Slutar skannern läsa blir
  // R5 grön för allt, och det är precis det tysta läget vakten ska undvika.
  const shell = fil('src/common/branding/branded-pdf-shell.ts')
  if (shell.literaler.length === 0) fel.push('KANARIE 2: skannern hittar noll markup-literaler i branded-pdf-shell.ts — mekanismen är blind.')
  if (!shell.literaler.some((l) => /<img/.test(l.text))) fel.push('KANARIE 2: skannern hittar ingen <img> i shellen — R6 kan inte mäta något.')
  const kommentarProv = skanna("const a = `<p>https://x</p>` // se https://y\n")
  if (kommentarProv.literaler.length !== 1 || !kommentarProv.literaler[0].text.includes('https://x'))
    fel.push('KANARIE 2: kommentarsmaskeringen äter template-literaler — ett "https://" i en mall skulle bli osynligt.')

  // KANARIE 5 — den DELADE skannerns egna kanariefåglar körs här. Bryts
  // scripts/lib/source-scan.mjs blir VARJE vakt som använder den röd, inte bara
  // dess egen spec. Det är hela poängen med att den är delad.
  for (const f of kanariefåglar()) fel.push(`KANARIE 5 (delad skanner): ${f}`)

  // KANARIE 3 — kedjan når den delade shellen TRANSITIVT. Bryts den granskas
  // bara producenternas egna kroppar, och shellen blir osynlig.
  if (!bas.mätt.filer || bas.mätt.filer < 5)
    fel.push(`KANARIE 3: markup hittades i bara ${bas.mätt.filer} filer — anropskedjan når inte de delade skalen.`)

  // ── KANARIE 6 — SVENSKA FUNKTIONSNAMN I KEDJAN (#713) ────────────────────
  //
  // Kedjan följs genom att HÄRLEDA anropade funktionsnamn ur maskerad kod.
  // Härledningen gick via `[A-Za-z_$][\w$]*`, som är ASCII, och två riktiga
  // funktioner i apps/api/src föll därför ur kedjan — uppmätt mot origin/main,
  // inte befarat:
  //
  //     src/ai/tools/tool-executor.service.ts#ärBatchMottagarkonflikt
  //     src/maintenance/duplicate-ticket-window.ts#hittaFärskDubblett
  //
  // 64 funktioner granskade i stället för 66. De två felformerna, båda i
  // listan ovan:
  //
  //   MISSAD  `ärBatchMottagarkonflikt` — `[A-Za-z_$]` matchar inte `ä`.
  //   KAPAD   `hittaFärskDubblett` — svansen `hittaF` fångas, men `\s*\(`
  //           följer inte, så anropet försvinner ändå. KAPAD kan alltså sluta
  //           som en MISSAD när mönstret kräver något EFTER namnet.
  //
  // Konsekvensen var inte kosmetisk: allt inuti de två funktionerna — varje
  // mall-literal, varje `https://`, varje `<link>` — låg utanför R5/R6. Vakten
  // var grön om kod den aldrig läst.
  const kedjeProv = [
    ['svensk INITIAL', 'ärNågot', 'const x = ärNågot(1)'],
    ['svenskt tecken MITT i', 'hittaFärskDubblett', 'const y = hittaFärskDubblett(2)'],
    ['ren ASCII', 'hittaDubblett', 'const z = hittaDubblett(3)'],
  ]
  for (const [vad, namn, kod] of kedjeProv) {
    const hittade = [...kod.matchAll(/(?<![\p{L}\p{N}_$])([\p{L}\p{N}_$]{3,})\s*\(/gu)].map((m) => m[1])
    if (!hittade.includes(namn))
      fel.push(`KANARIE 6 (${vad}): anropet till ${namn} härleds inte ur kedjan — hittade ${JSON.stringify(hittade)}`)
  }

  // MOTPROVEN.
  //
  // DELSTRÄNG: härledningen får aldrig börja MITT i ett namn. `zzhittaDubblett(`
  // är ett anrop till `zzhittaDubblett`, inte till `hittaDubblett`. Utan det
  // här provet hade en fix som helt tog bort avgränsningen sett likadan ut.
  const hel = [...'zzhittaDubblett(1)'.matchAll(/(?<![\p{L}\p{N}_$])([\p{L}\p{N}_$]{3,})\s*\(/gu)].map((m) => m[1])
  if (hel.join(',') !== 'zzhittaDubblett')
    fel.push(`KANARIE 6 MOTPROV: härledningen började mitt i ett namn — ${JSON.stringify(hel)}`)

  // Ett METODANROP fångas med flit (kedjan följer `this.x()` och `obj.y()`),
  // och punkten står inte i lookbehindens klass. Det var så `\b` betedde sig
  // också — provet står här för att nästa läsare inte ska tro att det är en
  // regression när `obj.gör()` dyker upp i kön.
  const metod = [...'obj.hittaFärskDubblett(1)'.matchAll(/(?<![\p{L}\p{N}_$])([\p{L}\p{N}_$]{3,})\s*\(/gu)].map((m) => m[1])
  if (metod.join(',') !== 'hittaFärskDubblett')
    fel.push(`KANARIE 6 MOTPROV: metodnamnet efter punkt fångas inte längre — ${JSON.stringify(metod)}`)

  // TRÖSKELN {3,} ska bestå, annars fylls kön med `if(`, `for(` och brus.
  const kort = [...'ab(1)'.matchAll(/(?<![\p{L}\p{N}_$])([\p{L}\p{N}_$]{3,})\s*\(/gu)]
  if (kort.length !== 0) fel.push('KANARIE 6 MOTPROV: tvåteckensnamn passerar tröskeln {3,}')

  // Och GOLVET: kedjan ska nå minst de 66 som mättes upp. Sjunker talet har
  // härledningen gått blind igen, och det syns inte på att vakten är grön.
  if (bas.mätt.funktioner < 66)
    fel.push(`KANARIE 6: bara ${bas.mätt.funktioner} funktioner i kedjan, golv 66 — härledningen har tappat namn.`)

  // KANARIE 4 — resolvern knyter faktiskt anrop till producenter.
  if (bas.mätt.producenter < REGISTER.length)
    fel.push(`KANARIE 4: bara ${bas.mätt.producenter} producenter härleddes ur ${REGISTER.length} kvitterade — resolvern har slutat matcha.`)

  // KANARIE 7 — ändra riktig källa I MINNET och kör samma evaluate som CI.
  // Därmed prövas att bryggan gör skillnad för renderingsplatserna, inte
  // bara att en fristående regex råkar matcha en handskriven sträng.
  const avi = 'src/avisering/avisering.service.ts'
  const brygga = SPARAD_HTML[0]
  const filer = allaTs(SRC)
  let bryggprov = 0
  function muterat(namn, filRel, ändra, regel) {
    const original = fil(filRel)
    const kalla = ändra(original.kalla)
    if (kalla === original.kalla) {
      fel.push(`KANARIE 7 (${namn}): mutationen ändrade ingen källa`)
      return
    }
    try {
      cache.set(filRel, { kalla, ...skanna(kalla) })
      const resultat = evaluate(filer)
      if (regel === null ? resultat.fel.length !== 0 : !resultat.fel.some((f) => f.startsWith(regel)))
        fel.push(`KANARIE 7 (${namn}): ${regel ?? 'grön vakt'} förväntades, fick ${JSON.stringify(resultat.fel)}`)
      bryggprov++
    } finally {
      cache.set(filRel, original)
    }
  }
  const ursprung = 'html: await this.buildNoticePdfHtml(currentNotice, currentOrg, logo),'
  muterat('borttagen producentbindning', avi, (k) => k.replace(ursprung, 'html: okändHtml,'), 'R3 ')
  muterat('kommentar är ingen producentbindning', avi, (k) => k.replace(ursprung, `html: okändHtml, // ${ursprung}`), 'R3 ')
  muterat('tillägg efter den säkra producenten', avi, (k) => k.replace(ursprung, 'html: await this.buildNoticePdfHtml(currentNotice, currentOrg, logo) + okändHtml,'), 'R3 ')
  muterat('ett annat objekt med samma variabelnamn', avi, (k) => k.replaceAll('const snapshot = readNoticeSnapshot(dispatch)', 'const snapshot = { html: okändHtml }'), 'R3 ')
  muterat('läst snapshot ersatt i argumentet', avi, (k) => k.replaceAll('readNoticeSnapshot(dispatch)', 'readNoticeSnapshot({ ...dispatch, snapshot: okändSnapshot })'), 'R3 ')
  muterat('förändrat objekt efter validering', avi, (k) => k.replace('return { snapshot, toHash: noticeRecipientHash(snapshot.to) }', 'snapshot.html = okändHtml\nreturn { snapshot, toHash: noticeRecipientHash(snapshot.to) }'), 'R3 ')
  muterat('bruten validerad läsare', brygga.schemaFil, (k) => k.replace('return parsed.data', 'return { ...parsed.data, html: okändHtml }'), 'R3 ')
  muterat('annan payload lagras', brygga.skrivFil, (k) => k.replace('snapshot: parsed.data,', 'snapshot: { html: okändHtml },'), 'R3 ')
  muterat('okänd direkt skrivning med shorthandfält', brygga.skrivFil, (k) => k + '\nfunction sond(tx, fields, snapshot) { return tx.rentNoticeSend.create({ data: { rentNoticeId: fields.id, kind: fields.kind, snapshot } }) }\n', 'R3 ')
  muterat('ny callback utan verifierad producent', avi, (k) => k + '\nfunction sond() { return service.prepareNoticeForSend({ buildSnapshot: async () => ({ snapshot: okändSnapshot }) }) }\n', 'R3 ')
  muterat('osäker HTML i verklig producent', avi, (k) => {
    const producent = hittaFunktion(avi, 'buildNoticePdfHtml')
    const lit = fil(avi).literaler.find((l) => l.start > producent.start && l.start < producent.slut)
    return k.slice(0, lit.start + 1) + '<link href="https://fonts.invalid/prov.css">' + k.slice(lit.start + 1)
  }, 'R5 ')
  muterat('svenskt lokalt namn bevarar härledningen', avi, (k) => {
    const intervall = ['processPreparedNoticeSend', 'getNoticePdfBuffer']
      .map((namn) => hittaFunktion(avi, namn)).sort((a, b) => b.start - a.start)
    for (const { start, slut } of intervall)
      k = k.slice(0, start) + k.slice(start, slut).replace(/(?<![\p{L}\p{N}_$])snapshot(?![\p{L}\p{N}_$])/gu, 'återlästAvi') + k.slice(slut)
    return k
  }, null)

  if (fel.length) { console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  ')); process.exit(1) }
  console.warn(
    `SJÄLVTEST GRÖNT — ${bas.mätt.renderingsställen} renderingsställen, ${bas.mätt.producenter} producenter, ` +
      `${bas.mätt.funktioner} funktioner i kedjan, ${bas.mätt.literaler} mall-literaler i ${bas.mätt.filer} filer, 7 kanariefåglar (${bryggprov} bryggprov).`,
  )
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-pdf-templates-selfcontained.mjs') ?? false

if (!KÖRS_DIREKT) {
  // importerad (självtest-spec, felsökning) — kör ingenting av sig själv
} else if (process.argv.includes('--self-test')) självtest()
else {
  const { fel, mätt } = evaluate(allaTs(SRC))
  if (fel.length) { console.error('PDF-mallar är inte självförsörjande:\n  ' + fel.join('\n  ')); process.exit(1) }
  console.warn(
    `PDF-mallar självförsörjande — ${mätt.renderingsställen} renderingsställen, ${mätt.producenter} producenter, ` +
      `${mätt.literaler} mall-literaler i ${mätt.filer} filer granskade.`,
  )
}
