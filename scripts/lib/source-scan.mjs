/**
 * EN källskanner för alla vakter som förbehandlar sin indata.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Tre varianter av SAMMA defekt mättes upp på en dag, av tre olika händer:
 *
 *   1. PDF-vaktens skanner läste `"` i `.replace(/"/g, '&quot;')` som en
 *      strängstart och blankade 11 629 tecken av platform-invoices.service.ts.
 *      Renderingsanropet försvann ur mängden och vakten var GRÖN om hela filen.
 *   2. Fyra vakter strippade kommentarer med en naken `replace`-regex på
 *      radkommentarer, som inte kan strängar: ett `'https://x'` i en literal
 *      äter resten av raden.
 *   3. En mätsond utan regex-hantering desynkade på accounting.service.ts och
 *      rapporterade 36 filer i stället för 30.
 *
 * Tre gånger är inte slarv. Det är att var och en skriver sin egen
 * förbehandlare. Den här modulen är den enda, och vakterna komponerar ur den.
 *
 * ── VAD SOM ÄR SVÅRT ────────────────────────────────────────────────────────
 *
 * En `/` är regex eller division beroende på vad som stod före. En `//` är en
 * kommentar utom i en sträng. Ett `${}` i en mallsträng är KOD — och kan
 * innehålla strängar med `}` i sig, så en ren djupräkning på klammer räcker
 * inte. Därför tokeniseras `${}`-uttryck REKURSIVT.
 *
 * ── SEMANTIKEN BEHÅLLS PER VAKT ─────────────────────────────────────────────
 *
 * Modulen tar inte ställning till vad en vakt vill se. `tokenize` klassificerar;
 * `removeRegions`/`blankRegions` låter varje vakt välja. En vakt som vill se
 * kommentarer gör det fortfarande — det som försvinner är att var och en gissar
 * själv hur en sträng slutar.
 */

/** Tecken efter vilka ett `/` inleder en REGEX och inte en division. */
const REGEX_LÄGE = /^$|[(,=:[!&|?{};+\-*%~^<>]|`|\breturn$|\btypeof$|\bcase$|\bin$|\bof$|\bdo$|\belse$|\byield$|\bawait$/

/** @typedef {'line-comment'|'block-comment'|'string'|'template'|'regex'} TokenKind */

/**
 * Tokeniserar källa och returnerar varje icke-kod-region.
 *
 * @param {string} text
 * @param {{dialect?: 'ts'|'sql'|'css'}} [opts]
 * @returns {Array<{kind: TokenKind, start: number, end: number, bodyStart: number, bodyEnd: number, exprs?: Array<{start:number,end:number}>}>}
 *   `start`/`end` omsluter hela regionen inklusive avgränsare; `bodyStart`/
 *   `bodyEnd` innehållet mellan dem. För mallsträngar listar `exprs` varje
 *   `${…}`-uttrycks INNEHÅLL — de är kod, inte sträng.
 */
export function tokenize(text, { dialect = 'ts' } = {}) {
  if (dialect === 'sql') return tokenizeBlockOnly(text, { radkommentar: '--' })
  if (dialect === 'css') return tokenizeBlockOnly(text, { radkommentar: null })
  return tokenizeTs(text, 0, text.length)
}

function tokenizeTs(text, från, till) {
  const ut = []
  let i = från
  let förra = ''
  while (i < till) {
    const c = text[i]

    // Radkommentar
    if (c === '/' && text[i + 1] === '/') {
      const n = text.indexOf('\n', i)
      const slut = n === -1 || n > till ? till : n
      ut.push({ kind: 'line-comment', start: i, end: slut, bodyStart: i + 2, bodyEnd: slut })
      i = slut
      continue
    }

    // Blockkommentar
    if (c === '/' && text[i + 1] === '*') {
      const n = text.indexOf('*/', i + 2)
      const slut = n === -1 || n + 2 > till ? till : n + 2
      ut.push({ kind: 'block-comment', start: i, end: slut, bodyStart: i + 2, bodyEnd: Math.max(i + 2, slut - 2) })
      i = slut
      continue
    }

    // Regex-literal. MÅSTE prövas före strängar: annars läses `"` i
    // `.replace(/"/g, …)` som en strängstart. Det var defekt 1.
    if (c === '/' && REGEX_LÄGE.test(förra)) {
      const slut = regexSlut(text, i, till)
      if (slut !== -1) {
        ut.push({ kind: 'regex', start: i, end: slut, bodyStart: i + 1, bodyEnd: slut - 1 })
        förra = '/'
        i = slut
        continue
      }
    }

    // Enkel-/dubbelciterad sträng
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < till && text[j] !== c) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '\n') break // oterminerad — bryt vid radslut
        j++
      }
      const slut = Math.min(j + 1, till)
      ut.push({ kind: 'string', start: i, end: slut, bodyStart: i + 1, bodyEnd: j })
      förra = c
      i = slut
      continue
    }

    // Mallsträng — `${}` tokeniseras REKURSIVT (kan innehålla `}` i en sträng)
    if (c === '`') {
      const { slut, exprs, inre } = mallSlut(text, i, till)
      ut.push({ kind: 'template', start: i, end: slut, bodyStart: i + 1, bodyEnd: slut - 1, exprs })
      ut.push(...inre)
      förra = '`'
      i = slut
      continue
    }

    // Hoppa över hela identifieraren i ETT steg. Att räkna om ordet för varje
    // tecken gör svepet kvadratiskt i ordlängd utan att ge något.
    if (/[A-Za-z_$]/.test(c)) {
      let b = i
      while (b + 1 < till && /[\w$]/.test(text[b + 1])) b++
      förra = text.slice(i, b + 1)
      i = b + 1
      continue
    }
    if (!/\s/.test(c)) förra = c
    i++
  }
  return ut
}

