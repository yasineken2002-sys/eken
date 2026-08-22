#!/usr/bin/env node
/**
 * Nedstängningen får inte tyst sluta vara nedstängning.
 *
 * ── VARFÖR VAKTEN FINNS ─────────────────────────────────────────────────────
 *
 * `app.enableShutdownHooks()` är EN rad i main.ts, och en rad utan anropare kan
 * tas bort av vem som helst utan att något blir rött. Då är vi tillbaka i det
 * uppmätta utgångsläget: noll SIGTERM-lyssnare, processen död på 26 ms, och en
 * döende container som plockar NYA jobb ur Redis ända fram till SIGKILL.
 *
 * Samma sak gäller `maxStalledCount`. Sätts den inte uttryckligen gäller bulls
 * default 1, och då dör ett jobb permanent vid sitt andra stall NÅGONSIN —
 * förbi `attempts`, förbi `backoff`, och med en `stalledCounter` som aldrig
 * nollställs. Frånvaron ser exakt ut som ett medvetet val.
 *
 * Vakten mäter alltså tre saker som annars bara syns i en PR-text:
 *
 *   R1  main.ts anropar enableShutdownHooks(), och FÖRE app.listen.
 *   R2  BullModule sätter maxStalledCount uttryckligen.
 *   R3  talet är MINIMUM av producenternas `attempts` — härlett ur koden.
 *   R4  härledningen mätte faktiskt något (annars är R3 grön av tomhet).
 *
 * ── ORDNINGEN I R1 ÄR INTE PEDANTERI ────────────────────────────────────────
 *
 * `enableShutdownHooks()` efter `app.listen()` registrerar lyssnaren först
 * efter att servern börjat ta emot trafik. Det fönstret är kort men det är
 * också precis det fönster en deploy träffar: den nya containern får trafik i
 * samma ögonblick som den blir frisk.
 *
 * ── PÅKOPPLINGEN ────────────────────────────────────────────────────────────
 *
 * Vakten säger att raden STÅR där. Att raden GÖR något är mätt i
 * apps/api/src/common/shutdown/shutdown-hooks.spec.ts (0 lyssnare utan hooken,
 * 1 med). Var för sig är båda den defekt vi jagat: en spec utan påkoppling, och
 * en vakt som bevakar en sträng ingen prövat effekten av.
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const MAIN = 'apps/api/src/main.ts'
const APP_MODULE = 'apps/api/src/app.module.ts'
const PRODUCENT_ROT = 'apps/api/src'

/** Minsta antal köproducenter respektive attempts-värden för att R3 ska betyda något. */
const MIN_PRODUCENTER = 3
const MIN_ATTEMPTS_VÄRDEN = 3

/**
 * @param {{mainTs: string, appModuleTs: string, producenter: Array<{rel: string, text: string}>}} källor
 */
