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
 *   R3  Schemaläggaren registreras på EXAKT ett ställe och i EXAKT en form.
 *       R3-validate  `app.module.ts` har `validate: validateEnv`.
 *       R3-form      grinduttrycket är ordagrant
 *                    `...(schedulerShouldRegister(process.env) ? [ScheduleModule.forRoot()] : [])`
 *                    — själva UTTRYCKET, inte ordningen mellan två textträffar.
 *                    Regeln frågade tidigare bara om `schedulerShouldRegister(`
 *                    stod före anropet, och en VÄND grind uppfyllde det.
 *       R3-utanför   noll `ScheduleModule.forRoot(` i någon annan fil. R3 läste
 *                    tidigare bara app.module.ts, så ett andra anrop i en
 *                    featuremoduls `imports` var osynligt.
 *       Villkoret bor i en funktion just för att det ska gå att prova; skrivs
 *       det tillbaka inline kan inget prov nå det (modulen går inte att
 *       importera i jest).
 *   R4  Den EXPORTERADE listan `ALLA_KONAMN` i `queue-inventory.ts` räknar upp
 *       exakt de könamns-konstanter som `BullModule.registerQueue({ name: X })`
 *       använder — i båda riktningarna, utan dubbletter.
 *       R4-form läser listans medlemmar OCH efterledet efter arrayens `]`; en
 *       form den inte kan räkna om är ett fel och aldrig en tom mängd. Regeln
 *       läste tidigare filens IMPORTNAMN, och en tömd lista med oförändrade
 *       importer gav därför `inventerade: 11` och `fel: []`. Den läste därefter
 *       bara arrayen, så `].sort().slice(0, 4)` exporterade fyra namn medan
 *       vakten fortfarande räknade elva. Enda tillåtna efterledet är `.sort()`
 *       utan argument.
 *   R5  KANARIEFÅGELN: härledningarna måste ha MÄTT något. Hittar skanningen
 *       noll processorer eller noll registerQueue-namn är R1–R4 gröna av tomhet,
 *       vilket är det utfall den här familjen av vakter oftast har fallit på.
 *   R6  `.env.example` får INTE bära en aktiv `OPS_AUTOMATION_PAUSED=true`-rad.
 *       Regeln kom ur ett granskningsfynd: källkontrollen i `validateEnv` fäller
 *       boot när `.env` ger ett ANNAT pausbeslut än processmiljön — och
 *       `cp .env.example .env` är det dokumenterade onboarding-steget. En rad
 *       menad som dokumentation hade alltså brutit uppstarten för varje ny
 *       utvecklare, i ett läge där ingenting var pausat.
 *
 *       `=false` fäller INTE: det ger samma beslut som en osatt variabel och kan
 *       per konstruktion inte ge ett splittrat tillstånd. Regeln ska vara sann,
 *       inte bara sträng.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Skrivet efter en oberoende granskning, och avsiktligt utförligt: en vakt som
 * inte säger var den slutar läses som om den täckte allt.
 *
 *  • ANDRA VÄGAR ATT STARTA CRON. R3 äger `ScheduleModule.forRoot(`, som är
 *    @nestjs/schedule:s enda inkopplingspunkt — utan den registreras ingen
 *    @Cron/@Interval alls. Den ser INTE en `SchedulerRegistry` som används
 *    direkt för att lägga till ett jobb i runtime, och den läser inte ett
 *    `forRoot` som nås genom en variabel eller en dynamisk import. Den läser
 *    heller inte bara `ScheduleModule` i en `imports`-array utan `forRoot` —
 *    den formen registrerar ingen schemaläggare, men om @nestjs/schedule ändrar
 *    det är regeln blind för ändringen.
 *
 *  • LIVSCYKEL-HOOKAR. Vakten härleder @Processor, ScheduleModule.forRoot och
 *    registerQueue — ingenting annat. En TOLFTE startväg i form av en ny
 *    `onApplicationBootstrap` som skickar ett mejl eller bokför blir INTE röd
 *    här, precis som `DepositsService` inte hade blivit det. Den enda skrivande
 *    hooken i dag är grindad och mätt i
 *    `apps/api/src/deposits/deposits-uppstartspaus.spec.ts`, men det är ett prov
 *    över en känd hook, inte en härledning över alla framtida.
 *
 *  • KÖNAMN SOM INTE ÄR IDENTIFIERARE. R4 läser `name: <identifierare>` och
 *    kräver att `ALLA_KONAMN` bara innehåller identifierare. En kö registrerad
 *    med en strängliteral (`{ name: 'ny-ko' }`), ett mallsträngsnamn,
 *    `registerQueueAsync` eller en spridd array syns inte.
 *    Grinden själv håller ändå — R1 härleder @Processor-klasser oberoende av
 *    könamnets form — men driftverktygets INVENTERING skulle sakna kön. Ett
 *    delvis mothåll finns i verktyget: en sådan kö dyker upp i `okandaIRedis`
 *    så snart den har nycklar i Redis.
 *
 *  • VAR namnet står. R1/R2 jämför NAMNMÄNGDER över alla filer, inte varje
 *    enskild registrering. `providers: [X, ...pausedUnless(X)]` är grönt här och
 *    registrerar ändå konsumenten.
 *
 *  • MÖNSTRETS FÖNSTER. `@Processor`-härledningen tillåter 400 tecken mellan
 *    dekoratorn och `class`. En klass med mer däremellan faller UR mängden — och
 *    en klass som inte härleds kan heller inte saknas i grinden. Det är skälet
 *    att R5 numera kräver PARITET mot en parserfri räkning av `@Processor(` och
 *    inte bara ett golv; uppmätt avstånd i dag är 8 tecken i samtliga elva fall.
 *
 *  • ATT GRINDEN GÖR NÅGOT. Vakten äger PÅKOPPLINGEN. Effekten är mätt i
 *    `common/ops/automation-pause-startup.spec.ts` (riktigt Nest-startförlopp)
 *    och `common/ops/automation-pause-queue.db.spec.ts` (riktig Bull mot riktig
 *    Redis). Var för sig är båda den defekt vi jagat: ett prov utan påkoppling,
 *    och en vakt som bevakar en sträng ingen prövat effekten av.
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
import { blankComments, codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const SRC = 'apps/api/src'
const APP_MODULE = 'apps/api/src/app.module.ts'
const INVENTERING = 'apps/api/src/common/ops/queue-inventory.ts'
const ENV_EXEMPEL = 'apps/api/.env.example'
const PAUSVARIABEL = 'OPS_AUTOMATION_PAUSED'

/**
 * IDENTIFIERARE ÄR INTE ASCII I DET HÄR REPOT — och det är inte en teoretisk
 * invändning. `ai-assignments.service.ts` har ett @Cron som heter `utgångspass`,
 * och `actor-null-sweep.service.ts` ett som heter `sveep`. Ett klassnamn eller en
 * könamns-konstant med å/ä/ö är alltså fullt normalt här.
 *
 * Med `[A-Za-z0-9_$]+` hade `class PåminnelseWorker` fångats som `P`, och `\b`
 * hade dragit en ordgräns mitt i ordet. Vakten hade då jämfört stympade namn mot
 * stympade namn — ibland av en slump grönt, ibland rött på ett namn som inte
 * finns. Båda utfallen är värdelösa.
 *
 * `\p{L}` med `u`-flaggan, och en negativ lookbehind i stället för `\b`, täcker
 * allt `\b` täckte plus de svenska namnen. Samma regel som
 * `apps/api/scripts/check-identifier-regex.mjs` kräver av alla vakter, och den
 * fällde de här tre mönstren i sin första form.
 */
const ID = String.raw`[\p{L}\p{N}_$]`
const EJ_ID_FORE = String.raw`(?<![\p{L}\p{N}_$])`

const PROCESSOR_RE = new RegExp(
  String.raw`@Processor\s*\([^)]*\)[\s\S]{0,400}?${EJ_ID_FORE}class\s+(${ID}+)`,
  'gu',
)
const GRIND_RE = new RegExp(String.raw`${EJ_ID_FORE}pausedUnless\s*\(\s*(${ID}+)`, 'gu')
const KONAMN_RE = new RegExp(String.raw`name\s*:\s*(${ID}+)`, 'gu')

/** Varje registreringsväg för schemaläggaren. Se R3 och filens gränsavsnitt. */
const SCHEMA_RE = /ScheduleModule\s*\.\s*forRoot\s*\(/g

/**
 * ── VARFÖR NAMNET SJÄLVT MÅSTE GRINDAS ──────────────────────────────────────
 *
 * `SCHEMA_RE` kräver punktnotation och det ordagranna namnet `ScheduleModule`.
 * En oberoende granskare visade att det inte räcker. Uppmätt mot verkliga
 * `evaluate`, med repots riktiga källor i övrigt:
 *
 *   import { ScheduleModule as S } … imports: [S.forRoot()]    →  fel: []
 *   imports: [ScheduleModule['forRoot']()]                     →  fel: []
 *
 * Båda registrerar schemaläggaren ogrindat, och båda var GRÖNA. Att jaga varje
 * anropsform är en kapplöpning vakten inte kan vinna — men NAMNET går inte att
 * komma runt: `ScheduleModule` måste importeras från `@nestjs/schedule` för att
 * kunna anropas alls, i vilken form som helst.
 *
 * Därför flyttas grinden ett steg tillbaka: BINDNINGEN `ScheduleModule` får bara
 * importeras i `app.module.ts`. Övriga bindningar (`Cron`, `CronExpression`,
 * `SchedulerRegistry`) är fria — 25 filer använder dem, och de registrerar
 * ingenting i sig. Uppmätt i dag: exakt en fil importerar `ScheduleModule`.
 *
 * En importform vakten inte kan läsa medlemsvis — namnrymdsimport, default,
 * `require`, en lös sträng — blir ett granskningskrävande fel. Fail-closed:
 * den formen kan bära namnet utan att visa det.
 */
const SCHEDULE_PAKET = '@nestjs/schedule'
const SCHEDULE_NAMNIMPORT_RE =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@nestjs\/schedule['"]/g
const SCHEDULE_FOREKOMST_RE = /@nestjs\/schedule/g

/** `ScheduleModule[...]` — beräknad medlemsåtkomst göms för SCHEMA_RE. */
const SCHEMA_BERAKNAD_RE = /ScheduleModule\s*\[/

/**
 * DEN EXAKTA GRINDFORMEN, och ingen annan.
 *
 * Fyndet: R3 frågade tidigare tre skilda saker — att strängen
 * `schedulerShouldRegister(` fanns någonstans, att `ScheduleModule.forRoot(`
 * fanns exakt en gång, och att den första stod FÖRE den andra. Alla tre var
 * sanna för
 *
 *     ...(!schedulerShouldRegister(process.env) ? [ScheduleModule.forRoot()] : [])
 *
 * alltså för en VÄND grind, som registrerar cron precis när pausen är påslagen.
 * Uppmätt: `fel: []`.
 *
 * Ordningen mellan två textträffar är alltså inte grinden. Mönstret nedan är
 * hela uttrycket: spridningen, anropet UTAN operator framför sig, frågetecknet,
 * den registrerande grenen och den TOMMA alternativa grenen. `process.env`
 * ingår med flit — en grind som läser något annat än processmiljön mäter inte
 * den miljö appen startar i.
 *
 * Varje annan form är OKÄND, och en okänd form blir ett granskningskrävande fel
 * i stället för grönt genom gissning. Det är avsiktligt strängt: filen kan inte
 * importeras i jest (grafen drar in @aws-sdk/client-s3 → ESM), så den här vakten
 * är det enda som läser produktionens inkoppling.
 */
const GRIND_FORM_RE = new RegExp(
  String.raw`\.\.\.\(\s*schedulerShouldRegister\s*\(\s*process\s*\.\s*env\s*\)\s*\?` +
    String.raw`\s*\[\s*ScheduleModule\s*\.\s*forRoot\s*\([^()]*\)\s*\]\s*:\s*\[\s*\]\s*\)`,
)

/** `export const ALLA_KONAMN … = [` — listan driftverktyget FAKTISKT använder. */
// Ordgränsen bär: utan den matchar `export const ALLA_KONAMN_GAMLA = [...]`
// först och vakten läser fel deklaration. Funnet av en granskare.
const LISTA_RE = new RegExp(String.raw`export\s+const\s+ALLA_KONAMN(?!${ID})[^=]*=\s*\[`, 'u')

/**
 * Vad som får stå EFTER arrayens `]` i samma initializer. Se
 * `läsInventeringslistan` för de tre mutationer som gjorde regeln nödvändig.
 * `as const` tillåts därför att den är rent typnivå. Kommentarer är redan
 * blankade till mellanslag av `codeMask` och fångas av `\s*`.
 */
const EFTERLED_RE = /^\s*(?:\.sort\(\s*\))?\s*(?:as\s+const\b)?\s*;?\s*(?:\r?\n|$)/

/**
 * Läser den EXPORTERADE listans medlemmar, inte inventeringsfilens importrad.
 *
 * Fyndet: R4 läste `import { … }`-namnen. En TOM exporterad lista med
 * oförändrade importer gav därför `inventerade: 11` och `fel: []` — vakten
 * intygade en inventering som verktyget inte hade. Att `queue-ops.spec.ts` har
 * ett hårdkodat längdprov som råkar fånga just den tomma listan gör inte
 * vaktens påstående sant; den mätte fel sak.
 *
 * Returnerar `{ poster }` eller `{ fel }`. En form vi inte kan läsa medlemsvis
 * blir ett fel — aldrig en tom mängd, som hade tystat båda R4-riktningarna.
 */
function läsInventeringslistan(kod) {
  const start = LISTA_RE.exec(kod)
  if (!start) {
    return {
      fel:
        `hittade ingen \`export const ALLA_KONAMN … = [\`-deklaration. Vakten kan då inte ` +
        'jämföra registreringarna mot den lista driftverktyget använder, och R4 skulle vara ' +
        'grön av att den slutat läsa. Byter filen form ska mängden härledas på ett annat ' +
        'sätt — inte tystna.',
    }
  }
  let i = start.index + start[0].length
  let djup = 1
  while (i < kod.length && djup > 0) {
    if (kod[i] === '[') djup += 1
    else if (kod[i] === ']') djup -= 1
    i += 1
  }
  if (djup !== 0) {
    return { fel: 'ALLA_KONAMN-arrayen avslutas aldrig — källan går inte att läsa medlemsvis.' }
  }
  // ── EFTERLEDET ÄR OCKSÅ EN DEL AV MÄNGDEN ─────────────────────────────────
  //
  // Läsningen stannade tidigare vid arrayens `]` och returnerade dess poster.
  // Allt som stod EFTER arrayen i samma initializer var osynligt, och det är en
  // öppning för godtycklig efterbearbetning. Tre minnesmutationer från
  // granskningen, med repots övriga källor oförändrade:
  //
  //   ].sort().slice(0, 4)                                  faktiskt 4 namn
  //   ].filter(name => name !== QUEUE_PDF).sort()           faktiskt 10 namn
  //   ].map(name => name === QUEUE_PDF ? 'pdf-v2' : name)   PDF-kön saknas
  //
  // Alla tre gav `fel: []` och `inventerade: 11`. Den sista uppfyller dessutom
  // queue-ops.spec.ts krav på längd, unikhet och de fyra namngivna köerna — den
  // hade alltså inte fångats av mothållet på andra sidan heller.
  //
  // `.sort()` UTAN ARGUMENT är det enda tillåtna efterledet. Den kan inte ändra
  // MEDLEMMARNA, bara ordningen, och filen sorterar med flit för att utskriften
  // ska vara jämförbar mellan körningar. Varje annat efterled — inklusive
  // `.sort(jämför)`, som vi inte behöver och därför inte tillåter — är en form
  // vakten inte kan räkna om, och blir ett granskningskrävande fel.
  const efterled = kod.slice(i)
  if (!EFTERLED_RE.test(efterled)) {
    const smakprov = efterled.trim().split('\n')[0].slice(0, 60)
    return {
      fel:
        `ALLA_KONAMN-arrayen följs av ett efterled vakten inte kan räkna om ` +
        `(\`${smakprov}\`). Den exporterade mängden är då något annat än arrayens ` +
        'poster, och R4 skulle jämföra registreringarna mot en lista som inte finns. ' +
        'Enda tillåtna efterledet är `.sort()` utan argument: den ändrar ordning, aldrig ' +
        'medlemmar. Behövs en annan bearbetning ska den ske i en egen, namngiven konstant ' +
        'som vakten kan läsa för sig.',
    }
  }

  const kropp = kod.slice(start.index + start[0].length, i - 1)
  const poster = kropp
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '')
  const ENBART_ID = new RegExp(String.raw`^${ID}+$`, 'u')
  const ogiltiga = poster.filter((d) => !ENBART_ID.test(d))
  if (ogiltiga.length > 0) {
    return {
      fel:
        `ALLA_KONAMN innehåller ${ogiltiga.length} post(er) som inte är en ren identifierare ` +
        `(${ogiltiga.map((d) => JSON.stringify(d)).join(', ')}). Filen ska bära könamnens ` +
        'KONSTANTER och inga strängliteraler — en literal går inte att knyta till en ' +
        '`registerQueue({ name: X })` och skulle göra båda R4-riktningarna blinda för just ' +
        'den kön. (Stränginnehåll är blankat av codeMask, så en literal syns som tomma ' +
        'citattecken.)',
    }
  }
  return { poster }
}

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
 * @param {{utanRegel?: string}} [läge] `utanRegel` stänger av EN namngiven
 *   delregel. Används BARA av självtestets motprov: en kanariefågel som inte
 *   blir röd när den kontroll den bevakar tas bort mäter inte den kontrollen.
 *   Produktionskörningen skickar aldrig något här.
 */
/** Sökvägsformen normaliserad: `rel` kan bära `\\` eller ett `./`-prefix. */
function ärAppModule(rel) {
  return rel.split('\\').join('/').replace(/^\.\//, '') === APP_MODULE
}

/** Ligger `index` inuti regexträffen `m`? */
function inom(index, m) {
  return index >= m.index && index < m.index + m[0].length
}

export function evaluate({ filer, appModuleKod, inventeringKod, envExempel }, läge = {}) {
  const fel = []
  const aktiv = (id) => läge.utanRegel !== id

  // ── Härledningarna ────────────────────────────────────────────────────────
  // @Processor(...) följt av valfria dekoratorer och sedan `class <Namn>`.
  const processorer = []
  const grindade = new Set()
  const registrerade = new Set()

  for (const { rel, kod } of filer) {
    for (const m of kod.matchAll(PROCESSOR_RE)) {
      processorer.push({ rel, klass: m[1] })
    }
    for (const m of kod.matchAll(GRIND_RE)) grindade.add(m[1])
    for (const m of kod.matchAll(/registerQueue\s*\(([\s\S]{0,400}?)\)/g)) {
      for (const n of m[1].matchAll(KONAMN_RE)) registrerade.add(n[1])
    }
  }

  // DEN EXPORTERADE LISTAN, inte importraden. Se `läsInventeringslistan`.
  const lista = läsInventeringslistan(inventeringKod)
  const inventerade = new Set(lista.poster ?? [])
  const listDubbletter = lista.poster
    ? [...new Set(lista.poster.filter((n, i) => lista.poster.indexOf(n) !== i))]
    : []

  // ── R5 först: en tom härledning ska tala, inte tiga ───────────────────────
  if (aktiv('R5-golv-processorer') && processorer.length < MIN_PROCESSORER) {
    fel.push(
      `R5-golv-processorer — bara ${processorer.length} @Processor-klasser hittades ` +
        `(tröskel ${MIN_PROCESSORER}). ` +
        'R1/R2 mäter då ingenting och skulle vara gröna av tomhet. Har filerna bytt form ' +
        'ska mängden härledas på ett annat sätt, inte tystna.',
    )
  }
  // PARITET, inte bara ett golv. `MIN_PROCESSORER` skyddar mot tomhet, men tre av
  // elva kunde falla ur härledningen utan att någon regel sa något — mönstrets
  // fönster på 400 tecken mellan dekoratorn och `class` är en sådan väg ut.
  // En oberoende, parserfri räkning av `@Processor(` måste ge samma tal.
  const råaProcessorer = filer.reduce(
    (n, { kod }) => n + [...kod.matchAll(/@Processor\s*\(/g)].length,
    0,
  )
  if (aktiv('R5-paritet') && råaProcessorer !== processorer.length) {
    fel.push(
      `R5-paritet — den strukturerade härledningen hittade ${processorer.length} ` +
        `@Processor-klasser, ` +
        `men en parserfri räkning ger ${råaProcessorer}. Går de isär har skanningen gått ` +
        'delvis blind, och R1 blir grön på fel underlag: en processor som inte HÄRLEDS kan ' +
        'heller inte saknas i grinden. Vanligaste orsaken är att avståndet mellan @Processor ' +
        'och `class` vuxit förbi mönstrets fönster.',
    )
  }

  if (aktiv('R5-golv-könamn') && registrerade.size < MIN_KONAMN) {
    fel.push(
      `R5-golv-könamn — bara ${registrerade.size} registerQueue-namn hittades ` +
        `(tröskel ${MIN_KONAMN}). ` +
        'Se R5 ovan: en tom härledning är inte ett svar.',
    )
  }

  // ── R1 ────────────────────────────────────────────────────────────────────
  for (const { rel, klass } of aktiv('R1') ? processorer : []) {
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
  for (const namn of aktiv('R2') ? grindade : []) {
    if (!klassnamn.has(namn)) {
      fel.push(
        `R2 — pausedUnless(${namn}) grindar något som inte är en @Processor-klass. Antingen ` +
          'har konsumenten tagits bort och grinden blivit kvar, eller så grindas fel sak. ' +
          'En grind som inte skyddar något ser ut som skydd.',
      )
    }
  }

  // ── R3 ────────────────────────────────────────────────────────────────────
  // Hela halv-paus-garantin vilar på att ConfigModule faktiskt KÖR valideringen.
  // Tas `validate:`-inkopplingen bort försvinner assertAutomationPauseSource tyst
  // ur startförloppet — och startup-specens block C fortsätter vara grön, för den
  // bygger sin EGEN ConfigModule. Fyndet kom ur granskningen.
  if (aktiv('R3-validate') && !/validate\s*:\s*validateEnv/.test(appModuleKod)) {
    fel.push(
      `R3-validate ${APP_MODULE} — ConfigModule.forRoot saknar \`validate: validateEnv\`. Utan ` +
        'den körs varken boot-valideringen eller driftpausens källkontroll, och inget prov ' +
        'ser det: automation-pause-startup.spec.ts block C bygger sin egen ConfigModule.',
    )
  }

  // R3-form: GRINDUTTRYCKET självt, inte ordningen mellan två textträffar.
  const schemaTräffar = [...appModuleKod.matchAll(SCHEMA_RE)]
  const grindTräff = GRIND_FORM_RE.exec(appModuleKod)
  if (aktiv('R3-form')) {
    if (SCHEMA_BERAKNAD_RE.test(appModuleKod)) {
      fel.push(
        `R3-form ${APP_MODULE} — \`ScheduleModule[…]\` (beräknad medlemsåtkomst). Formen göms ` +
          'för varje mönster som läser `ScheduleModule.forRoot(`, och en granskare visade att ' +
          'den passerade vakten ogrindad. Skriv anropet med punktnotation, innanför grinden.',
      )
    }
    if (schemaTräffar.length !== 1) {
      fel.push(
        `R3-form ${APP_MODULE} — hittade ${schemaTräffar.length} ScheduleModule.forRoot(-anrop, ` +
          'förväntade exakt ett. Fler än ett betyder att minst ett kan stå utanför grinden; ' +
          'noll betyder att regeln inte längre mäter det den tror.',
      )
    } else if (grindTräff && !inom(schemaTräffar[0].index, grindTräff)) {
      // Att mönstret finns NÅGONSTANS i filen räcker inte: en död hjälpfunktion
      // som bär den giltiga formen hade gjort en ogrindad registrering i
      // `imports` osynlig. Anropet måste vara DET anrop grinden omsluter.
      fel.push(
        `R3-form ${APP_MODULE} — grindformen finns i filen, men ScheduleModule.forRoot()-anropet ` +
          'ligger UTANFÖR den. Grinden omsluter då något annat än den registrering appen ' +
          'faktiskt använder.',
      )
    } else if (!grindTräff) {
      fel.push(
        `R3-form ${APP_MODULE} — ScheduleModule.forRoot() står inte i den grindform vakten ` +
          'kan läsa. Den enda godtagna formen är\n' +
          '        ...(schedulerShouldRegister(process.env) ? [ScheduleModule.forRoot()] : [])\n' +
          '      Regeln frågade tidigare bara om `schedulerShouldRegister(` stod FÖRE anropet, ' +
          'och en VÄND grind — `!schedulerShouldRegister(process.env)` — uppfyllde det och ' +
          'registrerade alltså cron precis i pausat läge (uppmätt: fel: []). En form vakten ' +
          'inte känner igen är ett GRANSKNINGSKRÄVANDE fel, inte ett grönt utfall: hade den ' +
          'gissat vore gissningen hela skyddet. Ändras formen med avsikt ska mönstret ändras ' +
          'med den, av någon som läst båda.',
      )
    }
  }

  // R3-utanför: appen får bara ha EN schemaläggarregistrering, och den ska bo i
  // app.module.ts. R3 läste tidigare enbart appModuleKod, så ett extra
  // `ScheduleModule.forRoot()` i en featuremoduls `imports` var osynligt —
  // uppmätt: fel: []. En sådan registrering står per definition utanför grinden.
  if (aktiv('R3-utanför')) {
    for (const { rel, kod } of filer) {
      if (ärAppModule(rel)) continue
      const antal = [...kod.matchAll(SCHEMA_RE)].length
      if (antal > 0) {
        fel.push(
          `R3-utanför ${rel} — ${antal} ScheduleModule.forRoot(-anrop utanför ${APP_MODULE}. ` +
            'Schemaläggaren registreras då oavsett driftpausens grind, och @Cron-metoderna i ' +
            'hela appen kopplas in mitt i ett underhållsfönster. Registreringen hör hemma på ' +
            'exakt ett ställe, innanför schedulerShouldRegister(...).',
        )
      }
    }
  }

  // R3-import: SJÄLVA BINDNINGEN grindas. Se kommentaren vid SCHEDULE_PAKET —
  // `S.forRoot()` efter en alias-import och `ScheduleModule['forRoot']()` var
  // båda gröna, och ingen mönstermatchning på ANROPET kan täcka alla former.
  // Namnet går däremot inte att komma runt.
  if (aktiv('R3-import')) {
    // APP_MODULE INGÅR NUMERA. Regeln hoppade tidigare över den, och då gick
    //
    //   import { ScheduleModule, ScheduleModule as S } from '@nestjs/schedule'
    //   imports: [ ...grinden..., S.forRoot() ]
    //
    // igenom: aliaset `S` syns inte för SCHEMA_RE, och importkontrollen tittade
    // inte i filen. Påpekat som avgränsning i återgranskningen. I app.module.ts
    // får bindningen därför importeras — men BARA under sitt eget namn.
    for (const f of filer) {
      // Kommentarer blankade, STRÄNGAR KVAR: modulsökvägen är en sträng, så
      // `codeMask`-vyn kan inte svara på den här frågan. En vy per fråga.
      const text = f.text ?? f.kod
      const förekomster = [...text.matchAll(SCHEDULE_FOREKOMST_RE)].length
      if (förekomster === 0) continue
      const iAppModule = ärAppModule(f.rel)

      let lästa = 0
      for (const m of text.matchAll(SCHEDULE_NAMNIMPORT_RE)) {
        lästa += 1
        for (const del of m[1].split(',')) {
          const led = del.trim()
          if (led === '') continue
          const [rå, lokalt] = led.split(/\s+as\s+/u)
          // DEN CITERADE FORMEN NORMALISERAS. TypeScript 5.6 tillåter
          // `import { 'ScheduleModule' as S }` (godtyckliga modulnamn, ES2022),
          // och den gick rakt igenom en jämförelse mot det ociterade namnet —
          // uppmätt i återgranskningen: fel: []. Citattecknen bärs av `text`,
          // som med flit behåller strängar.
          const namn = rå.trim().replace(/^(['"`])(.*)\1$/su, '$2')
          if (namn !== 'ScheduleModule') continue

          if (!iAppModule) {
            fel.push(
              `R3-import ${f.rel} — importerar bindningen ScheduleModule från ` +
                `${SCHEDULE_PAKET}. Bara ${APP_MODULE} får göra det, och bara innanför ` +
                'driftpausens grind. Övriga bindningar (Cron, CronExpression, ' +
                'SchedulerRegistry) är fria — de registrerar ingen schemaläggare. Behövs ' +
                'modulen någon annanstans är det ett eget beslut, inte en import.',
            )
          } else if ((lokalt ?? namn).trim() !== 'ScheduleModule') {
            fel.push(
              `R3-import ${APP_MODULE} — ScheduleModule importeras under namnet ` +
                `\`${(lokalt ?? '').trim()}\`. Ett alias gör registreringen osynlig för ` +
                'R3-form och R3-utanför, som båda läser det ordagranna namnet. Bindningen ' +
                'ska heta ScheduleModule här.',
            )
          }
        }
      }
      if (lästa !== förekomster) {
        fel.push(
          `R3-import ${f.rel} — ${förekomster - lästa} förekomst(er) av ${SCHEDULE_PAKET} som ` +
            'inte är en läsbar namnimport (namnrymdsimport, default, require eller en lös ' +
            'sträng). En sådan form kan bära ScheduleModule utan att visa namnet, så den blir ' +
            'ett granskningskrävande fel i stället för ett tyst godkännande.',
        )
      }
    }
  }

  // ── R4 ────────────────────────────────────────────────────────────────────
  // Jämförelsen går mot den EXPORTERADE listan `ALLA_KONAMN`, alltså mot exakt
  // den mängd driftverktyget itererar över. Tidigare lästes importnamnen i
  // samma fil, och de två kan skilja sig: en tömd lista med oförändrade importer
  // gav `inventerade: 11` och `fel: []`.
  if (aktiv('R4-form') && lista.fel) {
    fel.push(`R4-form ${INVENTERING} — ${lista.fel}`)
  }
  if (aktiv('R4-dubblett')) {
    for (const namn of listDubbletter) {
      fel.push(
        `R4-dubblett ${INVENTERING} — ${namn} står flera gånger i ALLA_KONAMN. En dubblett ` +
          'blåser upp listans LÄNGD utan att täcka en enda extra kö, och gör varje ' +
          'längdbaserad kontroll — vaktens som verktygets — till ett falskt lugn.',
      )
    }
  }
  if (aktiv('R4-saknas')) {
    for (const namn of registrerade) {
      if (!inventerade.has(namn)) {
        fel.push(
          `R4-saknas ${INVENTERING} — könamnet ${namn} registreras i koden men saknas i ` +
            'ALLA_KONAMN. Driftverktyget skulle då pausa en delmängd och rapportera den som ' +
            'hel — den farligaste formen av falskt lugn i just den operationen. Att ' +
            'konstanten är IMPORTERAD i filen räcker inte: verktyget itererar över listan.',
        )
      }
    }
  }
  if (aktiv('R4-överbliven')) {
    for (const namn of inventerade) {
      if (!registrerade.has(namn)) {
        fel.push(
          `R4-överbliven ${INVENTERING} — ${namn} står i ALLA_KONAMN men registreras inte som ` +
            'kö i koden. En post som överlevt sin kö är inte en kontroll, den är en ursäkt.',
        )
      }
    }
  }

  // ── R6 ────────────────────────────────────────────────────────────────────
  // Rå text med flit: `.env.example` är inte TypeScript, och `#` är dess
  // kommentartecken. En aktiv rad är en rad som INTE inleds med `#`.
  const aktivaEnvRader = (envExempel ?? '')
    .split('\n')
    .map((rad, i) => ({ rad: rad.trim(), nr: i + 1 }))
    .filter(({ rad }) => !rad.startsWith('#') && rad.startsWith(`${PAUSVARIABEL}=true`))
  for (const { nr } of aktiv('R6') ? aktivaEnvRader : []) {
    fel.push(
      `R6 ${ENV_EXEMPEL}:${nr} — aktiv ${PAUSVARIABEL}=true-rad. validateEnv fäller boot när ` +
        '.env ger ett annat pausbeslut än processmiljön, och `cp .env.example .env` ' +
        'är det dokumenterade onboarding-steget — raden hade alltså brutit uppstarten för ' +
        'varje ny utvecklare, i ett läge där ingenting är pausat. Kommentera ut den; ' +
        'variabeln sätts som processmiljö.',
    )
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
  const filer = samlaFiler(join(ROT, SRC)).map((p) => {
    const rå = readFileSync(p, 'utf8')
    return {
      rel: relative(ROT, p),
      kod: codeMask(rå),
      // EN VY PER FRÅGA. `kod` blankar stränginnehåll, vilket är rätt för
      // identifierarfrågorna men gör modulsökvägar osynliga. `text` behåller
      // strängarna och blankar bara kommentarerna — R3-import läser den.
      text: blankComments(rå),
    }
  })
  return {
    filer,
    appModuleKod: codeMask(readFileSync(join(ROT, APP_MODULE), 'utf8')),
    inventeringKod: codeMask(readFileSync(join(ROT, INVENTERING), 'utf8')),
    envExempel: readFileSync(join(ROT, ENV_EXEMPEL), 'utf8'),
  }
}

/**
 * ── EN KANARIEFÅGEL SOM INTE KAN BLI RÖD AV FEL SKÄL ────────────────────────
 *
 * Varje kanariefågel nedan gör TVÅ mätningar, inte en:
 *
 *   1. mutationen måste fälla den regel kanariefågeln påstår sig bevaka, och
 *   2. MOTPROVET: med just den regeln avstängd får mutationen INTE längre fälla
 *      den — annars mäter kanariefågeln något annat än den säger.
 *
 * Skälet är mätt. Kanarie C och D godtog tidigare `f.startsWith('R3')`, alltså
 * VILKET R3-fel som helst — och deras appModule-strängar var så små att de
 * saknade `validate: validateEnv`. Båda blev därför gröna av den regeln i
 * stället för av den de skrevs för: C hade fällts även om ordningsregeln tagits
 * bort. En kanariefågel som blir grön av fel skäl är exakt den defekt hela den
 * här familjen av vakter finns för att undvika.
 *
 * @param {string} namn
 * @param {object} källor
 * @param {string} regel Regel-id, som också är felmeddelandets prefix.
 * @param {(f: string) => boolean} [extra] Extra krav på meddelandet.
 */
function kanarie(namn, källor, regel, extra = () => true) {
  const fel = []
  const träff = (f) => f.startsWith(regel) && extra(f)

  const med = evaluate(källor)
  if (!med.fel.some(träff)) {
    fel.push(
      `KANARIE ${namn}: ${regel} fällde inte på den avsedda mutationen. ` +
        `Fel som gavs: ${JSON.stringify(med.fel)}`,
    )
  }

  const utan = evaluate(källor, { utanRegel: regel })
  if (utan.fel.some(träff)) {
    fel.push(
      `KANARIE ${namn}: MOTPROVET misslyckades — mutationen fälldes även med ${regel} ` +
        'avstängd. Kanariefågeln mäter alltså inte den kontroll den påstår sig bevaka.',
    )
  }
  return fel
}

/** Motsatsen: en källa som INTE får fälla en viss regel. */
function tystKanarie(namn, källor, regel) {
  const utfall = evaluate(källor)
  return utfall.fel.some((f) => f.startsWith(regel))
    ? [`KANARIE ${namn}: ${regel} fällde på något som är korrekt — ${JSON.stringify(utfall.fel)}`]
    : []
}

/**
 * En MINIMAL men GILTIG app.module-text. Kanariefåglarna för R3 muterar exakt en
 * egenskap i den här, så att det som fäller dem är just den egenskapen och inte
 * en annan regel som råkade sakna sitt underlag.
 */
const GILTIG_APPMODULE = [
  'imports: [',
  '  ConfigModule.forRoot({ isGlobal: true, envFilePath: .env, validate: validateEnv }),',
  '  ...(schedulerShouldRegister(process.env) ? [ScheduleModule.forRoot()] : []),',
  '],',
].join('\n')

function självtest() {
  const fel = []
  const grund = frånDisk()

  const grönt = evaluate(grund)
  if (grönt.fel.length) {
    fel.push(`KANARIE 0: nuläget är inte grönt — ${JSON.stringify(grönt.fel)}`)
  }

  // KANARIE 0b — den syntetiska appModule-texten kanariefåglarna nedan muterar
  // måste själv vara GRÖN. Utan den raden kunde varje R3-kanarie nedan vara
  // grön av att grundtexten var trasig från början.
  fel.push(...tystKanarie('0b', { ...grund, appModuleKod: GILTIG_APPMODULE }, 'R3'))

  // KANARIE A — en ogrindad konsument måste fälla R1.
  fel.push(
    ...kanarie(
      'A',
      {
        ...grund,
        filer: [
          ...grund.filer,
          { rel: 'syntetisk/ny.worker.ts', kod: '@Processor(Q)\nclass HeltNyWorker {}\n' },
        ],
      },
      'R1',
      (f) => f.includes('HeltNyWorker'),
    ),
  )

  // KANARIE B — en grind runt något som inte är en konsument måste fälla R2.
  fel.push(
    ...kanarie(
      'B',
      {
        ...grund,
        filer: [
          ...grund.filer,
          { rel: 'syntetisk/spoke.module.ts', kod: 'providers: [...pausedUnless(BorttagenWorker)]' },
        ],
      },
      'R2',
      (f) => f.includes('BorttagenWorker'),
    ),
  )

  // KANARIE C — en OGRINDAD ScheduleModule.forRoot() måste fälla R3-form.
  // Grundtexten är den giltiga; ENDA skillnaden är att grinden är borta.
  fel.push(
    ...kanarie(
      'C',
      { ...grund, appModuleKod: GILTIG_APPMODULE.replace(/\.\.\.\(.*\),/, 'ScheduleModule.forRoot(),') },
      'R3-form',
    ),
  )

  // KANARIE D — grinden EFTER anropet ska också fälla R3-form (ordningen bär).
  fel.push(
    ...kanarie(
      'D',
      {
        ...grund,
        appModuleKod: GILTIG_APPMODULE.replace(
          /\.\.\.\(.*\),/,
          'ScheduleModule.forRoot(), schedulerShouldRegister(process.env),',
        ),
      },
      'R3-form',
    ),
  )

  // KANARIE M — en VÄND grind. Det här är granskningsfyndet ordagrant: den gamla
  // regeln frågade bara om `schedulerShouldRegister(` stod före anropet, och den
  // här mutationen gav `fel: []` medan den registrerar cron PRECIS i pausat läge.
  fel.push(
    ...kanarie(
      'M',
      {
        ...grund,
        appModuleKod: GILTIG_APPMODULE.replace(
          '...(schedulerShouldRegister(',
          '...(!schedulerShouldRegister(',
        ),
      },
      'R3-form',
    ),
  )

  // KANARIE N — grenarna OMKASTADE. Samma textträffar, samma ordning, motsatt
  // verkan.
  fel.push(
    ...kanarie(
      'N',
      {
        ...grund,
        appModuleKod: GILTIG_APPMODULE.replace(
          '? [ScheduleModule.forRoot()] : []',
          '? [] : [ScheduleModule.forRoot()]',
        ),
      },
      'R3-form',
    ),
  )

  // KANARIE O — ett extra ScheduleModule.forRoot() i en FEATUREMODUL. Andra
  // halvan av fyndet: R3 läste bara app.module.ts, så den här registreringen var
  // osynlig (uppmätt: fel: []) trots att den står utanför grinden.
  fel.push(
    ...kanarie(
      'O',
      {
        ...grund,
        filer: [
          ...grund.filer,
          {
            rel: 'apps/api/src/syntetisk/smyg.module.ts',
            kod: '@Module({ imports: [ScheduleModule.forRoot()] })\nclass SmygModule {}\n',
          },
        ],
      },
      'R3-utanför',
    ),
  )

  // KANARIE P — borttagen `validate: validateEnv` måste fälla R3-validate.
  fel.push(
    ...kanarie(
      'P',
      { ...grund, appModuleKod: GILTIG_APPMODULE.replace(', validate: validateEnv', '') },
      'R3-validate',
    ),
  )

  // KANARIE E — en kö utanför inventeringen måste fälla R4-saknas.
  fel.push(
    ...kanarie(
      'E',
      {
        ...grund,
        filer: [
          ...grund.filer,
          { rel: 'syntetisk/ny.module.ts', kod: 'BullModule.registerQueue({ name: NY_KO_QUEUE })' },
        ],
      },
      'R4-saknas',
      (f) => f.includes('NY_KO_QUEUE'),
    ),
  )

  // KANARIE Q — granskningens exakta fall: en ny registrerad kö vars konstant
  // ÄR IMPORTERAD i inventeringsfilen men glömd i den exporterade listan. Med
  // den gamla importbaserade läsningen var den här mutationen GRÖN.
  fel.push(
    ...kanarie(
      'Q',
      {
        ...grund,
        filer: [
          ...grund.filer,
          { rel: 'syntetisk/ny2.module.ts', kod: 'BullModule.registerQueue({ name: GLOMD_QUEUE })' },
        ],
        inventeringKod: grund.inventeringKod.replace(
          'export const ALLA_KONAMN',
          "import { GLOMD_QUEUE } from 'x'\nexport const ALLA_KONAMN",
        ),
      },
      'R4-saknas',
      (f) => f.includes('GLOMD_QUEUE'),
    ),
  )

  // KANARIE V — hela listan tömd, importerna orörda. Fyndet ordagrant: gav
  // tidigare `inventerade: 11` och `fel: []`.
  {
    const tömd = {
      ...grund,
      inventeringKod: grund.inventeringKod.replace(
        /export const ALLA_KONAMN[\s\S]*$/,
        'export const ALLA_KONAMN: readonly string[] = []\n',
      ),
    }
    if (tömd.inventeringKod === grund.inventeringKod) {
      fel.push('KANARIE V: mutationen tog inte — ALLA_KONAMN-deklarationen hittades inte.')
    }
    fel.push(...kanarie('V', tömd, 'R4-saknas'))
    if (evaluate(tömd).mätt.inventerade !== 0) {
      fel.push(
        `KANARIE V: mätt.inventerade blev ${evaluate(tömd).mätt.inventerade} mot en TOM lista — ` +
          'talet läser fortfarande något annat än den exporterade mängden.',
      )
    }
  }

  // KANARIE R — en SAKNAD listmedlem (kön finns kvar i koden).
  fel.push(
    ...kanarie(
      'R',
      { ...grund, inventeringKod: grund.inventeringKod.replace(/\n\s*QUEUE_PDF,/, '\n') },
      'R4-saknas',
      (f) => f.includes('QUEUE_PDF'),
    ),
  )

  // KANARIE F — en FELAKTIG listmedlem: en post som överlevt sin kö.
  fel.push(
    ...kanarie(
      'F',
      {
        ...grund,
        inventeringKod: grund.inventeringKod.replace('  QUEUE_PDF,', '  QUEUE_PDF,\n  AVSKAFFAD_QUEUE,'),
      },
      'R4-överbliven',
      (f) => f.includes('AVSKAFFAD_QUEUE'),
    ),
  )

  // KANARIE T — en DUBBLERAD listmedlem. Den fäller ingen av riktningarna ovan
  // (namnet är både registrerat och inventerat) men gör varje längdbaserad
  // kontroll till ett falskt lugn.
  fel.push(
    ...kanarie(
      'T',
      {
        ...grund,
        inventeringKod: grund.inventeringKod.replace('  QUEUE_PDF,', '  QUEUE_PDF,\n  QUEUE_PDF,'),
      },
      'R4-dubblett',
      (f) => f.includes('QUEUE_PDF'),
    ),
  )

  // ── KANARIE C1-C3: EFTERLEDET EFTER ARRAYEN ───────────────────────────────
  //
  // Återgranskningens tre motexempel, ordagrant. Alla tre gav före rättningen
  // `fel: []` och `inventerade: 11` medan den FAKTISKT exporterade mängden var
  // 4 namn, 10 namn respektive 11 namn där PDF-kön bytts ut.
  for (const [namn, efterled] of [
    ['C1', '.sort().slice(0, 4)'],
    ['C2', '.filter(name => name !== QUEUE_PDF).sort()'],
    ['C3', ".map(name => name === QUEUE_PDF ? 'pdf-v2' : name).sort()"],
  ]) {
    fel.push(
      ...kanarie(
        namn,
        {
          ...grund,
          inventeringKod: grund.inventeringKod.replace(/\]\.sort\(\)/, `]${efterled}`),
        },
        'R4-form',
        (f) => f.includes('efterled'),
      ),
    )
  }

  // KANARIE C4 — MOTSATSEN: det efterled filen FAKTISKT har måste passera.
  // Utan den raden vore C1-C3 uppfyllda av att förbjuda varje efterled, och
  // nuläget hade varit rött (kanarie 0 fångar det, men inte VARFÖR).
  fel.push(...tystKanarie('C4', grund, 'R4-form'))

  // KANARIE U — en OLÄSLIG listform ska bli ett granskningskrävande fel, inte en
  // tom mängd. En tom mängd hade tystat BÅDA R4-riktningarna på en gång.
  fel.push(
    ...kanarie(
      'U',
      {
        ...grund,
        inventeringKod: grund.inventeringKod.replace('  QUEUE_PDF,', "  '        ',"),
      },
      'R4-form',
    ),
  )

  // KANARIE G — de två GOLVEN, var för sig.
  //
  // G godtog tidigare `f.startsWith('R5')` mot en tom filmängd. Den prefixen
  // täcker BÅDA golven och pariteten, så självtestet förblev grönt när endera
  // golvet togs bort — uppmätt av en granskare. Det är samma defekt som C och D
  // hade: en kanariefågel som blir grön av fel regel. Golven mäts därför var för
  // sig, med varsitt motprov.
  {
    // G1: ingen fil alls → processorgolvet.
    fel.push(...kanarie('G1', { ...grund, filer: [] }, 'R5-golv-processorer'))

    // G2: filerna kvar, men ingen registerQueue → könamnsgolvet. Processorerna
    // är orörda, så det här kan bara fällas av just det golvet.
    const utanRegistreringar = {
      ...grund,
      filer: grund.filer.map((f) => ({ ...f, kod: f.kod.split('registerQueue').join('registrerarIngenting') })),
    }
    fel.push(...kanarie('G2', utanRegistreringar, 'R5-golv-könamn'))

    const tom = evaluate({ ...grund, filer: [] })
    if (tom.fel.some((f) => f.startsWith('R1'))) {
      fel.push('KANARIE G: R1 fällde på tom mängd — den ska tiga och låta R5 tala.')
    }
  }

  // ── R3-FORMENS EGNA PÅSTÅENDEN ────────────────────────────────────────────
  // Mönstret säger att `process.env` ingår med flit, att den registrerande
  // grenen bara får bära forRoot-anropet, och att den alternativa grenen måste
  // vara TOM. Reglerna fällde de tre fallen redan — men ingenting höll fast dem,
  // och en försvagning av mönstret hade passerat självtestet. Funnet av en
  // granskare.
  fel.push(
    ...kanarie(
      'W',
      {
        ...grund,
        appModuleKod: GILTIG_APPMODULE.replace('process.env', 'minEgenMiljö'),
      },
      'R3-form',
    ),
  )
  fel.push(
    ...kanarie(
      'X',
      {
        ...grund,
        appModuleKod: GILTIG_APPMODULE.replace(
          '[ScheduleModule.forRoot()]',
          '[ScheduleModule.forRoot(), AnnanModul]',
        ),
      },
      'R3-form',
    ),
  )
  fel.push(
    ...kanarie(
      'Y',
      { ...grund, appModuleKod: GILTIG_APPMODULE.replace(': [])', ': [AnnanModul])') },
      'R3-form',
    ),
  )

  // KANARIE Z0 — grindformen i en DÖD hjälpfunktion medan den riktiga
  // registreringen står ogrindad i `imports`. Mönstret finns då i filen, men
  // omsluter inte det anrop appen använder.
  fel.push(
    ...kanarie(
      'Z0',
      {
        ...grund,
        appModuleKod:
          'imports: [ConfigModule.forRoot({ validate: validateEnv }), ScheduleModule.forRoot()]\n' +
          'function dödKod() { return [...(schedulerShouldRegister(process.env) ? [x] : [])] }',
      },
      'R3-form',
    ),
  )

  // KANARIE Z1 — beräknad medlemsåtkomst i app.module.ts.
  fel.push(
    ...kanarie(
      'Z1',
      {
        ...grund,
        appModuleKod: GILTIG_APPMODULE + "\n  ScheduleModule['forRoot']()",
      },
      'R3-form',
      (f) => f.includes('beräknad medlemsåtkomst'),
    ),
  )

  // ── R3-IMPORT ─────────────────────────────────────────────────────────────
  // Granskarens fynd: `import { ScheduleModule as S }` följt av `S.forRoot()` i
  // en featuremodul var GRÖN. Ingen mönstermatchning på ANROPET täcker alla
  // former; bindningen gör det.
  {
    const medFil = (källa) => ({
      ...grund,
      filer: [
        ...grund.filer,
        { rel: 'apps/api/src/syntetisk/smyg.module.ts', kod: codeMask(källa), text: blankComments(källa) },
      ],
    })

    fel.push(
      ...kanarie(
        'Z2',
        medFil("import { ScheduleModule as S } from '@nestjs/schedule'\nimports: [S.forRoot()]\n"),
        'R3-import',
        (f) => f.includes('bindningen ScheduleModule'),
      ),
    )
    fel.push(
      ...kanarie(
        'Z3',
        medFil("import * as sched from '@nestjs/schedule'\nimports: [sched.ScheduleModule.forRoot()]\n"),
        'R3-import',
        (f) => f.includes('inte är en läsbar namnimport'),
      ),
    )
    fel.push(
      ...kanarie(
        'Z4',
        medFil("const { ScheduleModule } = require('@nestjs/schedule')\n"),
        'R3-import',
      ),
    )
    // Z5 — MOTSATSEN: de 25 filer som importerar Cron/CronExpression/
    // SchedulerRegistry får INTE fällas. Utan den här raden vore regeln ovan
    // uppfylld av att förbjuda hela paketet, vilket hade brutit halva appen.
    fel.push(
      ...tystKanarie(
        'Z5',
        medFil("import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule'\n"),
        'R3-import',
      ),
    )

    // KANARIE D1 — den CITERADE bindningen. TypeScript 5.6 tillåter formen, och
    // den gav `fel: []` i återgranskningen: jämförelsen läste `'ScheduleModule'`
    // med citattecken och matchade aldrig det ociterade namnet.
    fel.push(
      ...kanarie(
        'D1',
        medFil(
          "import { 'ScheduleModule' as S } from '@nestjs/schedule'\n" +
            '@Module({ imports: [S.forRoot()] })\nclass SmygModule {}\n',
        ),
        'R3-import',
        (f) => f.includes('bindningen ScheduleModule'),
      ),
    )
    fel.push(
      ...kanarie(
        'D2',
        medFil("import { \"ScheduleModule\" as S } from '@nestjs/schedule'\n"),
        'R3-import',
        (f) => f.includes('bindningen ScheduleModule'),
      ),
    )

    // KANARIE D3 — ETT ALIAS I APP.MODULE.TS. Återgranskningens uttryckliga
    // avgränsning: `ScheduleModule as S` bredvid den riktiga grinden passerade,
    // eftersom importkontrollen hoppade över AppModule. Den hoppar den inte
    // längre, så luckan är stängd i stället för bara redovisad.
    {
      const källa =
        "import { ScheduleModule, ScheduleModule as S } from '@nestjs/schedule'\n" +
        'imports: [S.forRoot()]\n'
      fel.push(
        ...kanarie(
          'D3',
          {
            ...grund,
            filer: grund.filer.map((f) =>
              ärAppModule(f.rel) ? { ...f, kod: codeMask(källa), text: blankComments(källa) } : f,
            ),
          },
          'R3-import',
          (f) => f.includes('under namnet'),
        ),
      )
    }

    // KANARIE D4 — MOTSATSEN: app.module.ts:s RIKTIGA import, under sitt eget
    // namn, får inte fällas. Annars vore D3 uppfylld av att förbjuda importen
    // överallt, och då kunde ingen registrera schemaläggaren alls.
    fel.push(...tystKanarie('D4', grund, 'R3-import'))
  }

  // KANARIE H — en KOMMENTAR som påstår att grinden finns får inte uppfylla R1.
  fel.push(
    ...kanarie(
      'H',
      {
        ...grund,
        filer: [
          ...grund.filer,
          { rel: 'syntetisk/prosa.worker.ts', kod: '@Processor(Q)\nclass ProsaWorker {}\n' },
          {
            rel: 'syntetisk/prosa.module.ts',
            kod: codeMask('// pausedUnless(ProsaWorker) — den här raden är bara prosa\n'),
          },
        ],
      },
      'R1',
      (f) => f.includes('ProsaWorker'),
    ),
  )

  // KANARIE J — ett SVENSKT klassnamn måste hanteras HELT, inte stympat.
  // Med det gamla ASCII-mönstret fångades `PåminnelseWorker` som `P`, och då
  // jämfördes stympat mot stympat: R1 blev grön för att båda sidor var lika
  // trasiga. Kanariefågeln prövar därför BÅDA riktningarna med ett å i namnet —
  // grindad ska vara tyst, ogrindad ska fälla.
  {
    const grindadSvensk = {
      ...grund,
      filer: [
        ...grund.filer,
        { rel: 'syntetisk/sv.worker.ts', kod: '@Processor(Q)\nclass PåminnelseWorker {}\n' },
        { rel: 'syntetisk/sv.module.ts', kod: 'providers: [...pausedUnless(PåminnelseWorker)]' },
      ],
    }
    const utfall = evaluate(grindadSvensk)
    if (utfall.fel.some((f) => f.includes('Påminnelse'))) {
      fel.push(`KANARIE J: en GRINDAD svensk konsument fälldes ändå — ${JSON.stringify(utfall.fel)}`)
    }
    if (utfall.fel.some((f) => f.startsWith('R2') && f.includes('P)'))) {
      fel.push('KANARIE J: namnet stympades vid första icke-ASCII-tecknet.')
    }

    fel.push(
      ...kanarie(
        'J',
        {
          ...grund,
          filer: [
            ...grund.filer,
            { rel: 'syntetisk/sv2.worker.ts', kod: '@Processor(Q)\nclass AvgiftWorkerÅÄÖ {}\n' },
          ],
        },
        'R1',
        (f) => f.includes('AvgiftWorkerÅÄÖ'),
      ),
    )
  }

  // KANARIE K — en AKTIV rad i .env.example måste fälla R6, en utkommenterad inte.
  // Båda riktningarna, eftersom regeln annars antingen vore stum eller hade
  // gjort det omöjligt att dokumentera variabeln över huvud taget.
  {
    fel.push(
      ...kanarie('K', { ...grund, envExempel: '# text\nOPS_AUTOMATION_PAUSED=true\n' }, 'R6'),
    )
    fel.push(
      ...tystKanarie('K-false', { ...grund, envExempel: '# text\nOPS_AUTOMATION_PAUSED=false\n' }, 'R6'),
    )
    fel.push(
      ...tystKanarie(
        'K-kommenterad',
        {
          ...grund,
          envExempel: '# OPS_AUTOMATION_PAUSED=true\n#   OPS_AUTOMATION_PAUSED=false\n',
        },
        'R6',
      ),
    )
  }

  // KANARIE L — en @Processor som faller UR den strukturerade härledningen (men
  // finns i råtexten) måste fälla R5:s paritet. Utan den regeln hade R1 varit
  // grön på fel underlag: en klass som inte härleds kan heller inte saknas.
  {
    const långtMellanrum = '@Processor(Q)\n' + '// '.padEnd(420, 'x') + '\nclass LångtBortWorker {}\n'
    fel.push(
      ...kanarie(
        'L',
        { ...grund, filer: [...grund.filer, { rel: 'syntetisk/langt.ts', kod: långtMellanrum }] },
        'R5-paritet',
      ),
    )
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
      `${grönt.mätt.inventerade} inventerade i den EXPORTERADE listan. ` +
      '41 egna kanariefåglar prövade: 35 med MOTPROV mot sin egen regel (mutationen ' +
      'får inte längre fälla när just den regeln stängs av), och 6 tysta som kräver ' +
      'att en KORREKT källa INTE fälls. Plus den delade skannerns 7.',
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