/** Slutet på en regex-literal (index EFTER avslutande `/` + flaggor), eller -1. */
function regexSlut(text, start, till) {
  let j = start + 1
  let klass = false
  while (j < till) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === '\n') return -1 // en regex får inte spänna över rader → var division
    if (c === '[') klass = true
    else if (c === ']') klass = false
    else if (c === '/' && !klass) {
      let k = j + 1
      while (k < till && /[dgimsuvy]/.test(text[k])) k++
      return k
    }
    j++
  }
  return -1
}

/** Slutet på en mallsträng, plus dess `${}`-uttryck och tokens inuti dem. */
function mallSlut(text, start, till) {
  const exprs = []
  const inre = []
  let j = start + 1
  while (j < till) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === '`') return { slut: j + 1, exprs, inre }
    if (c === '$' && text[j + 1] === '{') {
      const uttrycksStart = j + 2
      const slutKlammer = uttrycksSlut(text, uttrycksStart, till)
      exprs.push({ start: uttrycksStart, end: slutKlammer })
      inre.push(...tokenizeTs(text, uttrycksStart, slutKlammer))
      j = Math.min(slutKlammer + 1, till)
      continue
    }
    j++
  }
  return { slut: till, exprs, inre }
}

/**
 * Index för `}` som stänger ett `${`, med kännedom om strängar och kommentarer.
 *
 * Hoppar över EN token i taget (`enTokenVid`) i stället för att tokenisera hela
 * filresten. Den första versionen gjorde det senare och blev KVADRATISK — på en
 * 159 kB-fil med många `${}` hängde den. En vakt som tar minuter stängs av, och
 * en avstängd vakt mäter ingenting.
 */
function uttrycksSlut(text, från, till) {
  let djup = 0
  let i = från
  while (i < till) {
    const c = text[i]
    if (c === '}' && djup === 0) return i
    if (c === '{') { djup++; i++; continue }
    if (c === '}') { djup--; i++; continue }
    const t = enTokenVid(text, i, till)
    if (t) { i = t.end; continue }
    i++
  }
  return till
}