export function evaluate({ mainTs, appModuleTs, producenter }) {
  const fel = []

  // ── R1 ────────────────────────────────────────────────────────────────────
  // Kommentarer och stränginnehåll är blankade, positioner bevarade. En rad som
  // bara står i en kommentar eller en sträng räknas alltså INTE — det är den
  // förbehandlingsfällan som gjorde en annan vakt grön om en hel fil.
  const mainKod = codeMask(mainTs)
  const hookPos = mainKod.indexOf('enableShutdownHooks(')
  const listenPos = mainKod.indexOf('.listen(')

  if (hookPos === -1) {
    fel.push(
      `R1 ${MAIN} — anropar inte app.enableShutdownHooks(). Utan den har processen NOLL ` +
        'SIGTERM-lyssnare (mätt), dör på 26 ms, och Bull-köerna hämtar nya jobb ända fram ' +
        'till SIGKILL. Se kommentaren vid app.listen i samma fil.',
    )
  } else if (listenPos === -1) {
    fel.push(
      `R1 ${MAIN} — hittar inget .listen(-anrop att jämföra ordningen mot. Antingen har ` +
        'bootstrap skrivits om, eller så mäter den här regeln inte längre det den tror.',
    )
  } else if (hookPos > listenPos) {
    const rad = mainKod.slice(0, hookPos).split('\n').length
    fel.push(
      `R1 ${MAIN}:${rad} — enableShutdownHooks() står EFTER app.listen(). Lyssnaren måste ` +
        'finnas innan servern börjar ta emot trafik; en deploy träffar exakt det fönstret.',
    )
  }

  // ── R2 ────────────────────────────────────────────────────────────────────
  const modulKod = codeMask(appModuleTs)
  const m = /maxStalledCount\s*:\s*(\d+)/.exec(modulKod)
  if (!m) {
    fel.push(
      `R2 ${APP_MODULE} — BullModule sätter inte maxStalledCount uttryckligen. Då gäller ` +
        "bulls default 1, och ett jobb dör permanent vid sitt ANDRA stall någonsin — förbi " +
        'attempts och backoff. stalledCounter nollställs aldrig, så talet är en ' +
        'livstidsbudget per jobb. Frånvaron ser ut som ett val; den är det inte.',
    )
  }

  // ── R3 + R4 ───────────────────────────────────────────────────────────────
  // Attempts härleds UR KODEN, inte ur en lista här. Läggs en kö till med ett
  // lägre attempts blir vakten röd utan att någon behöver komma ihåg den.
  const attempts = []
  for (const { rel, text } of producenter) {
    const kod = codeMask(text)
    for (const träff of kod.matchAll(/attempts\s*:\s*(\d+)/g)) {
      attempts.push({ rel, värde: Number(träff[1]) })
    }
  }

  if (producenter.length < MIN_PRODUCENTER) {
    fel.push(
      `R4 — bara ${producenter.length} köproducenter hittades (tröskel ${MIN_PRODUCENTER}). ` +
        'Härledningen i R3 mäter då ingenting och skulle vara grön av tomhet. Har filerna ' +
        'bytt namnmönster ska mängden härledas på ett annat sätt, inte tystna.',
    )
  }
  if (attempts.length < MIN_ATTEMPTS_VÄRDEN) {
    fel.push(
      `R4 — bara ${attempts.length} attempts-värden hittades (tröskel ${MIN_ATTEMPTS_VÄRDEN}) ` +
        `i ${producenter.length} producenter. Se R4 ovan: en tom härledning är inte ett svar.`,
    )
  }

  let minsta = null
  if (attempts.length >= MIN_ATTEMPTS_VÄRDEN && m) {
    minsta = Math.min(...attempts.map((a) => a.värde))
    const satt = Number(m[1])
    if (satt !== minsta) {
      const lägst = attempts.filter((a) => a.värde === minsta).map((a) => a.rel)
      fel.push(
        `R3 ${APP_MODULE} — maxStalledCount är ${satt} men minsta attempts är ${minsta} ` +
          `(${[...new Set(lägst)].join(', ')}). settings är GLOBAL för alla köer, så ett ` +
          'högre tal ger någon kö en stall-budget som överstiger dess felbudget, och ett ' +
          'lägre tal ger den en mindre budget för avbrott än för fel. Följ minimum.',
      )
    }
  }

  return {
    fel,
    mätt: {
      producenter: producenter.length,
      attemptsVärden: attempts.length,
      minstaAttempts: minsta,
      maxStalledCount: m ? Number(m[1]) : null,
    },
  }
}

function läs(rel) {
  return readFileSync(join(ROT, rel), 'utf8')
}

