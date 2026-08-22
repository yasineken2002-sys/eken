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
 * `--self-test` kör samma `evaluate()` som CI kör, med fyra kanariefåglar.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

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
 * KVITTENS — varje `src=`/`href=` i en mall vars värde är en INTERPOLATION och
 * därför inte kan läsas som `data:` av vakten. Faller åt båda hållen.
 */
const DATAINTERPOLATIONER = [
  ['src/common/branding/branded-pdf-shell.ts', 'input.logoDataUrl', 'getLogoDataUrl → data: eller null'],
  ['src/contracts/contract-template.shared.ts', 'logoDataUrl', 'getLogoDataUrl → data: eller null'],
]

/**
 * Tecken efter vilka ett `/` inleder en REGEX och inte en division. Efter en
 * identifierare, ett tal eller `)`/`]` är `/` division.
 */
const REGEX_LÄGE = /^$|[(,=:[!&|?{};+\-*%~^<>]|`/

const FÖRBJUDNA = [
  [/https?:\/\//, 'http(s)://'],
  [/(?:^|[\s"'(=])\/\/[a-zA-Z0-9]/, 'protokollrelativ //'],
  [/@import/, '@import'],
  [/url\(/, 'url('],
  [/<link\b/i, '<link'],
  [/<script\b/i, '<script'],
  [/@font-face/i, '@font-face'],
]

// ── källskanner ─────────────────────────────────────────────────────────────

/**
 * Ett svep som ger BÅDE en maskerad källa (kommentarer och stränginnehåll
 * utbytta mot mellanslag, längden bevarad så index håller) OCH varje
 * markup-bärande template-literal med radnummer.
 *
 * Varför inte två regexar: `//` inne i en template-literal är `https://`, inte
 * en kommentar. En kommentarstrippare som inte känner strängar hade tystat
 * precis det mönster vakten finns för att hitta.
 */
function skanna(kalla) {
  const mask = kalla.split('')
  const literaler = []
  let i = 0
  let förra = ''
  const blank = (a, b) => { for (let k = a; k < b && k < mask.length; k++) if (mask[k] !== '\n') mask[k] = ' ' }
  while (i < kalla.length) {
    const c = kalla[i]
    // REGEX-LITERAL. Måste hanteras FÖRE strängar, annars läses `"` i
    // `.replace(/"/g, '&quot;')` som en strängstart — och skannern blankar då
    // allt fram till nästa `"`. Uppmätt i platform-invoices.service.ts: 11 629
    // tecken maskerades, renderingsanropet försvann, och vakten var GRÖN om den
    // filen. En vakt som går blind utan att sluta vara grön är värre än ingen.
    if (c === '/' && kalla[i + 1] !== '/' && kalla[i + 1] !== '*' && REGEX_LÄGE.test(förra)) {
      let j = i + 1
      let klass = false
      while (j < kalla.length && kalla[j] !== '\n') {
        if (kalla[j] === '\\') { j += 2; continue }
        if (kalla[j] === '[') klass = true
        else if (kalla[j] === ']') klass = false
        else if (kalla[j] === '/' && !klass) break
        j++
      }
      if (kalla[j] === '/') { blank(i + 1, j); förra = '/'; i = j + 1; continue }
    }
    if (c === '/' && kalla[i + 1] === '/') {
      const slut = kalla.indexOf('\n', i); const e = slut === -1 ? kalla.length : slut
      blank(i, e); i = e; continue
    }
    if (c === '/' && kalla[i + 1] === '*') {
      const slut = kalla.indexOf('*/', i + 2); const e = slut === -1 ? kalla.length : slut + 2
      blank(i, e); i = e; continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < kalla.length && kalla[j] !== c) { if (kalla[j] === '\\') j++; j++ }
      blank(i + 1, j); förra = c; i = j + 1; continue
    }
    if (c === '`') {
      let j = i + 1, djup = 0
      while (j < kalla.length) {
        if (kalla[j] === '\\') { j += 2; continue }
        if (kalla[j] === '$' && kalla[j + 1] === '{') { djup++; j += 2; continue }
        if (kalla[j] === '}' && djup > 0) { djup--; j++; continue }
        if (kalla[j] === '`' && djup === 0) break
        j++
      }
      const text = kalla.slice(i + 1, j)
      if (/<[a-zA-Z!]/.test(text)) {
        literaler.push({ text, start: i, rad: kalla.slice(0, i).split('\n').length })
      }
      blank(i + 1, j); förra = '`'; i = j + 1; continue
    }
    if (!/\s/.test(c)) förra = c
    i++
  }
  return { mask: mask.join(''), literaler }
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

const DEKL = /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:private\s+|public\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g
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
    while (b < f.mask.length && /[\s:<>|&\][\w$,.'"]/.test(f.mask[b])) b++
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

/** Resolverar HTML-argumentet vid ett renderingsanrop till en producentsymbol. */
function producent(filRel, argument, index) {
  const arg = argument.trim().replace(/^await\s+/, '')
  if (arg.includes(':')) return null // typannotering ⇒ metoddeklaration, inte anrop
  const anrop = arg.match(/^(?:this\.)?([A-Za-z_$][\w$]*)\s*\(/)
  if (anrop) return anrop[1]
  const ident = arg.match(/^([A-Za-z_$][\w$]*)$/)
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
  const s = uttryck.match(/^(?:this\.)?([A-Za-z_$][\w$]*)\s*\(/)
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
      const symbol = producent(filRel, m[1], m.index)
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
    for (const m of kropp.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(/g)) kö.push([träff.fil, m[1]])
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

  // KANARIE 5 — skannern förväxlar inte en REGEX-LITERAL med en sträng. Den
  // här defekten fanns på riktigt: `.replace(/"/g, '&quot;')` läste `"` som
  // strängstart och blankade 11 629 tecken av
  // platform-invoices.service.ts — renderingsanropet försvann och vakten var
  // GRÖN om hela den filen. Ingen befintlig regel föll; bara den här faller.
  const desync = skanna('a.replace(/"/g, \'x\')\nconst h = `<p><link href="https://x"></p>`\n')
  if (desync.literaler.length !== 1)
    fel.push(`KANARIE 5: efter en regex-literal hittar skannern ${desync.literaler.length} mall-literaler i stället för 1 — den har desynkat och går blind.`)
  else if (!FÖRBJUDNA.some(([re]) => re.test(desync.literaler[0].text)))
    fel.push('KANARIE 5: literalen efter regex-literalen bär en <link> som inte fälls.')

  // KANARIE 3 — kedjan når den delade shellen TRANSITIVT. Bryts den granskas
  // bara producenternas egna kroppar, och shellen blir osynlig.
  if (!bas.mätt.filer || bas.mätt.filer < 5)
    fel.push(`KANARIE 3: markup hittades i bara ${bas.mätt.filer} filer — anropskedjan når inte de delade skalen.`)

  // KANARIE 4 — resolvern knyter faktiskt anrop till producenter.
  if (bas.mätt.producenter < REGISTER.length)
    fel.push(`KANARIE 4: bara ${bas.mätt.producenter} producenter härleddes ur ${REGISTER.length} kvitterade — resolvern har slutat matcha.`)

  if (fel.length) { console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  ')); process.exit(1) }
  console.warn(
    `SJÄLVTEST GRÖNT — ${bas.mätt.renderingsställen} renderingsställen, ${bas.mätt.producenter} producenter, ` +
      `${bas.mätt.funktioner} funktioner i kedjan, ${bas.mätt.literaler} mall-literaler i ${bas.mätt.filer} filer, 5 kanariefåglar.`,
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