/** Tokenen som börjar exakt vid `i`, eller null. Skannar bara den. */
function enTokenVid(text, i, till) {
  const c = text[i]
  if (c === '/' && text[i + 1] === '/') {
    const n = text.indexOf('\n', i)
    return { end: n === -1 || n > till ? till : n }
  }
  if (c === '/' && text[i + 1] === '*') {
    const n = text.indexOf('*/', i + 2)
    return { end: n === -1 || n + 2 > till ? till : n + 2 }
  }
  if (c === "'" || c === '"') {
    let j = i + 1
    while (j < till && text[j] !== c) {
      if (text[j] === '\\') { j += 2; continue }
      if (text[j] === '\n') break
      j++
    }
    return { end: Math.min(j + 1, till) }
  }
  if (c === '`') return { end: mallSlut(text, i, till).slut }
  return null
}

/**
 * Dialekter utan mallsträngar och regex: SQL (radkommentar `--`) och CSS (ingen
 * radkommentar alls).
 *
 * CSS MÅSTE ha `radkommentar: null`. Med `--` som radkommentar läses varje
 * custom property — `--ev-brand: …` — som en kommentar, och resten av raden
 * blankas. Uppmätt: den mappningen gjorde design-token-vaktens allowlist-post
 * för TenantAiChat.module.css stale (8 träffar → 0) och fällde självtestet.
 */
function tokenizeBlockOnly(text, { radkommentar }) {
  const ut = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (radkommentar && c === radkommentar[0] && text[i + 1] === radkommentar[1]) {
      const n = text.indexOf('\n', i)
      const slut = n === -1 ? text.length : n
      ut.push({ kind: 'line-comment', start: i, end: slut, bodyStart: i + 2, bodyEnd: slut })
      i = slut
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const n = text.indexOf('*/', i + 2)
      const slut = n === -1 ? text.length : n + 2
      ut.push({ kind: 'block-comment', start: i, end: slut, bodyStart: i + 2, bodyEnd: Math.max(i + 2, slut - 2) })
      i = slut
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === c && text[j + 1] === c) { j += 2; continue } // '' = escapad
        if (text[j] === c) break
        j++
      }
      const slut = Math.min(j + 1, text.length)
      ut.push({ kind: 'string', start: i, end: slut, bodyStart: i + 1, bodyEnd: j })
      i = slut
      continue
    }
    i++
  }
  return ut
}

// ── komposition ─────────────────────────────────────────────────────────────

const KOMMENTARER = ['line-comment', 'block-comment']

/** Regioner som inte ligger inuti en annan region (mallens `${}` ger nästling). */
function yttersta(tokens) {
  const s = [...tokens].sort((a, b) => a.start - b.start || b.end - a.end)
  const ut = []
  let gräns = -1
  for (const t of s) {
    if (t.start >= gräns) { ut.push(t); gräns = t.end }
  }
  return ut
}

/**
 * Tar BORT regionerna (strängen kortas). Motsvarar det gamla
 * `withoutComments` — fast utan att äta resten av raden efter ett `//` i en
 * sträng.
 */
export function removeRegions(text, kinds, opts) {
  const behåll = new Set(kinds)
  let ut = ''
  let i = 0
  for (const t of yttersta(tokenize(text, opts)).filter((t) => behåll.has(t.kind))) {
    ut += text.slice(i, t.start)
    i = t.end
  }
  return ut + text.slice(i)
}

/**
 * Ersätter regionerna med blanksteg. LÄNGDEN OCH RADNUMREN BEVARAS, så
 * index i den maskerade källan pekar på samma ställe i originalet.
 *
 * @param {'full'|'body'} del — hela regionen inkl. avgränsare, eller bara
 *   innehållet (så att ```, `'` och `/` står kvar och koden går att brace-matcha).
 */
export function blankRegions(text, kinds, { del = 'full', ...opts } = {}) {
  const behåll = new Set(kinds)
  const mask = text.split('')
  for (const t of tokenize(text, opts)) {
    if (!behåll.has(t.kind)) continue
    const a = del === 'body' ? t.bodyStart : t.start
    const b = del === 'body' ? t.bodyEnd : t.end
    for (let k = a; k < b && k < mask.length; k++) if (mask[k] !== '\n') mask[k] = ' '
  }
  return mask.join('')
}

