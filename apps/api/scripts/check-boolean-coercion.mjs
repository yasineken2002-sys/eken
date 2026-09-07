#!/usr/bin/env node
/**
 * ETT BOOLESKT DTO-FÄLT UTAN `@IngenKoercion()` KAN LÄSA ETT NEJ SOM ETT JA.
 *
 * ── MEKANIKEN ───────────────────────────────────────────────────────────────
 *
 * Den globala pipen kör `transform: true` med `enableImplicitConversion: true`
 * (`VALIDATION_PIPE_OPTIONS`). class-transformer läser fältets TS-typ och kör
 * `Boolean(värdet)` INNAN någon validator ser något:
 *
 *     "false" → true      "0" → true      "no" → true      "" → false
 *
 * `@IsBoolean()` prövar alltså resultatet av konverteringen, aldrig det
 * klienten skickade. Ett fält som betyder JA/NEJ blir därmed ett fält som bara
 * kan betyda JA — och det är den enda riktning som inte får finnas.
 *
 * ── VARFÖR EN VAKT OCH INTE BARA EN FIX ─────────────────────────────────────
 *
 * Formen har hittats TRE gånger, alla av en mekanism och ingen av läsning:
 *
 *   #830  tenant-ai `confirmed`   — hyresgästens ja till en AI-handling
 *   #835  work-order-fälten       — delning av hyresgästens kontaktuppgift
 *   här   `acceptTerms`           — samtycket till användarvillkoren
 *
 * Tre gånger är ett mönster, inte otur. Paritetsprovet fångar bara fält som
 * står i KONTRAKTSREGISTER; den här vakten läser ALLA `*.dto.ts`.
 *
 * ── VAD VAKTEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att dekoratorn GÖR något. Den mäter att den finns. Att den fungerar — och
 * att dess placering bland fältets övriga dekoratorer saknar betydelse, vilket
 * är uppmätt — ägs av `dto-contract.spec.ts`s koercionshalva och av
 * `no-coercion.decorator.ts`s egen docblock.
 *
 * Den ser heller inte fält vars TS-typ är `boolean` men som saknar
 * `@IsBoolean()` — de valideras inte alls och är ett annat problem.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask } from '../../../scripts/lib/source-scan.mjs'

const ROT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const TRAD = 'apps/api/src'
const BASLINJE = 'apps/api/scripts/boolean-coercion.baseline.json'

/**
 * Booleska fält utan koercionsspärr.
 *
 * FÄLTBLOCK, inte ett framåtfönster. En första version läste framåt från
 * `@IsBoolean()` till fältnamnet och missade därför varje dekorator som stod
 * FÖRE den — den rapporterade fält jag själv nyss skyddat som oskyddade.
 * Blocket är i stället allt mellan föregående fält och det här, vilket fångar
 * dekoratorer i båda riktningarna.
 *
 * Exporterad så kanariefåglarna mäter SAMMA funktion som den skarpa körningen.
 */
export function oskyddadeFalt(rot = ROT) {
  const ut = []
  // `\p{L}`, inte `\w`: ett fältnamn får börja på å/ä/ö. Se CLAUDE.md om \b.
  const FALT = /^[ \t]{2}(?:readonly\s+)?([\p{L}_$][\p{L}\p{N}_$]*)\s*[!?]?\s*:/gmu
  const gaa = (katalog) => {
    for (const namn of readdirSync(katalog)) {
      const p = join(katalog, namn)
      if (statSync(p).isDirectory()) {
        gaa(p)
        continue
      }
      if (!namn.endsWith('.dto.ts')) continue
      const ratext = readFileSync(p, 'utf8')
      if (!ratext.includes('@IsBoolean')) continue
      // KODVYN: frågan är om dekoratorn TILLÄMPAS. En `@IsBoolean` som nämns i
      // en kommentar — den här filens egen docblock gör det — är ingen
      // tillämpning, och en råtextvakt hade varit röd om sin egen dokumentation.
      const kod = codeMask(ratext)
      let forra = 0
      for (const m of kod.matchAll(FALT)) {
        const blk = kod.slice(forra, m.index + m[0].length)
        forra = m.index + m[0].length
        if (!blk.includes('@IsBoolean(')) continue
        if (blk.includes('@IngenKoercion(')) continue
        ut.push({
          fil: relative(rot, p),
          falt: m[1],
          rad: ratext.slice(0, m.index).split('\n').length + 1,
        })
      }
    }
  }
  gaa(join(rot, TRAD))
  return ut.sort((a, b) => `${a.fil}\t${a.falt}`.localeCompare(`${b.fil}\t${b.falt}`))
}

const nyckel = (p) => `${p.fil}\t${p.falt}`

