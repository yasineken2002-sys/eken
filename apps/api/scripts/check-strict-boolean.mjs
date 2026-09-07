#!/usr/bin/env node
/**
 * VARJE BOOLESKT DTO-FÄLT SKA BÄRA `@StrictBoolean()`.
 *
 * ── MEKANIKEN ───────────────────────────────────────────────────────────────
 *
 * Den globala pipen kör `enableImplicitConversion`, så class-transformer kör
 * `Boolean(värdet)` INNAN validatorn ser något. `Boolean('false')` är `true`.
 * Ett fält som betyder JA/NEJ blir ett fält som bara kan betyda JA.
 *
 * Uppmätt mot `ConfirmActionDto` före lagningen — hyresvärdens ja till en
 * AI-föreslagen handling:
 *
 *     "false" → true    "yes" → true    "0" → true    1 → true
 *
 * ── VARFÖR DEN HÄR VAKTEN ERSÄTTER `check-boolean-coercion.mjs` ─────────────
 *
 * Företrädaren mätte fel i BÅDA riktningar, och det upptäcktes först när
 * mängden räknades om med en riktig fältparser:
 *
 *     baslinjen påstod    18 oskyddade
 *     verkligheten        37 oskyddade av 49 booleska fält
 *
 * Orsaken var att företrädaren delade filen i "block mellan fältnamn" med en
 * radankrad regex (`^  namn:`). Enradsformen
 *
 *     @IsBoolean() @IsOptional() sublettingAllowed?: boolean
 *
 * matchar inte den ankringen, så fältet MISSADES — och dess `@IsBoolean()`
 * tillskrevs nästa flerradsfält, som därför rapporterades som booleskt fast det
 * var en strängunion (`petsAllowed`, `indexClauseType`, `category`). Fem falska
 * positiva, tjugofyra falska negativa.
 *
 * Den här läser fältdeklarationer på KLASSNIVÅ med en djupräknare, vilket
 * hanterar båda formerna och utesluter `nyckel:` inne i objektliteraler
 * (`@ApiProperty({ example: … })`).
 *
 * ── VAD VAKTEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att dekoratorn GÖR något. Den mäter att den finns. Beteendet — `"false"` blir
 * `false`, `"yes"` blir 400 — ägs av `strict-boolean.spec.ts`, som kör den
 * riktiga pipen och har en kanariefågel som visar att koercionen finns utan
 * dekoratorn.
 *
 * Den ser heller inte fält vars TS-typ är `boolean` men som saknar validator
 * helt — de valideras inte alls, vilket är ett annat problem.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask } from '../../../scripts/lib/source-scan.mjs'

const ROT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const TRAD = 'apps/api/src'

/**
 * Fältdeklarationer på klassnivå. Exporterad så kanariefåglarna mäter SAMMA
 * funktion som den skarpa körningen — en sond som skriver om parsern mäter sin
 * egen rad och kan inte falla när vakten ändras.
 */
