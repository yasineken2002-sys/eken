#!/usr/bin/env node
/**
 * `as never` I PRODUKTIONSKOD ÄR ETT PÅSTÅENDE INGEN PRÖVAR.
 *
 * ── VARFÖR REGELN FINNS ─────────────────────────────────────────────────────
 *
 * `as never` tystar typcheckaren utan att kontrollera något. Formen uppstår när
 * ett värde av okänd typ ska in i en snävt typad parameter — och i den här
 * kodbasen kom värdet nästan alltid från en SPRÅKMODELL:
 *
 *     { status: toolInput.status as never }        →  Prismas where-sats
 *     { category: toolInput.category as never }    →  Prismas create-sats
 *
 * Castet gjorde inget. Ett påhittat enum-värde föll först i POSTGRES, som ett
 * 500-fel med ett meddelande varken operatören eller modellen kan använda — och
 * i filterfallen var alternativet värre: hade filtret tyst fallit bort skulle
 * modellen fått en LÄNGRE lista och trott att den var filtrerad.
 *
 * Rätt form är att VALIDERA mot samma enum databasen bär (`safeParse`) och svara
 * med de giltiga värdena. Se `tool-executor.service.ts` och #828/#829.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Att valideringen som ERSATTE ett cast är RIKTIG. Vakten mäter att castet är
 * borta, inte att det som kom i stället prövar rätt mängd — den frågan ägs av
 * `maintenance-enum-source.spec.ts` (att listan är Prismas) och
 * `enum-validering.spec.ts` (att ett värde utanför den avvisas). En grön vakt
 * här betyder alltså "ingen tystar typcheckaren", inte "värdena kontrolleras".
 *
 * Den ser inte heller andra former av samma sak: `as unknown as X`, `@ts-expect-
 * error`, `any`. Regeln är avsiktligt SMAL — `as never` är den form som uppstod
 * här, och en bred regel hade behövt en baslinje som ingen orkar krympa.
 *
 * ── SPECAR ÄR UNDANTAGNA, OCH PÅ FORM ───────────────────────────────────────
 *
 * 1769 av kodbasens 1785 `as never` står i prov, där de bygger attrapper —
 * `new Service(prisma as never, {} as never)`. Det är inte samma sak: attrappen
 * ÄR påhittad, och att säga det till typcheckaren är ärligt.
 *
 * Uteslutningen matchar FORMEN `\.spec\.ts$`, aldrig ordet "spec". Ett
 * `-v spec`-filter hade tagit bort hela `apps/api/src/inspections/` på köpet —
 * katalognamnet bär delsträngen `in[spec]tions`, och det kostade #567 ett helt
 * PDF-flöde ur en uppräkning som såg komplett ut.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask } from '../../../scripts/lib/source-scan.mjs'

const ROT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const TRAD = 'apps/api/src'
const BASLINJE = 'apps/api/scripts/as-never.baseline.json'

/**
 * Alla tillämpade `as never` i produktionskod.
 *
 * KODVYN, inte råtext. Frågan är om castet UTFÖRS — och just den här filen är
 * fullskriven med kommentarer som FÖRKLARAR varför ett `as never` togs bort.
 * Uppmätt i `tool-executor.service.ts` efter lagningen: råtext ger 3 träffar,
 * kodvyn 0. En råtextvakt hade alltså varit röd om sin egen dokumentation, och
 * den enda utvägen hade varit att sluta förklara.
 *
 * Exporterad för att kanariefåglarna ska mäta SAMMA funktion som den skarpa
 * körningen. En sond som skriver om regexen mäter sin egen rad och kan inte
 * falla när vakten ändras.
 */