function kanariefåglar() {
  const fel = []
  const bas = mkdtempSync(join(tmpdir(), 'bool-koercion-'))
  mkdirSync(join(bas, TRAD, 'sond'), { recursive: true })
  const lagg = (n, i) => writeFileSync(join(bas, TRAD, 'sond', n), i, 'utf8')

  // 1. POSITIV: ett oskyddat booleskt fält MÅSTE fällas.
  lagg('a.dto.ts', `export class A {\n  @IsBoolean()\n  falt!: boolean\n}\n`)
  // 2. NEGATIV: skyddat FÖRE validatorn.
  lagg('b.dto.ts', `export class B {\n  @IngenKoercion()\n  @IsBoolean()\n  falt!: boolean\n}\n`)
  // 3. NEGATIV — DEN SOM FÅNGAR FRAMÅTFÖNSTRET: skyddat EFTER validatorn.
  //    Uppmätt att ordningen saknar betydelse i runtime; en vakt som bara läser
  //    framåt hade ändå fällt den här, och det var precis felet i sonden som
  //    ledde fram till den här vakten.
  lagg('c.dto.ts', `export class C {\n  @IsBoolean()\n  @Equals(true)\n  @IngenKoercion()\n  falt!: true\n}\n`)
  // 4. NEGATIV: `@IsBoolean` i en KOMMENTAR är ingen tillämpning.
  lagg('d.dto.ts', `export class D {\n  // @IsBoolean() vore fel här\n  falt!: string\n}\n`)
  // 5. NEGATIV: ett fält på å/ä/ö ska hittas som vilket annat som helst —
  //    fälls det inte har namnregexen blivit ASCII-härledd.
  lagg('e.dto.ts', `export class E {\n  @IsBoolean()\n  ärGodkänd!: boolean\n}\n`)

  const funna = oskyddadeFalt(bas)
  const har = (fil, falt) => funna.some((f) => f.fil.endsWith(fil) && f.falt === falt)

  if (!har('a.dto.ts', 'falt')) fel.push('KANARIEFÅGEL 1: ett oskyddat fält fälldes INTE.')
  if (har('b.dto.ts', 'falt')) fel.push('KANARIEFÅGEL 2: skyddat FÖRE validatorn fälldes ändå.')
  if (har('c.dto.ts', 'falt')) {
    fel.push('KANARIEFÅGEL 3: skyddat EFTER validatorn fälldes — vakten läser bara framåt.')
  }
  if (har('d.dto.ts', 'falt')) fel.push('KANARIEFÅGEL 4: @IsBoolean i en KOMMENTAR räknades.')
  if (!har('e.dto.ts', 'ärGodkänd')) {
    fel.push('KANARIEFÅGEL 5: ett fältnamn på å/ä/ö hittades inte — regexen är ASCII-härledd.')
  }
  return fel
}

const skrivLage = process.argv.includes('--skriv')
const baslinjeSokvag = join(ROT, BASLINJE)

const kanarieFel = kanariefåglar()
if (kanarieFel.length) {
  console.error('❌ Boolesk koercion: vaktens egna kanariefåglar föll\n')
  for (const f of kanarieFel) console.error(`  ${f}`)
  console.error('\nEn vakt som inte kan fälla mäter ingenting. Laga vakten, inte baslinjen.')
  process.exit(1)
}

function selfTest() {
  const fel = [...kanariefåglar()]
  const b = JSON.parse(readFileSync(baslinjeSokvag, 'utf8'))
  if (b.total !== b.poster.length) {
    fel.push(`baslinjens total (${b.total}) är inte härledd ur poster (${b.poster.length})`)
  }
  if (fel.length) {
    console.error('❌ Boolesk koercion, självtestet föll\n')
    for (const f of fel) console.error(`  ${f}`)
    process.exit(1)
  }
  console.warn('✅ Boolesk koercion, självtest: 6 sonder gröna')
  console.warn('   1 POSITIV  ett oskyddat booleskt fält fälls')
  console.warn('   2 NEGATIV  skyddat FÖRE validatorn fälls inte')
  console.warn('   3 NEGATIV  skyddat EFTER validatorn fälls inte (framåtfönstret)')
  console.warn('   4 NEGATIV  @IsBoolean i en kommentar är ingen tillämpning')
  console.warn('   5 NEGATIV  ett fältnamn på å/ä/ö hittas')
  console.warn(`   6 baslinjens total (${b.total}) är härledd ur poster`)
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

if (skrivLage) {
  const poster = oskyddadeFalt().map((p) => ({ fil: p.fil, falt: p.falt }))
  writeFileSync(baslinjeSokvag, `${JSON.stringify({ total: poster.length, poster }, null, 2)}\n`, 'utf8')
  console.warn(`✅ Baslinjen skriven: ${poster.length} oskyddade booleska fält.`)
  process.exit(0)
}

let baslinje = { total: 0, poster: [] }
try {
  baslinje = JSON.parse(readFileSync(baslinjeSokvag, 'utf8'))
} catch {
  console.error(`❌ Boolesk koercion: baslinjen saknas (${BASLINJE}).`)
  process.exit(1)
}
if (baslinje.total !== baslinje.poster.length) {
  console.error(
    `❌ Boolesk koercion: baslinjens total (${baslinje.total}) stämmer inte med ` +
      `antalet poster (${baslinje.poster.length}).`,
  )
  process.exit(1)
}

const funna = oskyddadeFalt()
const kanda = new Set(baslinje.poster.map(nyckel))
const nu = new Set(funna.map(nyckel))
const nya = funna.filter((p) => !kanda.has(nyckel(p)))
const stale = baslinje.poster.filter((p) => !nu.has(nyckel(p)))

if (nya.length || stale.length) {
  console.error('❌ Boolesk koercion: ett booleskt fält kan läsa ett NEJ som ett JA\n')
  for (const p of nya) {
    console.error(
      `  NY ${p.fil}:${p.rad} — fältet ${p.falt} saknar @IngenKoercion(). Pipen kör ` +
        `Boolean(värdet) före validatorn, så strängen "false" blir true. Lägg till ` +
        `dekoratorn från common/contract/no-coercion.decorator.`,
    )
  }
  for (const p of stale) {
    console.error(
      `  STALE ${p.fil} — ${p.falt} står i baslinjen men är skyddat nu. ` +
        'Ta bort raden ur boolean-coercion.baseline.json i SAMMA PR.',
    )
  }
  console.error('\nRegeln: baslinjen får bara KRYMPA.')
  process.exit(1)
}

console.warn(`✅ Boolesk koercion: ${funna.length} kända oskyddade fält, inga nya och inga stale.`)
console.warn(
  '   Vakten mäter att dekoratorn FINNS — inte att den gör något. Det ägs av ' +
    'dto-contract.spec.ts:s koercionshalva.',
)
