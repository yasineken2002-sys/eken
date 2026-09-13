#!/usr/bin/env node
/**
 * CI-guard — DRIFTPAUSEN måste nå VARJE automatisk konsument, och inventeringen
 * måste vara härledd.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * Pausen är strukturell: en @Processor-klass som inte står i sin moduls
 * `providers` kan inte plocka ett jobb, eftersom `BullExplorer.onModuleInit`
 * bara anropar `queue.process(...)` för providers den hittar. Styrkan är också
 * svagheten — en TOLFTE konsument som läggs till på vanligt sätt hamnar utanför
 * grinden, och ingenting blir rött. Den konsumenten hade sedan kört vidare
 * genom ett underhållsfönster som alla trodde var pausat.
 *
 * Samma sak åt andra hållet i `queue-inventory.ts`: en kö som registreras i
 * koden men saknas i inventeringen gör att driftverktyget rapporterar en paus
 * som ser fullständig ut men inte är det.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 *   R1  Varje @Processor-klass HÄRLEDD UR KODEN når `pausedUnless(<Klass>)`.
 *       Härledningen är poängen: en handskriven lista missar nästa konsument.
 *   R2  ÅT ANDRA HÅLLET: varje `pausedUnless(X)` motsvarar en @Processor-klass
 *       som finns. En grind kring något som inte längre är en konsument är inte
 *       en kontroll, den är en vilseledning.
 *   R3  `app.module.ts` registrerar ScheduleModule GENOM `schedulerShouldRegister(`
 *       och har ingen ogrindad `ScheduleModule.forRoot()`. Villkoret bor i en
 *       funktion just för att det ska gå att prova; skrivs det tillbaka inline
 *       kan inget prov nå det (modulen går inte att importera i jest).
 *   R4  `queue-inventory.ts` räknar upp exakt de könamns-konstanter som
 *       `BullModule.registerQueue({ name: X })` använder — i båda riktningarna.
 *   R5  KANARIEFÅGELN: härledningarna måste ha MÄTT något. Hittar skanningen
 *       noll processorer eller noll registerQueue-namn är R1–R4 gröna av tomhet,
 *       vilket är det utfall den här familjen av vakter oftast har fallit på.
 *
 * ── EN VY PER FRÅGA ─────────────────────────────────────────────────────────
 *
 * Allt läses via `codeMask` (kommentarer och stränginnehåll blankade, positioner
 * bevarade). Skälet är mätt i systerguarderna: med råtext kan en KOMMENTAR som
 * nämner `pausedUnless(Psd2SyncWorker)` uppfylla R1 — alltså kan en vakt mot
 * "en konsument utanför grinden" bli grön av prosa som PÅSTÅR att grinden finns.
 * Inga strängar behöver läsas här: både klassnamnen och könamns-konstanterna är
 * identifierare, inte litteraler.
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const SRC = 'apps/api/src'
const APP_MODULE = 'apps/api/src/app.module.ts'
const INVENTERING = 'apps/api/src/common/ops/queue-inventory.ts'

/** Under dessa tal mäter härledningarna ingenting — se R5. */
const MIN_PROCESSORER = 8
const MIN_KONAMN = 8

function samlaFiler(dir, ut = []) {
  for (const namn of readdirSync(dir)) {
    const p = join(dir, namn)
    if (statSync(p).isDirectory()) samlaFiler(p, ut)
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) ut.push(p)
  }
  return ut
}

/**
 * @param {{filer: Array<{rel: string, kod: string}>, appModuleKod: string, inventeringKod: string}} källor
 */
