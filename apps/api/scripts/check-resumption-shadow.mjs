#!/usr/bin/env node
/**
 * SKUGGLÄGET ÄR EN AVSAKNAD, INTE EN FLAGGA — och den här vakten mäter det.
 *
 * Återupptagningsmotorn är den första komponenten som agerar utan att en
 * människa bett om det i samma stund. Den byggdes i skuggläge, och skuggläget
 * vilar inte på ett `if` som kan flippas: det vilar på att koden som UTFÖR något
 * inte går att nå från `resumption.service.ts`.
 *
 * Den garantin är bara värd något om något kontrollerar den. En import som
 * smyger in vid nästa refaktorering syns annars inte förrän motorn gjort något.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Den mäter FRÅNVARON AV EN KOPPLING i källtexten. Den kan inte se att omdömet
 * är riktigt — det ägs av `resumption-policy.spec.ts`, som prövar varje steg och
 * har en negativkontroll för spärren mot KRÄVER_MÄNNISKA. Och den kan inte se
 * ett utförande som når tjänsten på en väg utan namn: en injicerad `unknown`,
 * ett dynamiskt `require`. Den fångar det troliga, inte det påhittiga.
 *
 * ── VARFÖR FRÅGAN STÄLLS MOT KOD OCH INTE MOT RÅTEXT ────────────────────────
 *
 * Det här skrevs först som ett jest-prov som läste filen som råtext. Det var
 * RÖTT direkt — av tjänstens EGET docblock, som förklarar varför det inte finns
 * någon väg till `ToolExecutorService` och därför nämner den vid namn.
 *
 * En kontroll som läser prosa mäter prosan. Frågan går via `codeMask`, som
 * blankar kommentarer och stränginnehåll men behåller längd och radbrytningar.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask, blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TJÄNSTEN = join(HERE, '..', 'src', 'ai', 'resumption', 'resumption.service.ts')

/**
 * Identifierare som INTE får förekomma i kod i motorns tjänstefil.
 *
 * `LIVE` står med därför att `ResumptionMode.LIVE` är enumvärdet för skarpt
 * läge. Skrivs det i tjänsten är skarpt läge påbörjat, och då ska det vara ett
 * medvetet beslut som tar bort den här raden — inte en diff som glider förbi.
 */
const FÖRBJUDNA = [
  { namn: 'ToolExecutorService', varför: 'verktygsutföraren' },
  { namn: 'executeTool', varför: 'utförandeanropet' },
  { namn: 'TenantToolExecutorService', varför: 'hyresgästernas verktygsutförare' },
  { namn: "'LIVE'", varför: 'skarpt läge' },
]