export function kastenITradet(rot = ROT) {
  const ut = []
  const gaa = (katalog) => {
    for (const namn of readdirSync(katalog)) {
      const p = join(katalog, namn)
      if (statSync(p).isDirectory()) {
        gaa(p)
        continue
      }
      if (!namn.endsWith('.ts')) continue
      // FORMEN, inte ordet. Se filens huvud om `in[spec]tions`.
      if (/\.spec\.ts$/.test(namn)) continue
      if (/\.test-double\.ts$/.test(namn) || /\.testing\.ts$/.test(namn)) continue
      const ratext = readFileSync(p, 'utf8')
      if (!ratext.includes('as never')) continue
      const kod = codeMask(ratext)
      // `as` och `never` som hela ord. `\p{L}`-avgränsning, inte `\b`: ett
      // identifierarnamn får börja på å/ä/ö, och `\b` är ASCII-definierad.
      // check-identifier-regex fäller en ASCII-härledning här.
      const RE = /(?<![\p{L}\p{N}_$])as\s+never(?![\p{L}\p{N}_$])/gu
      for (const m of kod.matchAll(RE)) {
        ut.push({
          fil: relative(rot, p),
          rad: ratext.slice(0, m.index).split('\n').length,
        })
      }
    }
  }
  gaa(join(rot, TRAD))
  return ut.sort((a, b) => `${a.fil}:${String(a.rad).padStart(6, '0')}`.localeCompare(
    `${b.fil}:${String(b.rad).padStart(6, '0')}`,
  ))
}

const nyckel = (p) => `${p.fil}\t${p.rad}`

// ── KANARIEFÅGLAR ───────────────────────────────────────────────────────────
//
// Utan dem betyder "inga nya cast" antingen att koden är ren eller att vakten
// slutat läsa — och de två utfallen ser likadana ut.
function kanariefåglar() {
  const fel = []
  const bas = mkdtempSync(join(tmpdir(), 'as-never-'))
  mkdirSync(join(bas, TRAD), { recursive: true })
  const lagg = (relativ, innehall) => {
    const p = join(bas, TRAD, relativ)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, innehall, 'utf8')
  }

  // 1. POSITIV: ett verkligt cast MÅSTE fällas.
  lagg('sond/sond.service.ts', `export const x = (v: unknown) => ({ status: v as never })\n`)
  // 2. NEGATIV: samma text i en KOMMENTAR är ingen tillämpning. Utan det här
  //    provet kan vakten inte skilja kod från prosa, och den enda utvägen för
  //    den som förklarar varför ett cast togs bort blir att sluta förklara.
  lagg(
    'sond/prosa.service.ts',
    `// Fältet castades tidigare \`as never\`, se #830.\nexport const y = 1\n`,
  )
  // 3. NEGATIV: samma text i en STRÄNG är heller ingen tillämpning.
  lagg('sond/strang.service.ts', `export const z = 'as never'\n`)
  // 4. NEGATIV: en spec får bygga attrapper med `as never`.
  lagg('sond/sond.spec.ts', `const s = new Klass(prisma as never)\n`)
  // 5. NEGATIV — DEN SOM FÅNGAR FILTERFÄLLAN: en katalog vars NAMN bär
  //    delsträngen "spec" är INTE en spec. `in[spec]tions`. Ett cast här ska
  //    fällas; gör det inte det har uteslutningen blivit en ordmatchning och
  //    hela katalogen fallit ur mängden tyst.
  lagg('inspections/sond.service.ts', `export const w = (v: unknown) => ({ typ: v as never })\n`)
  // 6. NEGATIV: `asnever` och `as nevermore` är inte castet.
  lagg(
    'sond/delstrang.service.ts',
    `export const asnever = 1\nexport const q: { as: number } = { as: 2 }\n`,
  )

  const funna = kastenITradet(bas).map((f) => f.fil)
  const har = (bit) => funna.some((f) => f.includes(bit))

  if (!har('sond/sond.service.ts')) {
    fel.push('KANARIEFÅGEL 1: ett verkligt `as never` fälldes INTE — vakten är blind.')
  }
  if (har('sond/prosa.service.ts')) {
    fel.push('KANARIEFÅGEL 2: `as never` i en KOMMENTAR räknades som ett cast.')
  }
  if (har('sond/strang.service.ts')) {
    fel.push('KANARIEFÅGEL 3: `as never` i en STRÄNG räknades som ett cast.')
  }
  if (har('sond/sond.spec.ts')) {
    fel.push('KANARIEFÅGEL 4: en *.spec.ts fälldes — attrapper i prov är undantagna.')
  }
  if (!har('inspections/sond.service.ts')) {
    fel.push(
      'KANARIEFÅGEL 5: en fil under inspections/ fälldes INTE. Uteslutningen har blivit ' +
        'en ORDMATCHNING på "spec" och tar hela katalogen med sig (in[spec]tions).',
    )
  }
  if (har('sond/delstrang.service.ts')) {
    fel.push('KANARIEFÅGEL 6: `asnever` eller ett fält som heter `as` räknades som castet.')
  }
  return fel
}

