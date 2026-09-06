#!/usr/bin/env node
/**
 * EN VALIDERAD KLASS BOR I EN `*.dto.ts`-FIL — annars är den osynlig för
 * kontraktsvakten.
 *
 * ── VARFÖR REGELN FINNS ─────────────────────────────────────────────────────
 *
 * `check-request-contract.mjs` bygger mängden härledda nyttolasttyper genom att
 * gå igenom `apps/api/src` och läsa filer som slutar på `.dto.ts`
 * (`harleddaTyper`). Den premissen är osagd och kan vara falsk: en DTO som
 * deklareras INNE i en controller finns inte i den mängden, och vakten kan
 * därför aldrig kräva att den har ett delat schema.
 *
 * Det är en tom mängd i förklädnad. Vakten säger inte "den här DTO:n saknar
 * schema" — den säger ingenting alls, och tystnaden ser ut som godkänt. Samma
 * form som CLAUDE.md:s avsnitt om kontroller som går blinda: den mäter bara de
 * filer den råkar klara av att läsa.
 *
 * Uppmätt: `PATCH /contracts/:leaseId/appendices/:documentId` bar en DTO inline
 * i `contracts.controller.ts` och var osynlig för vakten hela tiden den fanns
 * (#822 flyttade den). Den här vakten hittar samma form innan någon råkar
 * snubbla på den.
 *
 * ── VARFÖR PLACERINGSREGEL OCH INTE ETT SVEP ÖVER CONTROLLERS ───────────────
 *
 * Alternativet var att låta kontraktsvakten svepa även controllers. Det
 * avvisades, och skälet är inte bekvämlighet:
 *
 *   Ett svep hade gett TVÅ uppräkningar som ska vara lika — `harleddaTyper`
 *   läser fortfarande `*.dto.ts`, och svepet hade läst controllers. Två
 *   uppräkningar som ska vara lika är inte en uppräkning; den dag de glider
 *   isär blir ingen röd.
 *
 * Den här regeln gör i stället `harleddaTyper`s premiss SANN. När mängden
 * nedan är tom är "gå igenom `*.dto.ts`" uttömmande per konstruktion, och
 * kontraktsvakten behöver inget svep.
 *
 * Frågan "ligger filen rätt" är dessutom avgörbar utan tolkning. Frågan "hittade
 * svepet alla DTO-former" är det inte — och en vakt som kan ha fel om sin egen
 * täckning är den defekt vi försöker laga.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Att DTO:n i `dto/`-filen faktiskt ANVÄNDS av någon route, och att den har ett
 * delat schema. Det ägs av `check-request-contract.mjs` och av `SammaNycklar`-
 * raden i DTO:n. Den här mäter bara VAR klassen bor. En felplacerad klass är
 * osynlig för de andra kontrollerna; en rättplacerad är bara synlig.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask } from '../../../scripts/lib/source-scan.mjs'

const ROT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const TRAD = 'apps/api/src'
const BASLINJE = 'apps/api/scripts/dto-placement.baseline.json'

/**
 * Vilka dekoratorer kommer FRÅN class-validator i just den här filen?
 *
 * Härledd ur filens egen import i stället för en fast lista. En fast lista hade
 * varit en andra uppräkning som tyst blir ofullständig när class-validator får
 * en ny dekorator — och en ofullständig lista ger TYSTNAD, inte ett fel.
 */
function valideringsdekoratorer(ratext) {
  const namn = [...ratext.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'class-validator'/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()))
    // \p{Lu}, inte [A-Z]. Frågan är "börjar namnet med en VERSAL", och den
    // frågan är inte ASCII-specifik — `check-identifier-regex` fällde raden
    // direkt, och den hade rätt: ett bibliotek med ett dekoratornamn på Å
    // hade tappats tyst. Samma regel som CLAUDE.md:s avsnitt om \b.
    .filter((n) => /^\p{Lu}[\p{L}\p{N}_$]*$/u.test(n))
  return namn
}

/** Klassdeklarationer i kodvyn, med kropp via klammermatchning. */
function klasserMedKropp(kod) {
  const ut = []
  const KLASS = /(?:^|[\n;}])\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\p{L}\p{N}_$]+)/gu
  for (const m of kod.matchAll(KLASS)) {
    const start = kod.indexOf('{', m.index + m[0].length)
    if (start < 0) continue
    let djup = 0
    let slut = -1
    for (let i = start; i < kod.length; i += 1) {
      if (kod[i] === '{') djup += 1
      else if (kod[i] === '}') {
        djup -= 1
        if (djup === 0) {
          slut = i
          break
        }
      }
    }
    if (slut < 0) continue
    ut.push({ namn: m[1], index: m.index, kropp: kod.slice(start, slut) })
  }
  return ut
}

/**
 * Alla klasser med class-validator-dekoratorer som INTE bor i en `*.dto.ts`.
 *
 * Exporterad för att kanariefåglarna ska mäta SAMMA funktion som den skarpa
 * körningen. En sond som skriver om logiken mäter sin egen rad och kan inte
 * falla när vakten ändras.
 */