/** Ordgräns med Unicode-medvetenhet: `\b` är ASCII-definierat. */
function finnsIKod(kod, id) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${id}(?![\\p{L}\\p{N}_$])`, 'u')
  return re.test(kod)
}

/**
 * EN VY PER FRÅGA — och `'LIVE'` var i FEL VY.
 *
 * Tre av de fyra posterna är IDENTIFIERARE och ska läsas ur kodvyn, där
 * kommentarer och stränginnehåll är blankade. Den fjärde är en STRÄNGLITERAL,
 * `'LIVE'`, och den bor per definition i en sträng — som codeMask blankar.
 *
 * Uppmätt 2026-09-04, när självtestet nedan skrevs:
 *
 *     råtext            const läge = 'LIVE'
 *     codeMask          const läge = '    '     ← includes("'LIVE'") = false
 *     blankComments     const läge = 'LIVE'     ← true
 *
 * Regeln kunde alltså ALDRIG fira. Vaktens gröna rad sa "ingen av 4
 * utförandeidentifierare", medan bara tre av dem gick att mäta. Det är precis
 * den tystnad vakten finns för att stänga, en nivå upp — och den syntes först
 * när ett självtest matade in det positiva fallet för VARJE post i stället för
 * bara den första.
 *
 * Strängvyn har kommentarer blankade, så ett `'LIVE'` i prosa räknas inte.
 * Vad den INTE skiljer: ett `'LIVE'` som står inuti en annan sträng, t.ex. i
 * ett felmeddelande. Den formen finns inte i tjänsten i dag; dyker den upp är
 * rätt åtgärd att läsa strängLITERALER en och en, inte att byta vy igen.
 */
function finnsSomSträng(strängvy, literal) {
  return strängvy.includes(literal)
}

/**
 * BEDÖMNINGEN, ren och matbar. Exporterad så självtestet kör EXAKT samma kod
 * som CI — en sond som skriver om regeln mäter sin egen rad.
 *
 * @param {string} kod  redan maskerad KODVY (kommentarer och stränginnehåll
 *                      blankade). Att maskningen sker hos anroparen är
 *                      medvetet: självtestet ska kunna mata in prosa och
 *                      docblock och se att de INTE ger utslag.
 */
export function utvärdera(kod, strängvy = kod) {
  const fel = []
  for (const { namn, varför } of FÖRBJUDNA) {
    const träff = namn.startsWith("'") ? finnsSomSträng(strängvy, namn) : finnsIKod(kod, namn)
    if (träff) {
      fel.push(
        `${namn} (${varför}) förekommer i KOD i resumption.service.ts.\n` +
          `     Skuggläget vilar på att den vägen inte finns. Är skarpt läge ett fattat\n` +
          `     beslut: ta bort raden ur FÖRBJUDNA i den här vakten, i samma PR.`,
      )
    }
  }
  if (!finnsIKod(kod, 'körEttPass')) {
    fel.push('resumption.service.ts saknar `körEttPass` — läser vakten rätt fil?')
  }
  return fel
}

function kör() {
  const fel = []

  // Den delade skannerns egna kanariefåglar FÖRST. En vakt som bygger på en
  // trasig förbehandlare mäter bara de filer förbehandlaren klarade att läsa.
  const skannerFel = kanariefåglar()
  if (skannerFel.length > 0) {
    fel.push(`Den delade skannerns kanariefåglar föll:\n     • ${skannerFel.join('\n     • ')}`)
  }

  const rå = readFileSync(TJÄNSTEN, 'utf8')
  const kod = codeMask(rå)

  // ── VAKTENS EGEN KANARIEFÅGEL ────────────────────────────────────────────
  //
  // Matar in SAMMA identifierare två gånger: en gång i en kommentar, en gång i
  // kod. Utfallen måste vara MOTSATTA. Ett prov som bara visar det positiva
  // fallet skiljer inte en läsande regel från en blind.
  {
    const iKommentar = `// vi rör aldrig ToolExecutorService här\nconst x = 1\n`
    const iKod = `const y = new ToolExecutorService()\n`
    if (finnsIKod(codeMask(iKommentar), 'ToolExecutorService')) {
      fel.push('KANARIEFÅGEL: en identifierare i en KOMMENTAR gav utslag — vakten läser prosa.')
    }
    if (!finnsIKod(codeMask(iKod), 'ToolExecutorService')) {
      fel.push('KANARIEFÅGEL: en identifierare i KOD gav INGET utslag — vakten är blind.')
    }
    // Och den form som faktiskt fällde det första försöket: identifieraren i
    // ett docblock, med all den omgivande prosa ett riktigt docblock har.
    const iDocblock = `/**\n * Det finns ingen väg härifrån till ToolExecutorService.\n */\nconst z = 1\n`
    if (finnsIKod(codeMask(iDocblock), 'ToolExecutorService')) {
      fel.push('KANARIEFÅGEL: en identifierare i ett DOCBLOCK gav utslag — vakten läser prosa.')
    }
  }

  fel.push(...utvärdera(kod, blankComments(rå)))

  if (fel.length > 0) {
    console.error('❌ Skugglägesvakten föll:\n')
    for (const f of fel) console.error(`   • ${f}\n`)
    process.exit(1)
  }
  console.log(
    `✅ Skuggläget intakt: ingen av ${FÖRBJUDNA.length} utförandeidentifierare förekommer i kod.`,
  )
}

// ── självtest ───────────────────────────────────────────────────────────────
//
// Vakten var till 2026-09-04 den ENDA av fyrtiotre utan ett `--self-test`.
// Den bar redan kanariefåglar, men inne i `kör()` — alltså bara i den körning
// som också läser trädet, och utan ett läge där proven kan matas med egna
// fixturer. Uppmätt i uppräkningen som föregick den här PR:en: 42 av 43 vakter
// hade ett självtest, och just den som saknade det är den som vaktar att
// återupptagningsmotorn INTE kan utföra något.
//
// GOLVEN ÄR LÄSTA UR TRÄDET, inte valda:
//   FÖRBJUDNA          4 identifierare (mätt 4d66d45)
//   tjänstefilens kodvy 4 110 icke-blanka tecken (mätt 4d66d45)
// Golvet är satt med marginal nedåt. Sjunker talet under det läser vakten
// antingen fel fil eller en fil som krympt till oigenkännlighet — och en tom
// kodvy ger noll träffar, alltså GRÖNT om ingenting.

/** GOLV: antalet förbjudna identifierare. Mätt mot 4d66d45. */
const MIN_FÖRBJUDNA = 4
/** GOLV: icke-blanka tecken i tjänstefilens KODVY. Mätt: 4 110 mot 4d66d45. */
const MIN_KODTECKEN = 2500