// ── KÖRNING ─────────────────────────────────────────────────────────────────

const skrivLage = process.argv.includes('--skriv')
const baslinjeSokvag = join(ROT, BASLINJE)

const kanarieFel = kanariefåglar()
if (kanarieFel.length) {
  console.error('❌ as never: vaktens egna kanariefåglar föll\n')
  for (const f of kanarieFel) console.error(`  ${f}`)
  console.error('\nEn vakt som inte kan fälla mäter ingenting. Laga vakten, inte baslinjen.')
  process.exit(1)
}

function selfTest() {
  const fel = []
  for (const f of kanariefåglar()) fel.push(f)
  const b = JSON.parse(readFileSync(baslinjeSokvag, 'utf8'))
  if (b.total !== b.poster.length) {
    fel.push(`baslinjens total (${b.total}) är inte härledd ur poster (${b.poster.length})`)
  }
  if (fel.length) {
    console.error('❌ as never, självtestet föll\n')
    for (const f of fel) console.error(`  ${f}`)
    process.exit(1)
  }
  console.warn('✅ as never, självtest: 7 sonder gröna')
  console.warn('   1 POSITIV  ett verkligt cast fälls')
  console.warn('   2 NEGATIV  `as never` i en KOMMENTAR fälls inte')
  console.warn('   3 NEGATIV  `as never` i en STRÄNG fälls inte')
  console.warn('   4 NEGATIV  en *.spec.ts fälls inte')
  console.warn('   5 NEGATIV  en fil under in[spec]tions/ fälls ÄNDÅ (ordmatchningsfällan)')
  console.warn('   6 NEGATIV  `asnever` och ett fält som heter `as` är inte castet')
  console.warn(`   7 baslinjens total (${b.total}) är härledd ur poster`)
  process.exit(0)
}

if (process.argv.includes('--self-test')) {
  selfTest()
}

if (skrivLage) {
  const poster = kastenITradet().map((p) => ({ fil: p.fil, rad: p.rad }))
  writeFileSync(
    baslinjeSokvag,
    `${JSON.stringify({ total: poster.length, poster }, null, 2)}\n`,
    'utf8',
  )
  console.warn(`✅ Baslinjen skriven: ${poster.length} kända \`as never\` i produktionskod.`)
  process.exit(0)
}

let baslinje = { total: 0, poster: [] }
try {
  baslinje = JSON.parse(readFileSync(baslinjeSokvag, 'utf8'))
} catch {
  console.error(`❌ as never: baslinjen saknas (${BASLINJE}).`)
  process.exit(1)
}

if (baslinje.total !== baslinje.poster.length) {
  console.error(
    `❌ as never: baslinjens total (${baslinje.total}) stämmer inte med antalet ` +
      `poster (${baslinje.poster.length}).`,
  )
  process.exit(1)
}

const funna = kastenITradet()
const kanda = new Set(baslinje.poster.map(nyckel))
const nu = new Set(funna.map(nyckel))

const nya = funna.filter((p) => !kanda.has(nyckel(p)))
const stale = baslinje.poster.filter((p) => !nu.has(nyckel(p)))

if (nya.length || stale.length) {
  console.error('❌ as never i produktionskod\n')
  for (const p of nya) {
    console.error(
      `  NY ${p.fil}:${p.rad} — \`as never\` tystar typcheckaren utan att kontrollera ` +
        'något. Kommer värdet utifrån (en språkmodell, en kropp, ett svar): VALIDERA det ' +
        'mot samma enum databasen bär (`safeParse`) och svara med de giltiga värdena. ' +
        'Ett cast flyttar bara felet till Postgres.',
    )
  }
  for (const p of stale) {
    console.error(
      `  STALE ${p.fil}:${p.rad} — står i baslinjen men finns inte längre. ` +
        'Ta bort raden ur as-never.baseline.json i SAMMA PR.',
    )
  }
  console.error('\nRegeln: baslinjen får bara KRYMPA.')
  process.exit(1)
}

console.warn(`✅ as never: ${funna.length} kända cast i produktionskod, inga nya och inga stale.`)
console.warn(
  '   Vakten mäter att castet är BORTA — inte att valideringen som kom i stället prövar ' +
    'rätt mängd. Det ägs av maintenance-enum-source.spec.ts och enum-validering.spec.ts.',
)