/** Varje `*.queue.ts` under apps/api/src som inte är en spec. */
function allaProducenter() {
  const ut = []
  const stack = [join(ROT, PRODUCENT_ROT)]
  while (stack.length) {
    const d = stack.pop()
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) stack.push(p)
      else if (/\.queue\.ts$/.test(n) && !/\.spec\.ts$/.test(n)) {
        ut.push({ rel: relative(ROT, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') })
      }
    }
  }
  return ut
}

function frånDisk() {
  return { mainTs: läs(MAIN), appModuleTs: läs(APP_MODULE), producenter: allaProducenter() }
}

function självtest() {
  const fel = []
  const bas = frånDisk()
  const grund = evaluate(bas)
  if (grund.fel.length) fel.push(`baslinjen är inte grön:\n    ${grund.fel.join('\n    ')}`)

  const kräv = (namn, resultat, regel) => {
    if (!resultat.fel.some((f) => f.startsWith(regel))) {
      fel.push(`${namn}: ${regel} föll inte. Utfall: ${JSON.stringify(resultat.fel)}`)
    }
  }

  // KANARIE A — raden borta.
  kräv(
    'KANARIE A (enableShutdownHooks borttagen)',
    evaluate({ ...bas, mainTs: bas.mainTs.replaceAll('app.enableShutdownHooks()', 'const ZZSOND_SAKNAS = 1') }),
    'R1',
  )

  // KANARIE B — raden EFTER app.listen. Ordningen ska mätas, inte bara närvaron.
  kräv(
    'KANARIE B (hooken efter app.listen)',
    evaluate({
      ...bas,
      mainTs:
        "async function b() {\n  const ZZSOND_EFTER = 1\n  await app.listen(port, '0.0.0.0')\n  app.enableShutdownHooks()\n}\n",
    }),
    'R1',
  )

  // KANARIE C — raden bara i en KOMMENTAR. Den förbehandlingsfälla som gjorde
  // en annan vakt grön om en hel fil: en kontroll som inte kan kommentarer
  // mäter sin egen tolkning av källan, inte källan.
  kräv(
    'KANARIE C (hooken bara i en kommentar)',
    evaluate({
      ...bas,
      mainTs: "async function b() {\n  // ZZSOND_KOMMENTAR: app.enableShutdownHooks()\n  await app.listen(port)\n}\n",
    }),
    'R1',
  )

  // KANARIE D — raden bara i en STRÄNG, och strängen står efter en regex-literal
  // med citattecken. Det är exakt mönstret som blankade 11 629 tecken i #567.
  kräv(
    'KANARIE D (hooken bara i en sträng, efter en regex med citattecken)',
    evaluate({
      ...bas,
      mainTs:
        'async function b() {\n' +
        "  const s = x.replace(/\"/g, '&quot;')\n" +
        "  const ZZSOND_STRANG = 'app.enableShutdownHooks()'\n" +
        '  await app.listen(port)\n}\n',
    }),
    'R1',
  )

  // KANARIE E — maxStalledCount borta.
  kräv(
    'KANARIE E (maxStalledCount borttagen)',
    evaluate({ ...bas, appModuleTs: bas.appModuleTs.replace(/maxStalledCount\s*:\s*\d+/, 'redisMock: 1') }),
    'R2',
  )

  // KANARIE F — maxStalledCount bara i en kommentar. Prosan om den finns kvar
  // i app.module.ts även när inställningen tas bort; den får inte räknas.
  kräv(
    'KANARIE F (maxStalledCount bara i prosa)',
    evaluate({ ...bas, appModuleTs: '// maxStalledCount: 3 står bara i den här kommentaren\nconst a = 1\n' }),
    'R2',
  )

  // KANARIE G — fel tal. R3 ska fälla när talet glider från minsta attempts.
  kräv(
    'KANARIE G (maxStalledCount ≠ minsta attempts)',
    evaluate({ ...bas, appModuleTs: bas.appModuleTs.replace(/maxStalledCount\s*:\s*\d+/, 'maxStalledCount: 99') }),
    'R3',
  )

  // KANARIE H — tom producentmängd. Utan R4 hade R3 varit GRÖN här, vilket är
  // det tysta läget: härledningen slutar mäta utan att sluta vara grön.
  {
    const tom = evaluate({ ...bas, producenter: [] })
    if (!tom.fel.some((f) => f.startsWith('R4'))) {
      fel.push(`KANARIE H: R4 föll inte på tom producentmängd. Utfall: ${JSON.stringify(tom.fel)}`)
    }
    if (tom.fel.some((f) => f.startsWith('R3'))) {
      fel.push('KANARIE H: R3 fällde på tom mängd — den ska tiga och låta R4 tala.')
    }
  }

  // KANARIE I — den delade skannern klarar de mönster som bevisligen lurat oss.
  // Bryts den blir DEN HÄR vakten röd, inte bara source-scan.mjs egen körning.
  for (const f of kanariefåglar()) fel.push(`KANARIE I delad skanner: ${f}`)

  if (fel.length) {
    console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    `SJÄLVTEST GRÖNT — ${grund.mätt.producenter} köproducenter, ` +
      `${grund.mätt.attemptsVärden} attempts-värden, minsta ${grund.mätt.minstaAttempts}, ` +
      `maxStalledCount ${grund.mätt.maxStalledCount}. 8 egna kanariefåglar prövade, ` +
      'plus den delade skannerns 7.',
  )
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-graceful-shutdown.mjs') ?? false
if (!KÖRS_DIREKT) {
  // importerad — kör ingenting
} else if (process.argv.includes('--self-test')) självtest()
else {
  const { fel, mätt } = evaluate(frånDisk())
  if (fel.length) {
    console.error('Nedstängningen är inte längre en nedstängning:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    `Graceful shutdown är kopplad — enableShutdownHooks() före app.listen, ` +
      `maxStalledCount ${mätt.maxStalledCount} = minsta attempts över ` +
      `${mätt.producenter} köproducenter (${mätt.attemptsVärden} värden).`,
  )
}
