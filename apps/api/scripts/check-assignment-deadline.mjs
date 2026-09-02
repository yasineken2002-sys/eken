#!/usr/bin/env node
/**
 * CI-guard — UPPDRAGETS TIDSGRÄNS ÄR DATA, INTE EN KONSTANT.
 *
 * ── VAD DEN SKYDDAR MOT, OCH VARFÖR DET ÄR TYST ─────────────────────────────
 *
 * `PENDING_ACTION_TTL_MS` (fem minuter) är REDAN dubbelanvänd:
 *
 *     ai-assistant.service.ts   hur länge ett AI-förslag får bekräftas
 *     resumption-policy.ts      ATERUPPTAGNING_TAK_MS = PENDING_ACTION_TTL_MS
 *
 * Lånar uppdragskön samma konstant blir den TREdubbelt använd, och då flyttar
 * en justering av uppdragens gräns samtidigt återupptagningsmotorns tak. Inget
 * test blir rött av det: båda talen är fortfarande "rätt", var för sig, och
 * motorn börjar bara tyst avstå från fler rader.
 *
 * Det är samma familj som ett tal skrivet i prosan — två gränser som ska kunna
 * ändras var för sig får inte vara en gräns.
 *
 * Och en global konstant vore fel även utan den kopplingen: en rörmokarbokning
 * och ett hyreshöjningsbesked har olika brådska. Ett tal för båda blir fel för
 * minst en.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Ingen fil under src/ai/assignments/ får referera `PENDING_ACTION_TTL_MS`
 *     i KOD. En kommentar som förklarar varför den INTE används är tillåten —
 *     och den finns med flit i både schemat och tjänsten.
 * R2  Ingen fil under src/ai/assignments/ får importera modulen
 *     `pending-action-ttl`. Modulsökvägen är en STRÄNG, inte en identifierare,
 *     så den frågan ställs i en annan vy än R1.
 * R3  Ingen icke-spec-fil under src/ai/assignments/ får RÄKNA FRAM en deadline
 *     (`Date.now() + …`). Gränsen kommer från anroparen; räknas den fram här
 *     finns en default, och en default är ett globalt tal i förklädnad.
 * R4  `SkapaUppdrag.deadline` måste vara OBLIGATORISK. Blir den valfri måste
 *     något fylla i den, och det något blir en default.
 *
 * ── TVÅ VYER, EN PER FRÅGA ──────────────────────────────────────────────────
 *
 *   kod        = codeMask       R1, R3, R4 — identifierare och uttryck. En
 *                               utkommenterad referens är ingen referens.
 *   strängar   = blankComments  R2 — importsökvägen ÄR en stränglitteral.
 *                               codeMask hade blankat den och gjort regeln
 *                               omöjlig att bryta mot, alltså omöjlig att mäta.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Att gränsen är RIMLIG för det enskilda uppdraget. Den mäter frånvaron av en
 * delad källa, inte omdömet hos den som sätter talet. Och den ser inte en
 * default som räknas fram hos PRODUCENTEN (etapp 8–9) — den bor utanför den här
 * katalogen. Den dagen producenten finns ska omfånget utvidgas, inte antas.
 *
 * Lokalt:      node apps/api/scripts/check-assignment-deadline.mjs
 * Självtest:   node apps/api/scripts/check-assignment-deadline.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeMask, blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KATALOG = join(HERE, '..', 'src', 'ai', 'assignments')
const ROT = join(HERE, '..', '..', '..')

const KONSTANT = 'PENDING_ACTION_TTL_MS'
const MODUL = 'pending-action-ttl'

/**
 * Är filen ett prov? Matchar FORMEN, inte ordet.
 *
 * `grep -v spec` hade uteslutit varje fil under en katalog som råkar bära
 * delsträngen — `apps/api/src/inspections/` är det uppmätta fallet (#567), där
 * ett riktigt PDF-flöde föll ur mängden tillsammans med sex spec-rader.
 */
const ÄR_PROV = (fil) => /\.(spec|db\.spec)\.ts$/.test(fil)

function filer(katalog) {
  const ut = []
  for (const post of readdirSync(katalog, { withFileTypes: true })) {
    const p = join(katalog, post.name)
    if (post.isDirectory()) ut.push(...filer(p))
    else if (post.name.endsWith('.ts')) ut.push(p)
  }
  return ut.sort()
}

