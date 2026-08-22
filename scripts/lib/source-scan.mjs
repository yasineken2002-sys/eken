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
 * De TRE mönster som bevisligen har lurat oss, plus kravet att en riktig
 * överträdelse efter dem fortfarande syns. Exporterad så varje vakt kan köra
 * den i sitt eget självtest — bryts skannern blir ALLA röda, inte bara en.
 */
export function kanariefåglar() {
  const fel = []
  const kräv = (namn, villkor, detalj) => { if (!villkor) fel.push(`${namn}${detalj ? ` — ${detalj}` : ''}`) }

  // 1. Regex-literal med citattecken. Defekten som blankade 11 629 tecken.
  {
    const src = `a.replace(/"/g, '&quot;')\nconst ZZTRÄFF = 1\n`
    const m = codeMask(src)
    kräv('KANARIE 1 (regex med citattecken)', m.includes('ZZTRÄFF'),
      `koden efter regex-literalen försvann: ${JSON.stringify(m.slice(0, 60))}`)
    kräv('KANARIE 1 (regexinnehållet maskeras)', !m.includes('/"/'), 'regexkroppen står kvar omaskerad')
  }

  // 2. `//` inuti en sträng. Får INTE äta resten av raden.
  {
    const src = `const u = 'https://x'; const ZZTRÄFF = 2\n`
    kräv('KANARIE 2 (// i sträng)', withoutComments(src).includes('ZZTRÄFF'),
      `resten av raden åts: ${JSON.stringify(withoutComments(src))}`)
    kräv('KANARIE 2 (strängen är intakt)', withoutComments(src).includes("'https://x'"))
  }

  // 3. Mallsträng med nästlade citat i ett `${}`-uttryck.
  {
    const src = 'const t = `text ${a ? "b" : \'c\'} mer`; const ZZTRÄFF = 3\n'
    const lits = templateLiterals(src)
    kräv('KANARIE 3 (mall med nästlade citat)', lits.length === 1, `${lits.length} mallar hittades, väntade 1`)
    kräv('KANARIE 3 (mallen sluter rätt)', lits[0]?.text === 'text ${a ? "b" : \'c\'} mer',
      JSON.stringify(lits[0]?.text))
    kräv('KANARIE 3 (koden efter mallen finns kvar)', codeMask(src).includes('ZZTRÄFF'))
  }

  // 4. En fil som SKA ge utslag måste ge utslag EFTER förbehandlingen. Utan
  //    det här mäter vi bara att skannern inte kraschar.
  {
    const src = [
      `a.replace(/"/g, '&quot;')`,
      `const u = 'https://x'`,
      'const t = `${a ? "b" : \'c\'}`',
      `await prisma.$transaction(async () => { ZZÖVERTRÄDELSE })`,
    ].join('\n')
    kräv('KANARIE 4 (överträdelse efter alla tre lurmönstren)',
      codeMask(src).includes('ZZÖVERTRÄDELSE') && withoutComments(src).includes('ZZÖVERTRÄDELSE'),
      'överträdelsen blev osynlig efter förbehandlingen')
    // …och att förbehandlingen faktiskt GÖR något: en kommentar ska bort.
    kräv('KANARIE 4 (förbehandlingen är inte en no-op)',
      !withoutComments(`${src}\n// ZZKOMMENTAR`).includes('ZZKOMMENTAR'),
      'kommentaren överlevde — skannern gör ingenting')
  }

  // 6. CSS-dialekten har INGEN radkommentar. Mappas den till SQL läses varje
  //    custom property `--ev-…` som en kommentar och resten av raden blankas.
  //    Uppmätt: den mappningen gjorde design-token-vaktens allowlist stale
  //    (8 träffar → 0) och fällde dess självtest.
  {
    const src = ':root { --ev-brand: #1a6b3c; }'
    kräv('KANARIE 6 (CSS: -- är inte en kommentar)',
      blankComments(src, { dialect: 'css' }).includes('#1a6b3c'),
      `custom property blankades: ${JSON.stringify(blankComments(src, { dialect: 'css' }))}`)
  }

  // 7. removeImports rör inte en import-liknande rad inuti en mallsträng.
  {
    const src = "const p = `\nimport x from 'y'\n`\nimport a from 'b'\nconst ZZTRÄFF = 7\n"
    const r = removeImports(src)
    kräv('KANARIE 7 (import i mallsträng bevaras)', r.includes("import x from 'y'"))
    kräv('KANARIE 7 (riktig import tas bort)', !r.includes("import a from 'b'"))
    kräv('KANARIE 7 (koden efter finns kvar)', r.includes('ZZTRÄFF'))
  }

  // 5. SQL-dialekten: `--` i en sträng är inte en kommentar.
  {
    const src = `INSERT INTO t VALUES ('a--b'); DROP TABLE zz;`
    kräv('KANARIE 5 (SQL: -- i sträng)', withoutComments(src, { dialect: 'sql' }).includes('DROP TABLE zz'))
  }

  return fel
}

if (process.argv[1]?.endsWith('source-scan.mjs')) {
  const fel = kanariefåglar()
  if (fel.length) { console.error('KÄLLSKANNERN ÄR TRASIG:\n  ' + fel.join('\n  ')); process.exit(1) }
  console.warn('Källskannern: 7 kanariefåglar gröna.')
}