/** Kommentarer bort, strängar orörda. Ersätter fyra handrullade kopior. */
export function withoutComments(text, opts) {
  return removeRegions(text, KOMMENTARER, opts)
}

/** Kommentarer → blanksteg, positioner bevarade. */
export function blankComments(text, opts) {
  return blankRegions(text, KOMMENTARER, opts)
}

/**
 * Kod-mask: kommentarer OCH stränginnehåll blankade, avgränsare kvar. Det som
 * behövs för att brace-matcha eller söka efter kod utan att träffa prosa.
 */
export function codeMask(text, opts) {
  return blankRegions(
    blankRegions(text, KOMMENTARER, opts),
    ['string', 'template', 'regex'],
    { ...opts, del: 'body' },
  )
}

/**
 * Tar bort `import`-satser — men bara sådana som står i KOD. En rad som ser ut
 * som en import inuti en mallsträng (t.ex. ett kodexempel i en prompt) rörs
 * inte.
 */
export function removeImports(text, opts) {
  const literaler = yttersta(tokenize(text, opts)).filter((t) => t.kind !== 'line-comment' && t.kind !== 'block-comment')
  const inutiLiteral = (i) => literaler.some((t) => i > t.start && i < t.end)
  let ut = ''
  let sist = 0
  for (const m of text.matchAll(/^import\s[\s\S]*?from\s+['"][^'"]*['"];?[ \t]*$/gm)) {
    if (inutiLiteral(m.index)) continue
    ut += text.slice(sist, m.index)
    sist = m.index + m[0].length
  }
  return ut + text.slice(sist)
}

/** Varje mallsträng (backticks), yttersta nivån först. */
export function templateLiterals(text, opts) {
  return yttersta(tokenize(text, opts))
    .filter((t) => t.kind === 'template')
    .map((t) => ({
      text: text.slice(t.bodyStart, t.bodyEnd),
      start: t.start,
      rad: text.slice(0, t.start).split('\n').length,
    }))
}

// ── kanariefåglarna ─────────────────────────────────────────────────────────

/**
 * ── REGELN FÖR DEN HÄR FUNKTIONEN ───────────────────────────────────────────
 *
 * Varje prov här måste FÄLLA när det läge det bevakar neutraliseras. Ett prov
 * som är grönt även med sitt läge avstängt är pynt, och pyntet är farligare än
 * inget prov alls: varje vakt i kodbasen kör den här funktionen och tror att
 * grönt betyder att skannern fungerar.
 *
 * ── VARFÖR REGELN SKREVS ────────────────────────────────────────────────────
 *
 * Den togs inte fram genom läsning. `apps/api/scripts/check-source-scan-canaries.mjs`
 * neutraliserar ett läge i taget och kräver rött. Första mätningen mot den här
 * filen, på main `4dfefbc`:
 *
 *     lägen som slapp igenom oupptäckt:  7 av 12
 *
 * Bland dem REGEX-läget. `REGEX_LÄGE = /QQ_ALDRIG/` — alltså regex-igenkänningen
 * helt avstängd, exakt defekt 1 ovan återinförd — lämnade alla sju
 * kanariefåglarna GRÖNA, medan 14 854 tecken i apps/api/src slutade maskeras och
 * stod kvar som om de vore kod.
 *
 * Provet som skulle fånga det var:
 *
 *     const src = `a.replace(/"/g, '&quot;')\nconst ZZTRÄFF = 1\n`
 *     kräv(…, codeMask(src).includes('ZZTRÄFF'))
 *
 * `ZZTRÄFF` stod på NÄSTA RAD. Med regex-läget avstängt blir `"` en oterminerad
 * sträng som bryts vid radslutet — så nästa rad överlevde, och provet var grönt
 * av sin egen FORMATERING i stället för av det det mätte. Andra halvan,
 * `!m.includes('/"/')`, var grön av samma skäl: tecknet den letade efter råkade
 * hamna i den oterminerade strängens kropp.
 *
 * Därför står sonderna nedan på SAMMA RAD som det som ska överleva.
 *
 * ── HUR DU LÄGGER TILL ETT PROV ─────────────────────────────────────────────
 *
 * Lägg till läget i mutationslistan i check-source-scan-canaries.mjs SAMTIDIGT.
 * Den vakten kräver att varje läge den känner blir rött — ett prov utan mutation
 * är obevisat, och en mutation utan prov är rött tills någon skriver provet.
 */