export function faltIFil(kalla) {
  const kod = codeMask(kalla)
  const ut = []
  // `\p{L}`, inte `\w`: ett fältnamn får börja på å/ä/ö. Se CLAUDE.md om \b.
  const FALT = /([\p{L}_$][\p{L}\p{N}_$]*)\s*[!?]?\s*:/gu
  const KLASS = /(?:^|[\n;}])\s*(?:export\s+)?(?:abstract\s+)?class\s+[\p{L}\p{N}_$]+[^{]*\{/gu
  for (const km of kod.matchAll(KLASS)) {
    const start = kod.indexOf('{', km.index + km[0].length - 1)
    let d = 0
    let slut = -1
    for (let i = start; i < kod.length; i += 1) {
      if ('{(['.includes(kod[i])) d += 1
      else if ('})]'.includes(kod[i])) {
        d -= 1
        if (d === 0) {
          slut = i
          break
        }
      }
    }
    if (slut < 0) continue
    const kropp = kod.slice(start + 1, slut)
    let forra = 0
    for (const m of kropp.matchAll(FALT)) {
      let d2 = 0
      for (let i = 0; i < m.index; i += 1) {
        if ('{(['.includes(kropp[i])) d2 += 1
        else if ('})]'.includes(kropp[i])) d2 -= 1
      }
      // Djup 0 = klassnivå. Utesluter `example:` inne i @ApiProperty({ … }).
      if (d2 !== 0) continue
      const dekoratorer = kropp.slice(forra, m.index)
      const efter = /^[^\n;]*/.exec(kropp.slice(m.index + m[0].length))?.[0] ?? ''
      forra = m.index + m[0].length + efter.length
      ut.push({
        falt: m[1],
        typ: efter.trim().replace(/,$/, ''),
        dekoratorer,
        rad: kalla.slice(0, start + 1 + m.index).split('\n').length,
      })
    }
  }
  return ut
}

/** Booleska fält utan `@StrictBoolean()`. */
export function oskyddade(rot = ROT) {
  const ut = []
  const gaa = (katalog) => {
    for (const namn of readdirSync(katalog)) {
      const p = join(katalog, namn)
      if (statSync(p).isDirectory()) {
        gaa(p)
        continue
      }
      if (!namn.endsWith('.dto.ts')) continue
      const kalla = readFileSync(p, 'utf8')
      for (const f of faltIFil(kalla)) {
        const harBool = /@IsBoolean\s*\(/.test(f.dekoratorer)
        const boolTyp = /^(boolean|true|false)$/.test(f.typ)
        if (!harBool && !boolTyp) continue
        if (/@StrictBoolean\s*\(/.test(f.dekoratorer)) continue
        ut.push({ fil: relative(rot, p), falt: f.falt, rad: f.rad })
      }
    }
  }
  gaa(join(rot, TRAD))
  return ut.sort((a, b) => `${a.fil}\t${a.falt}`.localeCompare(`${b.fil}\t${b.falt}`))
}

function kanariefåglar() {
  const fel = []
  const bas = mkdtempSync(join(tmpdir(), 'strict-bool-'))
  mkdirSync(join(bas, TRAD, 'sond'), { recursive: true })
  const lagg = (n, i) => writeFileSync(join(bas, TRAD, 'sond', n), i, 'utf8')

  // 1. POSITIV — ETT PÅHITTAT FÄLT som inte finns i kodbasen. Namnet är valt så
  //    att en träff omöjligen kan komma från något annat.
  lagg('a.dto.ts', `export class A {\n  @IsBoolean()\n  zzPahittadFlagga!: boolean\n}\n`)
  // 2. POSITIV — ENRADSFORMEN, den företrädaren missade helt.
  lagg('b.dto.ts', `export class B {\n  @IsBoolean() @IsOptional() zzEnrad?: boolean\n}\n`)
  // 3. NEGATIV — skyddat fält fälls inte.
  lagg('c.dto.ts', `export class C {\n  @StrictBoolean()\n  @IsBoolean()\n  falt!: boolean\n}\n`)
  // 4. NEGATIV — DEN SOM FÅNGAR FÖRETRÄDARENS FALSKA POSITIVA: ett fält vars
  //    TS-typ är en strängunion, som FÖLJER ett booleskt enradsfält. Fälls det
  //    har parsern börjat tillskriva föregående fälts dekorator.
  lagg(
    'd.dto.ts',
    `export class D {\n  @StrictBoolean() @IsBoolean() @IsOptional() flagga?: boolean\n  @IsEnum(['A','B'])\n  @IsOptional()\n  strangUnion?: 'A' | 'B'\n}\n`,
  )
  // 5. NEGATIV — `example:` inne i en dekorators objektliteral är inget fält.
  lagg(
    'e.dto.ts',
    `export class E {\n  @ApiProperty({ example: true })\n  @StrictBoolean()\n  @IsBoolean()\n  falt!: boolean\n}\n`,
  )
  // 6. POSITIV — ett fältnamn på å/ä/ö ska hittas som vilket annat som helst.
  lagg('f.dto.ts', `export class F {\n  @IsBoolean()\n  ärGodkänd!: boolean\n}\n`)

  const funna = oskyddade(bas)
  const har = (falt) => funna.some((f) => f.falt === falt)

  if (!har('zzPahittadFlagga')) fel.push('KANARIEFÅGEL 1: ett påhittat oskyddat fält fälldes INTE.')
  if (!har('zzEnrad')) {
    fel.push('KANARIEFÅGEL 2: ENRADSFORMEN missades — parsern är radankrad igen.')
  }
  if (har('falt')) fel.push('KANARIEFÅGEL 3: ett skyddat fält fälldes.')
  if (har('strangUnion')) {
    fel.push(
      'KANARIEFÅGEL 4: en strängunion efter ett booleskt enradsfält fälldes — ' +
        'parsern tillskriver föregående fälts @IsBoolean.',
    )
  }
  if (har('example')) fel.push('KANARIEFÅGEL 5: `example:` i en objektliteral räknades som fält.')
  if (!har('ärGodkänd')) fel.push('KANARIEFÅGEL 6: ett fältnamn på å/ä/ö hittades inte.')
  return fel
}

const kanarieFel = kanariefåglar()
if (kanarieFel.length) {
  console.error('❌ StrictBoolean: vaktens egna kanariefåglar föll\n')
  for (const f of kanarieFel) console.error(`  ${f}`)
  console.error('\nEn vakt som inte kan fälla mäter ingenting. Laga vakten, inte koden.')
  process.exit(1)
}

if (process.argv.includes('--self-test')) {
  console.warn('✅ StrictBoolean, självtest: 6 sonder gröna')
  console.warn('   1 POSITIV  ett påhittat oskyddat fält fälls')
  console.warn('   2 POSITIV  ENRADSFORMEN hittas (företrädaren missade den)')
  console.warn('   3 NEGATIV  ett skyddat fält fälls inte')
  console.warn('   4 NEGATIV  en strängunion efter ett booleskt enradsfält fälls INTE')
  console.warn('   5 NEGATIV  `example:` i en objektliteral är inget fält')
  console.warn('   6 POSITIV  ett fältnamn på å/ä/ö hittas')
  process.exit(0)
}

const funna = oskyddade()
if (funna.length) {
  console.error('❌ StrictBoolean: ett booleskt DTO-fält kan läsa ett NEJ som ett JA\n')
  for (const p of funna) {
    console.error(
      `  ${p.fil}:${p.rad} — fältet ${p.falt} saknar @StrictBoolean(). Pipen kör ` +
        'Boolean(värdet) före validatorn, så strängen "false" blir true. Lägg till ' +
        'dekoratorn från common/contract/strict-boolean.decorator.',
    )
  }
  console.error(
    '\nINGEN BASLINJE. Regeln är absolut: mängden är noll, och ett nytt fält utan ' +
      'dekoratorn fäller bygget. Det finns ingen nivå där "ett nej som blir ett ja" ' +
      'är acceptabelt.',
  )
  process.exit(1)
}

console.warn('✅ StrictBoolean: varje booleskt DTO-fält bär dekoratorn — 0 oskyddade.')
console.warn(
  '   Vakten mäter att dekoratorn FINNS. Att den GÖR något ägs av strict-boolean.spec.ts, ' +
    'som kör den riktiga pipen.',
)
