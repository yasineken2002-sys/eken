/**
 * VAKT (#476): R2:s Content-Type SKA HÄRLEDAS UR BYTENA, ALDRIG UR KLIENTEN.
 *
 * Tredje argumentet till `storage.uploadFile(buffer, key, mimeType)` blir
 * objektets `Content-Type` i R2. Presignerade URL:er sätter ingen
 * `Content-Disposition`, så det fältet avgör vad webbläsaren GÖR med filen när
 * någon öppnar länken.
 *
 * Kommer värdet ur klientens multipart-header kan en uppladdare bestämma det.
 * Kontraktsbatchen hade ingen allowlist alls på den deklarerade typen: en äkta
 * PDF — som passerar magic-byte-kontrollen — kunde deklareras `text/html` och
 * lagras med den Content-Type:n.
 *
 * ── VAD VAKTEN GÖR ─────────────────────────────────────────────────────────
 *
 * Den läser varje `uploadFile(...)`-anrop i `apps/api/src` och kräver att
 * Content-Type-argumentet är EN AV TVÅ SORTER:
 *
 *   1. en strängliteral — servergenererat innehåll (`'application/pdf'` för en
 *      PDF vi själva just renderat), eller
 *   2. ett uttryck som i samma fil härleds ur `validateUploadedFile` /
 *      `detectMimeFromMagicBytes`.
 *
 * Allt annat fälls med fil, rad och uttryck. En ny uppladdningsväg som skickar
 * `part.mimetype` vidare blir alltså röd utan att någon behöver komma ihåg att
 * lägga till den i en lista.
 *
 * ── VARFÖR MEKANISKT OCH INTE EN NAMNGIVEN KONTROLL PER VÄG ────────────────
 *
 * En kontroll som räknar upp dagens vägar skyddar mot återfall i just dem och
 * märker aldrig att en tolfte väg föds. Det är samma skäl som står i CLAUDE.md
 * om vakter som går blinda: uppräkningen slutar spegla det den räknar upp.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

/** Namn som bevisligen bär en DETEKTERAD typ i den fil de används. */
const HÄRLEDER_TYP = /validateUploadedFile\s*\(|detectMimeFromMagicBytes\s*\(/

function tsFiles(dir: string): string[] {
  const ut: string[] = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) {
      if (namn === 'generated' || namn === 'node_modules') continue
      ut.push(...tsFiles(full))
    } else if (namn.endsWith('.ts') && !namn.endsWith('.spec.ts')) {
      ut.push(full)
    }
  }
  return ut
}