const LÄGESPROV = [
  {
    läge: 'radkommentar',
    prova: (kräv) => {
      const r = withoutComments('// ZZIRAD\nconst ZZEFTER1 = 1')
      kräv('LÄGE radkommentar (kommentaren bort)', !r.includes('ZZIRAD'), JSON.stringify(r))
      kräv('LÄGE radkommentar (koden kvar)', r.includes('ZZEFTER1'), JSON.stringify(r))
    },
  },
  {
    läge: 'blockkommentar',
    prova: (kräv) => {
      const r = withoutComments('/* ZZIBLOCK */ const ZZEFTER2 = 2')
      kräv('LÄGE blockkommentar (kommentaren bort)', !r.includes('ZZIBLOCK'), JSON.stringify(r))
      kräv('LÄGE blockkommentar (koden kvar)', r.includes('ZZEFTER2'), JSON.stringify(r))
    },
  },
  {
    läge: 'sträng',
    prova: (kräv) => {
      const m = codeMask(`const s = 'ZZISTRÄNG'; const ZZEFTER3 = 3`)
      kräv('LÄGE sträng (innehållet maskeras)', !m.includes('ZZISTRÄNG'), JSON.stringify(m))
      kräv('LÄGE sträng (koden efter kvar)', m.includes('ZZEFTER3'), JSON.stringify(m))
    },
  },
  {
    // DET HÄR VAR PROVET SOM VAR PYNT — se huvudkommentaren. `ZZEFTER4` står nu
    // på SAMMA rad som regexen. Stängs regex-läget av läses `"` som en
    // strängstart och äter resten av raden, och provet faller.
    läge: 'regex',
    prova: (kräv) => {
      const m = codeMask(`a.replace(/"/g, '&quot;'); const ZZEFTER4 = 4`)
      kräv('LÄGE regex (koden EFTER på SAMMA rad)', m.includes('ZZEFTER4'),
        `regexen åt resten av raden: ${JSON.stringify(m)}`)
      const b = codeMask('const re = /ZZIREGEX/')
      kräv('LÄGE regex (kroppen maskeras)', !b.includes('ZZIREGEX'),
        `regexkroppen lästes som kod: ${JSON.stringify(b)}`)
    },
  },
  {
    läge: 'mallsträng',
    prova: (kräv) => {
      const m = codeMask('const t = `ZZIMALL`; const ZZEFTER5 = 5')
      kräv('LÄGE mallsträng (innehållet maskeras)', !m.includes('ZZIMALL'), JSON.stringify(m))
      kräv('LÄGE mallsträng (koden efter kvar)', m.includes('ZZEFTER5'), JSON.stringify(m))
    },
  },
  {
    // Utan `\`-hoppet slutar strängen vid det ESCAPADE citattecknet, och nästa
    // `'` öppnar en ny sträng som äter resten av raden.
    läge: 'escape i sträng',
    prova: (kräv) => {
      const m = codeMask("const s = 'a\\'b'; const ZZEFTER6 = 6")
      kräv('LÄGE escape i sträng', m.includes('ZZEFTER6'),
        `den escapade avgränsaren stängde strängen: ${JSON.stringify(m)}`)
    },
  },
  {
    läge: 'escape i mallsträng',
    prova: (kräv) => {
      const m = codeMask("const t = `a\\`b`; const ZZEFTER7 = 7")
      kräv('LÄGE escape i mallsträng', m.includes('ZZEFTER7'),
        `den escapade backticken stängde mallen: ${JSON.stringify(m)}`)
    },
  },
  {
    // SONDEN ÄR MÄTT FRAM, INTE GISSAD. Det uppenbara provet
    //
    //     const t = `${ a ? "}" : b }`; const ZZEFTER = 8
    //
    // DISKRIMINERAR INTE: med naiv klammerräkning slutar uttrycket vid det `}`
    // som står i strängen, men mallSlut letar därefter bara efter nästa
    // backtick — och den ligger på rätt ställe ändå. Masken blir IDENTISK.
    // Det måste alltså stå något EFTER det falska `}` som bara en riktig
    // tokenisering klarar: en backtick inne i en sträng.
    läge: '${}-tokenisering',
    prova: (kräv) => {
      const src = 'const t = `${ a["}"] + \'x`y\' }`; const ZZEFTER8 = 8'
      kräv('LÄGE ${} (ett } i en sträng stänger inte uttrycket)', codeMask(src).includes('ZZEFTER8'),
        `uttrycket slutade vid ett } i en sträng: ${JSON.stringify(codeMask(src))}`)
      // Samma fel sett på ANTALET mallar: en backtick inne i uttrycket som den
      // naiva räkningen tappar blir en ANDRA mall.
      const src2 = 'const t = `${ a["}"] + `inre` }`; const ZZEFTER8B = 8'
      kräv('LÄGE ${} (mallen räknas som EN)', templateLiterals(src2).length === 1,
        `${templateLiterals(src2).length} mallar hittades, väntade 1`)
    },
  },
  {
    läge: 'SQL-radkommentar',
    prova: (kräv) => {
      const r = withoutComments('SELECT 1; -- ZZISQL\nSELECT ZZEFTER9', { dialect: 'sql' })
      kräv('LÄGE SQL-radkommentar (kommentaren bort)', !r.includes('ZZISQL'), JSON.stringify(r))
      kräv('LÄGE SQL-radkommentar (koden kvar)', r.includes('ZZEFTER9'), JSON.stringify(r))
    },
  },
  {
    // CSS har INGEN radkommentar. Mappas den till SQL läses varje custom
    // property — `--ev-brand: …` — som en kommentar och resten av raden blankas.
    // Uppmätt: den mappningen gjorde design-token-vaktens allowlist-post för
    // TenantAiChat.module.css stale (8 träffar → 0) och fällde självtestet.
    läge: 'CSS-dialekt',
    prova: (kräv) => {
      const src = ':root { --ev-brand: #1a6b3c; }'
      kräv('LÄGE CSS (-- är inte en kommentar)',
        blankComments(src, { dialect: 'css' }).includes('#1a6b3c'),
        `custom property blankades: ${JSON.stringify(blankComments(src, { dialect: 'css' }))}`)
    },
  },
  {
    läge: 'removeImports',
    prova: (kräv) => {
      const src = "const p = `\nimport x from 'y'\n`\nimport a from 'b'\nconst ZZEFTER10 = 10\n"
      const r = removeImports(src)
      kräv('LÄGE removeImports (import i mallsträng bevaras)', r.includes("import x from 'y'"))
      kräv('LÄGE removeImports (riktig import tas bort)', !r.includes("import a from 'b'"))
      kräv('LÄGE removeImports (koden efter finns kvar)', r.includes('ZZEFTER10'))
    },
  },
]