export function evaluate({ filer, appModuleKod, inventeringKod }) {
  const fel = []

  // ── Härledningarna ────────────────────────────────────────────────────────
  // @Processor(...) följt av valfria dekoratorer och sedan `class <Namn>`.
  const processorer = []
  const grindade = new Set()
  const registrerade = new Set()

  for (const { rel, kod } of filer) {
    for (const m of kod.matchAll(/@Processor\s*\([^)]*\)[\s\S]{0,400}?\bclass\s+([A-Za-z0-9_$]+)/g)) {
      processorer.push({ rel, klass: m[1] })
    }
    for (const m of kod.matchAll(/\bpausedUnless\s*\(\s*([A-Za-z0-9_$]+)/g)) grindade.add(m[1])
    for (const m of kod.matchAll(/registerQueue\s*\(([\s\S]{0,400}?)\)/g)) {
      for (const n of m[1].matchAll(/name\s*:\s*([A-Za-z0-9_$]+)/g)) registrerade.add(n[1])
    }
  }

  const inventerade = new Set()
  for (const m of inventeringKod.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
    for (const del of m[1].split(',')) {
      const namn = del.trim()
      if (namn) inventerade.add(namn)
    }
  }

  // ── R5 först: en tom härledning ska tala, inte tiga ───────────────────────
  if (processorer.length < MIN_PROCESSORER) {
    fel.push(
      `R5 — bara ${processorer.length} @Processor-klasser hittades (tröskel ${MIN_PROCESSORER}). ` +
        'R1/R2 mäter då ingenting och skulle vara gröna av tomhet. Har filerna bytt form ' +
        'ska mängden härledas på ett annat sätt, inte tystna.',
    )
  }
  if (registrerade.size < MIN_KONAMN) {
    fel.push(
      `R5 — bara ${registrerade.size} registerQueue-namn hittades (tröskel ${MIN_KONAMN}). ` +
        'Se R5 ovan: en tom härledning är inte ett svar.',
    )
  }

  // ── R1 ────────────────────────────────────────────────────────────────────
  for (const { rel, klass } of processorer) {
    if (!grindade.has(klass)) {
      fel.push(
        `R1 ${rel} — konsumenten ${klass} når inte driftpausens grind. Lägg den i sin moduls ` +
          '`providers` som `...pausedUnless(' +
          klass +
          ')`. Utan det registreras den även i pausat läge, och BullExplorer ' +
          'kopplar in queue.process() — alltså konsumtion mitt i ett underhållsfönster.',
      )
    }
  }

  // ── R2 ────────────────────────────────────────────────────────────────────
  const klassnamn = new Set(processorer.map((p) => p.klass))
  for (const namn of grindade) {
    if (!klassnamn.has(namn)) {
      fel.push(
        `R2 — pausedUnless(${namn}) grindar något som inte är en @Processor-klass. Antingen ` +
          'har konsumenten tagits bort och grinden blivit kvar, eller så grindas fel sak. ' +
          'En grind som inte skyddar något ser ut som skydd.',
      )
    }
  }

  // ── R3 ────────────────────────────────────────────────────────────────────
  if (!appModuleKod.includes('schedulerShouldRegister(')) {
    fel.push(
      `R3 ${APP_MODULE} — registrerar inte ScheduleModule genom schedulerShouldRegister(). ` +
        'Villkoret bor i en funktion just för att det ska gå att PRÖVA: app.module.ts går ' +
        'inte att importera i jest (grafen drar in @aws-sdk/client-s3 → ESM), så ett inline ' +
        'villkor kan bara provas genom att skrivas av — och en avskrift som glider isär ger ' +
        'ett grönt prov över en produktion som startar cron i pausat läge.',
    )
  }
  const schemaTräffar = [...appModuleKod.matchAll(/ScheduleModule\.forRoot\s*\(/g)]
  if (schemaTräffar.length !== 1) {
    fel.push(
      `R3 ${APP_MODULE} — hittade ${schemaTräffar.length} ScheduleModule.forRoot(-anrop, ` +
        'förväntade exakt ett. Fler än ett betyder att minst ett kan stå utanför grinden; ' +
        'noll betyder att regeln inte längre mäter det den tror.',
    )
  } else {
    // Grinden ska stå FÖRE anropet i samma uttryck. Står den efter, eller inte
    // alls, registreras modulen villkorslöst.
    const grindPos = appModuleKod.indexOf('schedulerShouldRegister(')
    if (grindPos === -1 || grindPos > schemaTräffar[0].index) {
      fel.push(
        `R3 ${APP_MODULE} — ScheduleModule.forRoot() står inte innanför grinden ` +
          'schedulerShouldRegister(...). Ordningen är lastbärande: efter anropet grindar den ' +
          'ingenting.',
      )
    }
  }

  // ── R4 ────────────────────────────────────────────────────────────────────
  for (const namn of registrerade) {
    if (!inventerade.has(namn)) {
      fel.push(
        `R4 ${INVENTERING} — könamnet ${namn} registreras i koden men saknas i ` +
          'inventeringen. Driftverktyget skulle då pausa en delmängd och rapportera den som ' +
          'hel — den farligaste formen av falskt lugn i just den operationen.',
      )
    }
  }
  for (const namn of inventerade) {
    // Bara könamns-konstanter jämförs; inventeringen importerar inget annat.
    if (!registrerade.has(namn)) {
      fel.push(
        `R4 ${INVENTERING} — ${namn} står i inventeringen men registreras inte som kö i ` +
          'koden. En post som överlevt sin kö är inte en kontroll, den är en ursäkt.',
      )
    }
  }

  return {
    fel,
    mätt: {
      processorer: processorer.length,
      grindade: grindade.size,
      könamn: registrerade.size,
      inventerade: inventerade.size,
    },
  }
}

function frånDisk() {
  const filer = samlaFiler(join(ROT, SRC)).map((p) => ({
    rel: relative(ROT, p),
    kod: codeMask(readFileSync(p, 'utf8')),
  }))
  return {
    filer,
    appModuleKod: codeMask(readFileSync(join(ROT, APP_MODULE), 'utf8')),
    inventeringKod: codeMask(readFileSync(join(ROT, INVENTERING), 'utf8')),
  }
}

function självtest() {
  const fel = []
  const grund = frånDisk()

  const grönt = evaluate(grund)
  if (grönt.fel.length) {
    fel.push(`KANARIE 0: nuläget är inte grönt — ${JSON.stringify(grönt.fel)}`)
  }

  // KANARIE A — en ogrindad konsument måste fälla R1.
  {
    const utan = {
      ...grund,
      filer: [
        ...grund.filer,
        { rel: 'syntetisk/ny.worker.ts', kod: '@Processor(Q)\nclass HeltNyWorker {}\n' },
      ],
    }
    if (!evaluate(utan).fel.some((f) => f.startsWith('R1'))) {
      fel.push('KANARIE A: R1 fällde inte på en konsument utanför grinden.')
    }
  }

  // KANARIE B — en grind runt något som inte är en konsument måste fälla R2.
  {
    const spöke = {
      ...grund,
      filer: [
        ...grund.filer,
        { rel: 'syntetisk/spoke.module.ts', kod: 'providers: [...pausedUnless(BorttagenWorker)]' },
      ],
    }
    if (!evaluate(spöke).fel.some((f) => f.startsWith('R2'))) {
      fel.push('KANARIE B: R2 fällde inte på en grind utan konsument.')
    }
  }

  // KANARIE C — en ogrindad ScheduleModule.forRoot() måste fälla R3.
  {
    const inline = {
      ...grund,
      appModuleKod: 'imports: [ScheduleModule.forRoot()]',
    }
    if (!evaluate(inline).fel.some((f) => f.startsWith('R3'))) {
      fel.push('KANARIE C: R3 fällde inte på en ogrindad ScheduleModule.forRoot().')
    }
  }

  // KANARIE D — grinden EFTER anropet ska också fälla R3 (ordningen bär).
  {
    const felordning = {
      ...grund,
      appModuleKod: 'imports: [ScheduleModule.forRoot()] // schedulerShouldRegister(x)',
    }
    // Kommentaren är redan blankad av codeMask i verkligheten; här matas rå
    // text in med flit, för att pröva ORDNINGSREGELN och inte maskeringen.
    if (!evaluate(felordning).fel.some((f) => f.startsWith('R3'))) {
      fel.push('KANARIE D: R3 fällde inte när grinden står efter anropet.')
    }
  }

  // KANARIE E — en kö utanför inventeringen måste fälla R4.
  {
    const extra = {
      ...grund,
      filer: [
        ...grund.filer,
        { rel: 'syntetisk/ny.module.ts', kod: 'BullModule.registerQueue({ name: NY_KO_QUEUE })' },
      ],
    }
    if (!evaluate(extra).fel.some((f) => f.startsWith('R4'))) {
      fel.push('KANARIE E: R4 fällde inte på en kö utanför inventeringen.')
    }
  }

  // KANARIE F — en inventeringspost utan kö måste fälla R4 åt andra hållet.
  {
    const kvarglömd = {
      ...grund,
      inventeringKod: grund.inventeringKod + "\nimport { AVSKAFFAD_QUEUE } from 'x'\n",
    }
    if (!evaluate(kvarglömd).fel.some((f) => f.startsWith('R4'))) {
      fel.push('KANARIE F: R4 fällde inte på en inventeringspost utan kö.')
    }
  }

  // KANARIE G — en TOM filmängd ska fälla R5, och R1/R2 ska tiga.
  {
    const tom = evaluate({ ...grund, filer: [] })
    if (!tom.fel.some((f) => f.startsWith('R5'))) {
      fel.push('KANARIE G: R5 fällde inte på tom mängd.')
    }
    if (tom.fel.some((f) => f.startsWith('R1'))) {
      fel.push('KANARIE G: R1 fällde på tom mängd — den ska tiga och låta R5 tala.')
    }
  }

  // KANARIE H — en KOMMENTAR som påstår att grinden finns får inte uppfylla R1.
  {
    const prosa = {
      ...grund,
      filer: [
        ...grund.filer,
        { rel: 'syntetisk/prosa.worker.ts', kod: '@Processor(Q)\nclass ProsaWorker {}\n' },
        {
          rel: 'syntetisk/prosa.module.ts',
          kod: codeMask('// pausedUnless(ProsaWorker) — den här raden är bara prosa\n'),
        },
      ],
    }
    if (!evaluate(prosa).fel.some((f) => f.includes('ProsaWorker'))) {
      fel.push('KANARIE H: R1 uppfylldes av en KOMMENTAR som påstår att grinden finns.')
    }
  }

  // KANARIE I — den delade skannern klarar de mönster som bevisligen lurat oss.
  for (const f of kanariefåglar()) fel.push(`KANARIE I delad skanner: ${f}`)

  if (fel.length) {
    console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    `SJÄLVTEST GRÖNT — ${grönt.mätt.processorer} @Processor-klasser, ` +
      `${grönt.mätt.grindade} grindade, ${grönt.mätt.könamn} könamn, ` +
      `${grönt.mätt.inventerade} inventerade. 8 egna kanariefåglar prövade, ` +
      'plus den delade skannerns 7.',
  )
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-automation-pause.mjs') ?? false
if (!KÖRS_DIREKT) {
  // importerad — kör ingenting
} else if (process.argv.includes('--self-test')) självtest()
else {
  const { fel, mätt } = evaluate(frånDisk())
  if (fel.length) {
    console.error('Driftpausen når inte allt den påstår:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    `Driftpausen är påkopplad — ${mätt.processorer} @Processor-klasser, alla bakom ` +
      `pausedUnless; ScheduleModule.forRoot() innanför schedulerShouldRegister; ` +
      `${mätt.könamn} könamn inventerade i båda riktningarna.`,
  )
}