/** Tredje argumentet i varje `uploadFile(...)`, med radnummer. */
export function contentTypeArgs(källa: string): Array<{ arg: string; rad: number }> {
  const ut: Array<{ arg: string; rad: number }> = []
  const start = /\buploadFile\s*\(/g
  let m: RegExpExecArray | null
  while ((m = start.exec(källa)) !== null) {
    let i = m.index + m[0].length
    let djup = 1
    const från = i
    while (i < källa.length && djup > 0) {
      const c = källa[i]
      if (c === '(') djup++
      else if (c === ')') djup--
      else if (c === '[' || c === '{') djup++
      else if (c === ']' || c === '}') djup--
      i++
    }
    const kropp = källa.slice(från, i - 1)
    // Dela på toppnivå-komman (hoppa över komman inne i uttryck).
    const delar: string[] = []
    let nivå = 0
    let buf = ''
    for (const c of kropp) {
      if ('([{'.includes(c)) nivå++
      if (')]}'.includes(c)) nivå--
      if (c === ',' && nivå === 0) {
        delar.push(buf)
        buf = ''
      } else buf += c
    }
    delar.push(buf)
    // Hoppa över SIGNATUREN (`async uploadFile(buffer: Buffer, key: string,
    // mimeType: string)`) — den är inte ett anrop. Typannoteringar finns bara
    // där.
    const harTypannotering = delar.some((d) => /:\s*(string|Buffer)\b/.test(d))
    if (delar.length >= 3 && !harTypannotering) {
      ut.push({
        arg: delar[2]!.trim(),
        rad: källa.slice(0, m.index).split('\n').length,
      })
    }
  }
  return ut
}

const ÄR_LITERAL = /^(['"`])[^'"`]*\1$/
/** Fastify-multipartens klientstyrda fält. Aldrig godtagbart som Content-Type. */
const KLIENTFÄLT = /\.mimetype\b/

/**
 * Slår upp `const <namn> = <uttryck>` i samma fil, ett steg.
 *
 * Utan det ser vakten bara identifieraren `mimeType` och kan varken frikänna
 * ett servertypat värde eller fälla ett klientstyrt. Ett steg räcker för
 * kodbasens faktiska mönster och undviker att bygga en halv typkontroll.
 */
export function resolveraEttSteg(arg: string, källa: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return arg
  const m = new RegExp(`\\bconst\\s+${arg}\\s*=\\s*([^\\n]+)`).exec(källa)
  return m ? m[1]!.replace(/;\s*$/, '').trim() : arg
}

describe('vakt: uppladdning litar inte på klientens Content-Type', () => {
  const filer = tsFiles(SRC)

  it('hittar faktiskt uploadFile-anrop att granska', () => {
    const antal = filer.reduce((n, f) => n + contentTypeArgs(readFileSync(f, 'utf8')).length, 0)
    // Golv, inte exakt tal — mängden ska få växa utan att vakten faller.
    expect(antal).toBeGreaterThanOrEqual(10)
  })

  it('varje Content-Type är en literal, härledd ur bytena, eller servertypad', () => {
    const träffar: string[] = []
    for (const fil of filer) {
      const källa = readFileSync(fil, 'utf8')
      const härleder = HÄRLEDER_TYP.test(källa)
      for (const { arg, rad } of contentTypeArgs(källa)) {
        const uttryck = resolveraEttSteg(arg, källa)
        // Hård spärr först: klientens multipart-fält får aldrig hit, oavsett
        // vad annat i uttrycket ser betryggande ut.
        if (KLIENTFÄLT.test(uttryck)) {
          träffar.push(`${fil.replace(SRC, 'src')}:${rad} → ${arg} (klientfält)`)
          continue
        }
        if (ÄR_LITERAL.test(uttryck)) continue
        if (härleder) continue
        // Servertypat med literal fallback, t.ex. `input.mimeType ?? 'application/pdf'`
        // — parametern sätts av en intern anropare, aldrig av en multipart-header.
        if (/\?\?\s*(['"`])[^'"`]*\1\s*$/.test(uttryck)) continue
        träffar.push(`${fil.replace(SRC, 'src')}:${rad} → ${arg} (okänt ursprung)`)
      }
    }
    expect(träffar).toEqual([])
  })

  it('ingen uppladdningsväg skickar klientens multipart-mimetype vidare', () => {
    const träffar: string[] = []
    for (const fil of filer) {
      for (const { arg, rad } of contentTypeArgs(readFileSync(fil, 'utf8'))) {
        // `part.mimetype` / `file.mimetype` är Fastify-multipartens klientfält.
        if (/\.mimetype\b/.test(arg)) träffar.push(`${fil.replace(SRC, 'src')}:${rad} → ${arg}`)
      }
    }
    expect(träffar).toEqual([])
  })

  it('kanariefågel: uppslagningen frikänner servertypat och fäller klientstyrt', () => {
    const server = "const mimeType = input.mimeType ?? 'application/pdf'"
    expect(resolveraEttSteg('mimeType', server)).toBe("input.mimeType ?? 'application/pdf'")
    expect(KLIENTFÄLT.test(resolveraEttSteg('mimeType', server))).toBe(false)

    const klient = 'const mimeType = file.mimetype'
    expect(KLIENTFÄLT.test(resolveraEttSteg('mimeType', klient))).toBe(true)
  })

  it('kanariefågel: uttunnaren och reglerna träffar det de ska', () => {
    const farlig = 'await this.storage.uploadFile(file.buffer, storageKey, file.mimetype)'
    const funna = contentTypeArgs(farlig)
    expect(funna).toHaveLength(1)
    expect(funna[0]!.arg).toBe('file.mimetype')
    expect(ÄR_LITERAL.test(funna[0]!.arg)).toBe(false)

    // En literal ska INTE fällas — annars blir vakten obrukbar för
    // servergenererade PDF:er.
    expect(ÄR_LITERAL.test(contentTypeArgs("uploadFile(b, k, 'application/pdf')")[0]!.arg)).toBe(
      true,
    )

    // Uttunnaren får inte kapa på ett komma inuti ett uttryck.
    const nästlat = "uploadFile(buf, `documents/${a}/${b}`, detected ?? 'image/png')"
    const n = contentTypeArgs(nästlat)
    expect(n).toHaveLength(1)
    expect(n[0]!.arg).toBe("detected ?? 'image/png'")
  })
})