/**
 * Lägena som har ett prov. HÄRLEDD ur listan, aldrig skriven som ett tal i
 * prosan — ett tal i en kommentar blir fel första gången någon lägger till ett
 * läge. `check-source-scan-canaries.mjs` kräver paritet mot sin mutationslista.
 */
export const KANARIEFÅGEL_LÄGEN = LÄGESPROV.map((p) => p.läge)

export function kanariefåglar() {
  const fel = []
  const kräv = (namn, villkor, detalj) => { if (!villkor) fel.push(`${namn}${detalj ? ` — ${detalj}` : ''}`) }

  for (const p of LÄGESPROV) p.prova(kräv)

  // ── DEL 2: DE TRE INCIDENTERNA ──────────────────────────────────────────
  //
  // Lägesproven ovan är uttömmande per MEKANISM. De här tre är uttömmande per
  // HISTORIA: de exakta formerna som en gång lurade oss, bevarade så att en
  // omskrivning av tokeniseraren inte kan återinföra dem i ny dräkt.

  // 1. PDF-vaktens skanner läste `"` i `.replace(/"/g, …)` som en strängstart
  //    och blankade 11 629 tecken av platform-invoices.service.ts.
  {
    const src = `const esc = s.replace(/"/g, '&quot;'); await prisma.$transaction(async () => { ZZINCIDENT1 })`
    kräv('INCIDENT 1 (regex med citattecken dolde koden efter)',
      codeMask(src).includes('ZZINCIDENT1'), JSON.stringify(codeMask(src)))
  }

  // 2. Fyra vakter strippade radkommentarer med en naken regex: ett `'https://x'`
  //    i en literal åt resten av raden.
  {
    const src = `const u = 'https://x'; const ZZINCIDENT2 = 2`
    kräv('INCIDENT 2 (// i sträng åt resten av raden)',
      withoutComments(src).includes('ZZINCIDENT2'), JSON.stringify(withoutComments(src)))
    kräv('INCIDENT 2 (strängen är intakt)', withoutComments(src).includes("'https://x'"))
  }

  // 3. En mätsond utan regex-hantering desynkade på accounting.service.ts och
  //    rapporterade 36 filer i stället för 30. Mallar med nästlade citat.
  {
    const src = 'const t = `text ${a ? "b" : \'c\'} mer`; const ZZINCIDENT3 = 3'
    const lits = templateLiterals(src)
    kräv('INCIDENT 3 (mall med nästlade citat räknas som EN)', lits.length === 1,
      `${lits.length} mallar hittades, väntade 1`)
    kräv('INCIDENT 3 (mallen sluter rätt)', lits[0]?.text === 'text ${a ? "b" : \'c\'} mer',
      JSON.stringify(lits[0]?.text))
    kräv('INCIDENT 3 (koden efter mallen finns kvar)', codeMask(src).includes('ZZINCIDENT3'))
  }

  // ── DEL 3: HELHETEN ─────────────────────────────────────────────────────
  //
  // Att varje läge fungerar var för sig räcker inte: en riktig överträdelse
  // måste fortfarande synas EFTER att alla lurmönster passerat, och
  // förbehandlingen måste faktiskt göra något.
  {
    const src = [
      `a.replace(/"/g, '&quot;')`,
      `const u = 'https://x'`,
      'const t = `${a ? "b" : \'c\'}`',
      `await prisma.$transaction(async () => { ZZÖVERTRÄDELSE })`,
    ].join('\n')
    kräv('HELHET (överträdelsen syns efter alla lurmönster)',
      codeMask(src).includes('ZZÖVERTRÄDELSE') && withoutComments(src).includes('ZZÖVERTRÄDELSE'),
      'överträdelsen blev osynlig efter förbehandlingen')
    kräv('HELHET (förbehandlingen är inte en no-op)',
      !withoutComments(`${src}\n// ZZKOMMENTAR`).includes('ZZKOMMENTAR'),
      'kommentaren överlevde — skannern gör ingenting')
  }

  return fel
}

if (process.argv[1]?.endsWith('source-scan.mjs')) {
  const fel = kanariefåglar()
  if (fel.length) { console.error('KÄLLSKANNERN ÄR TRASIG:\n  ' + fel.join('\n  ')); process.exit(1) }
  // Talet HÄRLEDS, aldrig skrivet i prosan: en siffra i en utskrift glider ifrån
  // koden första gången någon lägger till ett prov.
  console.warn(`Källskannern: alla kanariefåglar gröna (${KANARIEFÅGEL_LÄGEN.length} lägen bevakade).`)
}