export function felplacerade(rot = ROT) {
  const ut = []
  const gaa = (katalog) => {
    for (const namn of readdirSync(katalog)) {
      const p = join(katalog, namn)
      if (statSync(p).isDirectory()) {
        gaa(p)
        continue
      }
      if (!namn.endsWith('.ts')) continue
      // `*.dto.ts` är MÅLET, och specar beskriver former i stället för att
      // exponera dem — en fixtur-DTO i ett prov är inte en API-yta.
      if (namn.endsWith('.dto.ts') || namn.endsWith('.spec.ts')) continue
      const ratext = readFileSync(p, 'utf8')
      const dekoratorer = valideringsdekoratorer(ratext)
      if (!dekoratorer.length) continue
      // KODVYN: frågan är om dekoratorn TILLÄMPAS, inte om den nämns. En
      // kommentar som säger "@IsString() behövs här" är inte en DTO.
      const kod = codeMask(ratext)
      const tillampad = new RegExp(`@(?:${dekoratorer.join('|')})\\s*[(\\s]`, 'u')
      for (const k of klasserMedKropp(kod)) {
        if (!tillampad.test(k.kropp)) continue
        ut.push({
          fil: relative(rot, p),
          rad: ratext.slice(0, k.index).split('\n').length + 1,
          klass: k.namn,
        })
      }
    }
  }
  gaa(join(rot, TRAD))
  return ut.sort((a, b) => `${a.fil}:${a.klass}`.localeCompare(`${b.fil}:${b.klass}`))
}

const nyckel = (p) => `${p.fil}\t${p.klass}`

// ── KANARIEFÅGLAR ───────────────────────────────────────────────────────────
//
// Utan dem betyder "inga nya felplacerade klasser" antingen att koden är ren
// eller att vakten slutat läsa — och de två utfallen ser likadana ut.
function kanariefåglar() {
  const fel = []
  const bas = mkdtempSync(join(tmpdir(), 'dto-placement-'))
  mkdirSync(join(bas, TRAD), { recursive: true })
  const lagg = (relativ, innehall) => {
    const p = join(bas, TRAD, relativ)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, innehall, 'utf8')
  }

  // 1. POSITIV: en inline-DTO i en controller MÅSTE fällas.
  lagg(
    'sond/sond.controller.ts',
    `import { IsString } from 'class-validator'\n\nclass SondKroppDto {\n  @IsString() falt!: string\n}\n\nexport class SondController {}\n`,
  )
  // 2. NEGATIV: samma klass i en *.dto.ts ska INTE fällas.
  lagg(
    'sond/dto/sond.dto.ts',
    `import { IsString } from 'class-validator'\n\nexport class SondRattPlaceradDto {\n  @IsString() falt!: string\n}\n`,
  )
  // 3. NEGATIV: en dekorator som bara NÄMNS i en kommentar är inte en DTO.
  //    Utan det här provet kan vakten läsa prosa och fälla en oskyldig klass —
  //    och den som skriver en kommentar om @IsString() får ett fel hen inte
  //    kan förstå.
  lagg(
    'sond/prosa.controller.ts',
    `import { IsString } from 'class-validator'\n\n// Här skulle @IsString() kunna behövas, men klassen är ingen DTO.\nexport class SondProsaController {\n  hej(): string {\n    return '@IsString()'\n  }\n}\n`,
  )
  // 4. NEGATIV: en dekorator som INTE kommer från class-validator (t.ex.
  //    Nests @Injectable) får inte göra en tjänst till en DTO.
  lagg(
    'sond/tjanst.service.ts',
    `import { Injectable } from '@nestjs/common'\nimport { IsString } from 'class-validator'\n\nexport function anvand(): typeof IsString {\n  return IsString\n}\n\n@Injectable()\nexport class SondTjanst {\n  varde = 1\n}\n`,
  )

  const funna = felplacerade(bas)
  const namn = funna.map((f) => f.klass)

  if (!namn.includes('SondKroppDto')) {
    fel.push('KANARIEFÅGEL 1: en inline-DTO i en controller fälldes INTE — vakten är blind.')
  }
  if (namn.includes('SondRattPlaceradDto')) {
    fel.push('KANARIEFÅGEL 2: en klass i en *.dto.ts fälldes — regeln träffar fel mängd.')
  }
  if (namn.includes('SondProsaController')) {
    fel.push('KANARIEFÅGEL 3: en dekorator i en KOMMENTAR räknades som tillämpad.')
  }
  if (namn.includes('SondTjanst')) {
    fel.push('KANARIEFÅGEL 4: en @Injectable-klass räknades som DTO.')
  }
  return fel
}

// ── KÖRNING ─────────────────────────────────────────────────────────────────

const skrivLage = process.argv.includes('--skriv')
const baslinjeSokvag = join(ROT, BASLINJE)