/** Ordgräns med Unicode-medvetenhet: `\b` är ASCII-definierat. */
function finnsIKod(kod, id) {
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${id}(?![\\p{L}\\p{N}_$])`, 'u').test(kod)
}

/** R3: en deadline som RÄKNAS FRAM. Tillåter `Date.now()` som jämförelse. */
const RÄKNAR_FRAM_TID = /(?:Date\.now\(\)|getTime\(\))\s*\+/

/**
 * Kärnan, som ren funktion så självtestet kan mata in påhittade filer.
 * @param {Array<{fil: string, text: string}>} källor
 */
export function utvärdera(källor) {
  const fel = []
  for (const { fil, text } of källor) {
    const kod = codeMask(text)
    const strängar = blankComments(text)

    if (finnsIKod(kod, KONSTANT)) {
      fel.push(`R1 ${fil}: refererar ${KONSTANT} i kod. Uppdragets gräns är egen data.`)
    }
    if (strängar.includes(MODUL)) {
      fel.push(`R2 ${fil}: importerar modulen '${MODUL}'. Uppdragets gräns är egen data.`)
    }
    if (!ÄR_PROV(fil) && RÄKNAR_FRAM_TID.test(kod)) {
      fel.push(
        `R3 ${fil}: räknar fram en tidpunkt (Date.now() + …). En framräknad deadline är en ` +
          `default, och en default är ett globalt tal i förklädnad.`,
      )
    }
  }
  return fel
}

/** R4 mäts på tjänstens gränssnitt, inte per fil. */
export function prövaObligatoriskDeadline(tjänstKod) {
  const kod = codeMask(tjänstKod)
  if (/deadline\s*\?\s*:/.test(kod)) {
    return ['R4: SkapaUppdrag.deadline är valfri. Blir den valfri måste något fylla i den.']
  }
  if (!/deadline\s*:\s*Date/.test(kod)) {
    return ['R4: SkapaUppdrag.deadline saknas eller har bytt typ — regeln kan inte längre mätas.']
  }
  return []
}

function självtest() {
  const fel = []
  const kräv = (namn, villkor, detalj) => {
    if (!villkor) fel.push(`${namn}${detalj ? ` — ${detalj}` : ''}`)
  }

  // ── KANARIEFÅGELN: SAMMA IDENTIFIERARE I KOMMENTAR RESP. I KOD ───────────
  //
  // Utfallen måste vara MOTSATTA. Ett prov som bara visar det positiva fallet
  // skiljer inte en läsande regel från en blind — och den här vakten MÅSTE
  // tåla en kommentar, eftersom både schemat och tjänsten förklarar i prosa
  // varför konstanten inte används.
  kräv(
    'KANARIEFÅGEL R1 (i kod → fälls)',
    utvärdera([{ fil: 'a.ts', text: `const x = ${KONSTANT}\n` }]).some((f) => f.startsWith('R1')),
  )
  kräv(
    'KANARIEFÅGEL R1 (i kommentar → fälls INTE)',
    utvärdera([{ fil: 'a.ts', text: `// vi använder aldrig ${KONSTANT} här\nconst x = 1\n` }])
      .length === 0,
  )
  // Och en DELSTRÄNG ska inte matcha — annars är ordgränsen bortglömd.
  kräv(
    'KANARIEFÅGEL R1 (delsträng → fälls INTE)',
    utvärdera([{ fil: 'a.ts', text: `const x = MITT_${KONSTANT}_EXTRA\n` }]).length === 0,
  )

  // R2: sökvägen bor i en STRÄNG. Provet fäller om någon byter till codeMask.
  kräv(
    'R2 (import av modulen → fälls)',
    utvärdera([{ fil: 'a.ts', text: `import { x } from '../${MODUL}'\n` }]).some((f) =>
      f.startsWith('R2'),
    ),
  )

  // R3: framräknad tid fälls i produktionskod, men inte i ett prov.
  kräv(
    'R3 (framräknad deadline i produktionskod → fälls)',
    utvärdera([{ fil: 'a.ts', text: 'const d = new Date(Date.now() + 1000)\n' }]).some((f) =>
      f.startsWith('R3'),
    ),
  )
  kräv(
    'R3 (samma uttryck i ett PROV → fälls inte)',
    utvärdera([{ fil: 'a.spec.ts', text: 'const d = new Date(Date.now() + 1000)\n' }]).length === 0,
  )
  kräv(
    'R3 (Date.now() som JÄMFÖRELSE → fälls inte)',
    utvärdera([{ fil: 'a.ts', text: 'if (d.getTime() <= Date.now()) throw new Error()\n' }])
      .length === 0,
  )

  // R4, båda hållen.
  kräv('R4 (valfri deadline → fälls)', prövaObligatoriskDeadline('deadline?: Date\n').length > 0)
  kräv('R4 (obligatorisk deadline → fälls inte)', prövaObligatoriskDeadline('deadline: Date\n').length === 0)
  kräv('R4 (borttagen deadline → fälls)', prövaObligatoriskDeadline('const x = 1\n').length > 0)

  if (fel.length > 0) {
    console.error('❌ Självtestet föll:\n   • ' + fel.join('\n   • '))
    process.exit(1)
  }
  console.warn(`✅ Självtest: 10 påståenden, alla gröna (kanariefågel åt båda hållen på R1).`)
}

function kör() {
  const fel = []

  // Den delade skannerns egna kanariefåglar FÖRST. En vakt som bygger på en
  // trasig förbehandlare mäter bara de filer förbehandlaren klarade att läsa.
  const skannerFel = kanariefåglar()
  if (skannerFel.length > 0) {
    fel.push(`Den delade skannerns kanariefåglar föll:\n     • ${skannerFel.join('\n     • ')}`)
  }

  const alla = filer(KATALOG)
  // En tom mängd är inte ett godkänt utfall: hittar vakten inga filer mäter den
  // ingenting, och det ser exakt ut som att allt är i ordning.
  if (alla.length === 0) {
    console.error(`❌ Inga .ts-filer under ${relative(ROT, KATALOG)} — vakten mäter ingenting.`)
    process.exit(1)
  }

  fel.push(
    ...utvärdera(alla.map((f) => ({ fil: relative(ROT, f), text: readFileSync(f, 'utf8') }))),
  )
  fel.push(
    ...prövaObligatoriskDeadline(readFileSync(join(KATALOG, 'ai-assignments.service.ts'), 'utf8')),
  )

  if (fel.length > 0) {
    console.error('❌ Uppdragets tidsgräns:\n   • ' + fel.join('\n   • '))
    process.exit(1)
  }
  const prov = alla.filter((f) => ÄR_PROV(f)).length
  console.warn(
    `✅ Tidsgränsen är data: ${alla.length} filer granskade (${prov} prov), ` +
      `ingen delar ${KONSTANT} och ingen räknar fram en default.`,
  )
}

if (process.argv.includes('--self-test')) självtest()
else kör()
