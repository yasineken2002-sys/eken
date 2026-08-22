#!/usr/bin/env node
/**
 * Ingen vakt får skriva sin egen förbehandlare.
 *
 * ── VARFÖR ──────────────────────────────────────────────────────────────────
 *
 * Tre varianter av samma defekt mättes på en dag, av tre olika händer: en
 * skanner som läste `"` i `.replace(/"/g, …)` som strängstart och blankade
 * 11 629 tecken; fyra vakter som strippade kommentarer utan strängkännedom; en
 * mätsond som desynkade och rapporterade 36 filer i stället för 30.
 *
 * Tre gånger är inte slarv — det är att var och en skriver sin egen. Den här
 * vakten gör den delade skannern (scripts/lib/source-scan.mjs) till den enda,
 * och den härleder mängden UR KODEN: varje skript som bär en förbehandlingsform
 * fälls, oavsett om någon kom ihåg att lägga till det i en lista.
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { blankRegions, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const KATALOGER = ['apps/api/scripts', 'scripts']
const DELAD = 'scripts/lib/source-scan.mjs'

/**
 * Handrullad förbehandling. Formen, inte ett filnamn — en ny vakt som skriver
 * sin egen fälls utan att någon behöver kvittera den.
 */
const FÖRBJUDNA_FORMER = [
  [/\.replace\(\s*\/\\\/\\\*/, 'blockkommentar-strippning med en naken regex'],
  [/\.replace\(\s*\/\\\/\\\//, 'radkommentar-strippning med en naken regex'],
  [/\.replace\(\s*\/--/, 'SQL-radkommentar-strippning med en naken regex'],
  [/\.indexOf\(\s*['"]\*\/['"]\s*\)/, 'handrullad blockkommentar-sökning'],
  [/\.replace\(\s*\/\^import\\s/, 'handrullad import-strippning'],
]

export function evaluate(filer) {
  const fel = []
  const konsumenter = []
  let former = 0

  for (const abs of filer) {
    const rel = relative(ROT, abs).replaceAll('\\', '/')
    if (rel === DELAD) continue
    const text = readFileSync(abs, 'utf8')
    // R1 läser koden med STRÄNGINNEHÅLL blankat men REGEX-LITERALER intakta.
    // Skälet är mätt: självtestets egna provsträngar ("x.replace(/\\/\\*…")
    // fällde vakten om sin egen kanariefågel. Regexkropparna måste stå kvar —
    // det är just dem R1 känner igen.
    const kod = blankRegions(text, ['string', 'template'], { del: 'body' })

    // R1 — ingen egen förbehandlare.
    for (const [re, vad] of FÖRBJUDNA_FORMER) {
      if (re.test(kod)) {
        former++
        const rad = kod.slice(0, kod.search(re)).split('\n').length
        fel.push(
          `R1 ${rel}:${rad} — ${vad}. Använd scripts/lib/source-scan.mjs. ` +
            'En naken regex kan inte strängar: ett `//` i en literal äter resten av raden, ' +
            'och ett `"` i en regex-literal blankar allt fram till nästa citattecken.',
        )
      }
    }

    // R2 — den som använder den delade ska köra dess kanariefåglar i sitt
    // självtest. Bryts skannern blir VARJE konsument röd, inte bara en spec.
    if (!text.includes('source-scan.mjs')) continue
    konsumenter.push(rel)
    const harSjälvtest = /--self-test/.test(text)
    if (harSjälvtest && !/kanariefåglar\(\)/.test(text)) {
      fel.push(
        `R2 ${rel} — använder den delade skannern men kör inte dess kanariefåglar i sitt ` +
          'självtest. Går skannern sönder ska den här vakten bli röd, inte tyst fortsätta mäta fel.',
      )
    }
  }

  // R3 — den delade skannern klarar de mönster som bevisligen lurat oss.
  for (const f of kanariefåglar()) fel.push(`R3 delad skanner: ${f}`)

  if (konsumenter.length === 0) {
    fel.push('R2 — ingen vakt använder den delade skannern. Vakten mäter ingenting.')
  }

  return { fel, mätt: { skript: filer.length, konsumenter: konsumenter.length, förbjudnaFormer: former } }
}

function allaSkript() {
  const ut = []
  for (const kat of KATALOGER) {
    const bas = join(ROT, kat)
    const stack = [bas]
    while (stack.length) {
      const d = stack.pop()
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) stack.push(p)
        else if (n.endsWith('.mjs')) ut.push(p)
      }
    }
  }
  return ut
}

function självtest() {
  const fel = []
  const bas = evaluate(allaSkript())
  if (bas.fel.length) fel.push(`baslinjen är inte grön:\n    ${bas.fel.join('\n    ')}`)

  // KANARIE A — R1 fäller varje form. Töms FÖRBJUDNA_FORMER, eller trasigas en
  // regex, blir vakten grön för allt — det tysta läget.
  const prov = [
    ["x.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')", 'blockkommentar-strippning med en naken regex'],
    ["x.replace(/\\/\\/[^\\n]*/g, '')", 'radkommentar-strippning med en naken regex'],
    ["x.replace(/--[^\\n]*/g, ' ')", 'SQL-radkommentar-strippning med en naken regex'],
    ["t.indexOf('*/')", 'handrullad blockkommentar-sökning'],
    ["x.replace(/^import\\s+[\\s\\S]*?from/gm, '')", 'handrullad import-strippning'],
  ]
  for (const [kod, vad] of prov) {
    if (!FÖRBJUDNA_FORMER.some(([re, v]) => v === vad && re.test(kod))) {
      fel.push(`KANARIE A: formen "${vad}" fälls inte av sitt eget mönster (prov: ${kod})`)
    }
  }

  // KANARIE B — den delade skannern ANVÄNDS av mer än en vakt. Ett fynd på
  // noll konsumenter vore grönt utan att betyda något.
  if (bas.mätt.konsumenter < 4) {
    fel.push(`KANARIE B: bara ${bas.mätt.konsumenter} vakter använder den delade skannern — förväntat minst 4.`)
  }

  // KANARIE C — R3 vidarebefordrar den delade skannerns egna fel. Går den
  // sönder ska DEN HÄR vakten falla, inte bara source-scan.mjs egen körning.
  const antal = kanariefåglar().length
  if (antal !== 0) fel.push(`KANARIE C: den delade skannern rapporterar ${antal} fel redan i baslinjen.`)

  if (fel.length) { console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  ')); process.exit(1) }
  console.warn(
    `SJÄLVTEST GRÖNT — ${bas.mätt.skript} skript granskade, ${bas.mätt.konsumenter} använder den ` +
      'delade skannern, 5 förbjudna former + 7 skanner-kanariefåglar prövade.',
  )
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-guard-preprocessors.mjs') ?? false
if (!KÖRS_DIREKT) {
  // importerad — kör ingenting
} else if (process.argv.includes('--self-test')) självtest()
else {
  const { fel, mätt } = evaluate(allaSkript())
  if (fel.length) { console.error('Handrullad förbehandling i en vakt:\n  ' + fel.join('\n  ')); process.exit(1) }
  console.warn(
    `Förbehandling är delad — ${mätt.skript} skript granskade, ${mätt.konsumenter} använder ` +
      'scripts/lib/source-scan.mjs, 0 egna förbehandlare.',
  )
}