function självtest() {
  const fel = []
  const kräv = (namn, villkor, detalj) => {
    console.warn(`${villkor ? '✅' : '❌'} ${namn}${detalj ? `  → ${detalj}` : ''}`)
    if (!villkor) fel.push(namn)
  }

  // (0) Den delade skannern bär hela maskningen. Går den sönder ska DEN HÄR
  // vakten bli röd, inte bara source-scan.mjs egen körning.
  const skanner = kanariefåglar()
  kräv('delad skanner: kanariefåglarna gröna', skanner.length === 0, skanner.join(' | '))

  // (1) POSITIVT, för VARJE förbjuden identifierare — inte bara den första.
  //     En uppräkning som bara provar sitt första element vet inte vad den
  //     inte provat.
  for (const { namn } of FÖRBJUDNA) {
    const iKod = namn.startsWith("'")
      ? `const läge = ${namn}\nfunction körEttPass() {}\n`
      : `const x = new ${namn}()\nfunction körEttPass() {}\n`
    const r = utvärdera(codeMask(iKod), blankComments(iKod))
    kräv(`fäller ${namn} i KOD`, r.some((f) => f.startsWith(namn)), JSON.stringify(r).slice(0, 70))
  }

  // (2) NEGATIVT, samma identifierare i tre prosaformer. Utfallen ska vara
  //     MOTSATTA det positiva — annars skiljer provet inte en läsande regel
  //     från en blind.
  const bas = 'function körEttPass() {}\n'
  for (const [form, src] of [
    ['radkommentar', `// vi rör aldrig ToolExecutorService här\n${bas}`],
    ['docblock', `/**\n * Ingen väg härifrån till ToolExecutorService.\n */\n${bas}`],
    ['stränginnehåll', `const t = 'ToolExecutorService'\n${bas}`],
  ]) {
    const fel2 = utvärdera(codeMask(src), blankComments(src))
    kräv(`prosa (${form}) ger INGET utslag`, fel2.length === 0, JSON.stringify(fel2).slice(0, 70))
  }

  // (3) DELSTRÄNGS-MOTPROVET. Avgränsningen får inte bli en delsträngssökning
  //     åt något håll.
  for (const namn of ['xToolExecutorService', 'ToolExecutorServiceX', 'MinToolExecutorServiceWrapper']) {
    const src3 = `const x = new ${namn}()\n${bas}`
    const fel3 = utvärdera(codeMask(src3), blankComments(src3))
    kräv(`delsträng ${namn} fälls inte`, fel3.length === 0, JSON.stringify(fel3).slice(0, 60))
  }

  // (4) SVENSK GRANNE. `\b` hade fällt `påToolExecutorService`, eftersom `å`
  //     inte är ett ordtecken. Lookaround-formen gör det inte — och den ska
  //     fortfarande fälla det äkta namnet med en svensk granne på andra sidan.
  kräv(
    'svensk bokstav FÖRE namnet är inte namnet',
    utvärdera(codeMask(`const x = new påToolExecutorService()\n${bas}`), blankComments(`const x = new påToolExecutorService()\n${bas}`)).length === 0,
  )
  kräv(
    'namnet fälls även med en svensk granne efter en punkt',
    utvärdera(codeMask(`const x = tjänst.ToolExecutorService\n${bas}`), blankComments(`const x = tjänst.ToolExecutorService\n${bas}`)).some((f) =>
      f.startsWith('ToolExecutorService'),
    ),
  )

  // (5) SONDEN ÄR SKARP: saknas motorn ska vakten säga till. Utan den här kan
  //     vakten peka på fel fil och vara grön om ingenting.
  kräv(
    'en fil UTAN körEttPass fälls',
    utvärdera(codeMask('const x = 1\n'), blankComments('const x = 1\n')).some((f) => f.includes('körEttPass')),
  )

  // (6) GOLVEN, lästa ur trädet.
  kräv(
    `omfång: ${FÖRBJUDNA.length} förbjudna identifierare (golv ${MIN_FÖRBJUDNA})`,
    FÖRBJUDNA.length >= MIN_FÖRBJUDNA,
  )
  const kodtecken = codeMask(readFileSync(TJÄNSTEN, 'utf8')).replace(/\s/g, '').length
  kräv(
    `omfång: ${kodtecken} icke-blanka tecken i tjänstens kodvy (golv ${MIN_KODTECKEN})`,
    kodtecken >= MIN_KODTECKEN,
    'en tom kodvy ger noll träffar — alltså grönt om ingenting',
  )

  // (7) BASLINJEN: trädet som det ser ut nu ska vara rent.
  const tjänstRå = readFileSync(TJÄNSTEN, 'utf8')
  kräv('trädet är rent i dag', utvärdera(codeMask(tjänstRå), blankComments(tjänstRå)).length === 0)

  if (fel.length) {
    console.error(`\n❌ Självtestet föll på ${fel.length} punkt(er).`)
    process.exit(1)
  }
  console.warn(
    `\n✅ Självtest OK — ${FÖRBJUDNA.length} identifierare prövade i kod och i tre prosaformer, ` +
      `delsträngar och svenska grannar avvisade, golv ${MIN_KODTECKEN} tecken hållet (${kodtecken}).`,
  )
}

if (process.argv.includes('--self-test')) självtest()
else kör()