// Kanariefåglarna körs i BÅDA lägena. Ett självtest som bara finns bakom en
// flagga är ett löfte ingen håller på den skarpa vägen; ett skarpt läge utan
// dem kan gå blint. Samma fyra sonder, en gång per körning.
const kanarieFel = kanariefåglar()
if (kanarieFel.length) {
  console.error('❌ DTO-placering: vaktens egna kanariefåglar föll\n')
  for (const f of kanarieFel) console.error(`  ${f}`)
  console.error('\nEn vakt som inte kan fälla mäter ingenting. Laga vakten, inte baslinjen.')
  process.exit(1)
}

/**
 * SJÄLVTESTET — egen funktion, inte en if-kropp.
 *
 * `check-self-tests-fail.mjs` härleder rapportvägen ur den FUNKTION dispatchen
 * anropar, och injicerar ett fel i den för att pröva att vakten faktiskt
 * avslutar nollskilt. En självtestkropp som bara ligger i ett if-block går inte
 * att mäta så — och en vakt vars självtest inte går att pröva är precis det
 * metavakten finns för.
 */
function selfTest() {
  // Rapportvägen är en LISTA som exitbeslutet läser. Ett självtest som skriver
  // ut ett fel men ändå avslutar med 0 gör sitt CI-steg grönt om en vakt som
  // slutat mäta.
  const fel = []
  // Sonderna mäter VAKTENS egen `felplacerade()`, inte en omskrivning av dess
  // regex. En sond som skriver om logiken mäter sin egen rad och kan inte falla
  // när vakten ändras.
  for (const f of kanariefåglar()) fel.push(f)
  // Femte sonden: baslinjens total ska vara HÄRLEDD. Går talet att skriva ned
  // utan att ta bort medlemmar är ratcheten ingen ratchet.
  const b = JSON.parse(readFileSync(baslinjeSokvag, 'utf8'))
  if (b.total !== b.poster.length) {
    fel.push(`baslinjens total (${b.total}) är inte härledd ur poster (${b.poster.length})`)
  }
  if (fel.length) {
    console.error('❌ DTO-placering, självtestet föll\n')
    for (const f of fel) console.error(`  ${f}`)
    process.exit(1)
  }
  console.warn('✅ DTO-placering, självtest: 5 sonder gröna')
  console.warn('   1 POSITIV  inline-DTO i en controller fälls')
  console.warn('   2 NEGATIV  samma klass i en *.dto.ts fälls inte')
  console.warn('   3 NEGATIV  en dekorator i en KOMMENTAR är inte en tillämpning')
  console.warn('   4 NEGATIV  en @Injectable-klass är ingen DTO')
  console.warn(`   5 baslinjens total (${b.total}) är härledd ur poster`)
  process.exit(0)
}

if (process.argv.includes('--self-test')) {
  selfTest()
}

if (skrivLage) {
  const poster = felplacerade().map((p) => ({ fil: p.fil, klass: p.klass }))
  writeFileSync(
    baslinjeSokvag,
    `${JSON.stringify({ total: poster.length, poster }, null, 2)}\n`,
    'utf8',
  )
  console.warn(`✅ Baslinjen skriven: ${poster.length} kända felplacerade klasser.`)
  process.exit(0)
}

let baslinje = { total: 0, poster: [] }
try {
  baslinje = JSON.parse(readFileSync(baslinjeSokvag, 'utf8'))
} catch {
  console.error(`❌ DTO-placering: baslinjen saknas (${BASLINJE}).`)
  process.exit(1)
}

// "total" härleds ur "poster" och kontrolleras — talet ska inte gå att skriva
// ned utan att ta bort medlemmar.
if (baslinje.total !== baslinje.poster.length) {
  console.error(
    `❌ DTO-placering: baslinjens total (${baslinje.total}) stämmer inte med antalet ` +
      `poster (${baslinje.poster.length}).`,
  )
  process.exit(1)
}

const funna = felplacerade()

const kanda = new Set(baslinje.poster.map(nyckel))
const nu = new Set(funna.map(nyckel))

const nya = funna.filter((p) => !kanda.has(nyckel(p)))
const stale = baslinje.poster.filter((p) => !nu.has(nyckel(p)))

if (nya.length || stale.length) {
  console.error('❌ DTO-placering: en validerad klass utanför *.dto.ts\n')
  for (const p of nya) {
    console.error(
      `  NY ${p.fil}:${p.rad} — klassen ${p.klass} bär class-validator-dekoratorer men ` +
        'ligger inte i en *.dto.ts. Kontraktsvakten läser bara *.dto.ts, så DTO:n är ' +
        'OSYNLIG för den och kan aldrig krävas ha ett delat schema. Flytta den till ' +
        'en dto/-fil.',
    )
  }
  for (const p of stale) {
    console.error(
      `  STALE ${p.fil} — ${p.klass} står i baslinjen men är inte längre felplacerad. ` +
        'Ta bort raden ur dto-placement.baseline.json i SAMMA PR.',
    )
  }
  console.error('\nRegeln: baslinjen får bara KRYMPA.')
  process.exit(1)
}

console.warn(
  `✅ DTO-placering: ${funna.length} kända felplacerade klasser, inga nya och inga stale.`,
)
console.warn(
  '   Regeln gör check-request-contracts premiss sann: när talet är 0 är ' +
    '"gå igenom *.dto.ts" uttömmande per konstruktion.',
)
