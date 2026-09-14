/**
 * DRIFTPAUS FÖR AUTOMATISKA VERKSAMHETSJOBB — ett uttryckligt uppstartsläge.
 *
 * ── VILKEN FRÅGA DEN SVARAR PÅ ──────────────────────────────────────────────
 *
 * "Får den här processen börja utföra automatiskt verksamhetsarbete?"
 *
 * Inte "är API:t friskt", inte "är kön pausad i Redis", inte "är funktionen X
 * påslagen". Bara den ena frågan — och den ställs FÖRE Nest har hunnit
 * registrera en enda schemaläggare eller konsument.
 *
 * ── VARFÖR CRON_ENABLED INTE DUGER ──────────────────────────────────────────
 *
 * `app.module.ts` laddar `ScheduleModule.forRoot()` när
 * `NODE_ENV=production ELLER CRON_ENABLED=true`. Villkoret är ett ELLER, så en
 * produktionsprocess registrerar cron OAVSETT vad CRON_ENABLED står på.
 * `CRON_ENABLED=false` är alltså en DEV-grind, inte en produktionspaus, och den
 * som tror något annat har en spärr som aldrig kunde hålla.
 *
 * Samma sak gäller de tre feature-flaggor som ibland kallas driftspärrar:
 *
 *   PSD2_ENABLED=false            hindrar INTE enqueue till `psd2-sync`
 *   transactionalEmailsDisabled   jobbet KÖRS och FÖRBRUKAS, mejlet uteblir
 *   remindersEnabled=false        stoppar inte arbete som redan påbörjats
 *
 * Ingen av dem svarar på frågan överst. Den här filen gör det, och bara den.
 *
 * ── TRE VÄRDEN, INGEN FJÄRDE ────────────────────────────────────────────────
 *
 *   'true'                        PAUSAT
 *   'false'                       normal drift
 *   saknad / tom                  normal drift  ← dagens beteende, oförändrat
 *   ALLT ANNAT                    KASTAR
 *
 * Den fjärde raden är hela poängen. En felstavning (`OPS_AUTOMATION_PAUSED=ture`,
 * `=1`, `=TRUE`, `=paused`) får ALDRIG tyst betyda "kör på" — det är exakt den
 * felriktning en driftpaus finns för att stänga. Kastet sker vid boot, före
 * första jobbet, och gäller i ALLA miljöer (som `psd2MockRequested` och
 * `authThrottleRelaxed`, inte som `CRITICAL` i env.validation som bara felar i
 * produktion).
 *
 * SAKNAT VÄRDE ÄR NORMAL DRIFT, och det är ett medvetet val med en kostnad.
 * Fördelen: dagens produktion, dagens dev-miljöer och hela testsviten beter sig
 * exakt som före den här ändringen — ingen miljö behöver röras för att
 * fortsätta fungera. Priset: den som GLÖMMER att sätta variabeln får ingen
 * paus, och en utebliven paus ser likadan ut som en normal start. Därför
 * rapporteras läget uttryckligen i `/v1/health` (fältet `automation`) — pausen
 * ska kunna KONTROLLERAS efter start, inte antas av den som satte variabeln.
 *
 * ── VAD FLAGGAN INTE SKYDDAR MOT ────────────────────────────────────────────
 *
 * Den gäller EN process, och bara från dess egen start. Den gör ingenting åt:
 *
 *   • REDAN KÖRANDE äldre processer. En gammal container som startade utan
 *     variabeln fortsätter köra cron och konsumera köer. Pausen når den aldrig.
 *   • MANUELLA anrop. Varje HTTP-endpoint som skriver fungerar precis som förut;
 *     flaggan rör inte ingressen.
 *   • OKÄNDA EXTERNA SKRIVARE. Andra tjänster, jobb eller människor med
 *     DB-åtkomst berörs inte.
 *   • REDAN ENQUEUEADE jobb. De ligger kvar (det är avsikten), och konsumeras av
 *     vilken som helst opausad worker som är ansluten till samma Redis.
 *
 * Bankfixens införandeprocedur kräver VERKLIG avskärmning — stängd ingress,
 * bevisat stoppade gamla generationer, spärrad återstart. Den här flaggan är
 * steg 8:s saknade halva, inte en ersättning för steg 1–4. Att påstå att en
 * avskärmning finns därför att flaggan finns vore samma sorts fel som att kalla
 * `CRON_ENABLED=false` en produktionspaus.
 *
 * ── ÅTERÖPPNING ─────────────────────────────────────────────────────────────
 *
 * Uttrycklig och bara en väg: ta bort variabeln (eller sätt den till 'false')
 * och STARTA EN NY PROCESS. Det finns med flit ingen endpoint, ingen timeout och
 * ingen automatik som kan häva pausen — en healthcheck, en Railway-omstart eller
 * en deploy som råkar återanvända gammal konfiguration ska inte kunna öppna
 * verksamhetsjobben. Läget är låst för processens livstid: funktionen läser env
 * varje gång den anropas, men alla registreringsbeslut är redan fattade vid
 * boot.
 */

export const AUTOMATION_PAUSE_VAR = 'OPS_AUTOMATION_PAUSED'

/** De två enda accepterade värdena. Saknad/tom hanteras separat. */
export const AUTOMATION_PAUSE_VALUES = ['true', 'false'] as const

export class InvalidAutomationPauseError extends Error {
  constructor(varde: string) {
    super(
      `[ops] ${AUTOMATION_PAUSE_VAR}='${varde}' är inget giltigt värde. ` +
        `Giltiga: ${AUTOMATION_PAUSE_VALUES.join(' | ')} (saknad/tom = normal drift). ` +
        'Uppstart avbryts med flit: ett okänt värde får inte tyst tolkas som ' +
        '"kör på", eftersom det är precis den felriktning driftpausen finns för ' +
        'att stänga.',
    )
  }
}

/**
 * Ren funktion, tar env explicit så den går att prova utan att röra process.env.
 *
 * @throws InvalidAutomationPauseError vid ett värde utanför AUTOMATION_PAUSE_VALUES.
 */
export function automationPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AUTOMATION_PAUSE_VAR]
  if (raw === undefined || raw === '') return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new InvalidAutomationPauseError(raw)
}

/**
 * ── VARFÖR KÄLLKONTROLLEN NEDAN FINNS (uppmätt, inte härledd) ───────────────
 *
 * Flaggan läses på fyra ställen med olika tidpunkter, och ett värde som bara står
 * i `apps/api/.env` kan därför ge ett SPLITTRAT tillstånd. Två oberoende
 * granskare pekade ut det. Den exakta formen mättes efteråt och blev en annan än
 * den första beskrivningen — därför står den utskriven här i stället för att
 * återberättas.
 *
 * `ConfigModule.forRoot` är ASYNKRON (`config.module.js:63`). Den läser env-filen,
 * bygger `config = { ...envFil, ...process.env }`, kör `validate`, och FÖRST
 * DÄREFTER `assignVariablesToProcess` (`:77-80`). `app.module.ts`:s
 * `imports`-array byggs SYNKRONT, så när arrayens senare element evalueras har
 * löftet ännu inte löst sig. Uppmätt med en sond som speglar exakt den ordningen,
 * med `OPS_AUTOMATION_PAUSED=true` enbart i en env-fil:
 *
 *     SYNKRONT (så arrayen byggs):  pausedUnless -> REGISTRERAR
 *                                   schedulerShouldRegister -> true
 *                                   process.env -> undefined
 *
 * De två GRINDARNA är alltså överens med varandra: båda läser processmiljön före
 * `.env`. Det som glider isär är de två läsningarna som sker vid RUNTIME —
 * `DepositsService.onApplicationBootstrap` och `/v1/health` — eftersom de kommer
 * efter tilldelningen. Utfallet av ett `.env`-värde hade blivit:
 *
 *     cron igång · elva konsumenter igång · uppstarts-backfillen PAUSAD
 *     /v1/health säger "paused": true
 *
 * Alltså ett hälsosvar som påstår full paus om en process som inte pausat något
 * av betydelse.
 *
 * ── DÄRFÖR LÄSES process.env LIVE, OCH INTE UR EN FRYST SNAPSHOT ────────────
 *
 * En första version frös processmiljöns värde vid modulladdning. Det var
 * onödigt OCH skadligt: kontrollen körs inne i `validate`, alltså FÖRE
 * `assignVariablesToProcess`, så `process.env` bär där fortfarande exakt det
 * värde grindarna läste. Snapshoten tillförde ingenting — men den gick inte att
 * nollställa från ett prov, till skillnad från allt annat i `VALIDATED_ENV_VARS`,
 * och gjorde `validateEnv` ICKE-HERMETISK: med variabeln satt i den ambienta
 * miljön föll åtta prov i `env.validation.integration.spec.ts`, grönt i CI
 * (ingen `.env`) och rött lokalt. Uppmätt av en granskare.
 */

export class AutomationPauseSourceError extends Error {
  constructor(processvarde: string | undefined, konfigvarde: unknown) {
    super(
      `[ops] ${AUTOMATION_PAUSE_VAR} ger OLIKA PAUSBESLUT i processmiljön och i den ` +
        `upplösta konfigurationen: processmiljö=${processvarde === undefined ? '(osatt)' : `'${processvarde}'`}, ` +
        `konfiguration=${typeof konfigvarde === 'string' ? `'${konfigvarde}'` : '(osatt)'}. ` +
        'Det inträffar när variabeln står i apps/api/.env i stället för i ' +
        'processmiljön: grindarna läser processmiljön innan ConfigModule hunnit ' +
        'lägga .env-värdena där, medan uppstarts-backfillen och /v1/health läser ' +
        'efteråt. Resultatet hade blivit ett SPLITTRAT tillstånd — cron och ' +
        'konsumenter igång, backfillen pausad, och ett hälsosvar som påstår full ' +
        `paus. Sätt ${AUTOMATION_PAUSE_VAR} som riktig miljövariabel (Railway, eller ` +
        `\`${AUTOMATION_PAUSE_VAR}=true node ...\`) och ta bort den ur .env.`,
    )
  }
}

/**
 * Tolkar ett råvärde till ett pausBESLUT, eller `null` när värdet är ogiltigt.
 *
 * Ogiltiga värden rapporteras av `validateEnv` punkt 8 (som anropar
 * `automationPaused` direkt). Att kasta här också hade gett två fel för samma
 * sak, varav det ena med fel förklaring.
 */
function beslutAv(raw: string | undefined): boolean | null {
  try {
    return automationPaused({ [AUTOMATION_PAUSE_VAR]: raw } as NodeJS.ProcessEnv)
  } catch {
    return null
  }
}

/**
 * Jämför den upplösta konfigurationen mot processmiljöns snapshot.
 *
 * ── BESLUT, INTE STRÄNGAR — och det är inte en detalj ───────────────────────
 *
 * Första versionen jämförde råvärden. Då blev `(osatt)` och `'false'` OLIKA,
 * trots att båda betyder "inte pausad" och per konstruktion inte kan ge ett
 * splittrat tillstånd. Det gav två mätta fel som en granskare fann:
 *
 *   1. `cp .env.example .env` — det dokumenterade onboarding-steget — fällde
 *      uppstarten, med ett meddelande om en halv paus som inte kunde uppstå.
 *   2. `validateEnv` blev ICKE-HERMETISK. Snapshoten tas vid modulladdning och
 *      kan därför inte nollställas av ett prov, till skillnad från allt annat i
 *      `VALIDATED_ENV_VARS`. Med variabeln satt i den ambienta miljön föll åtta
 *      prov i `env.validation.integration.spec.ts` — grönt i CI (ingen `.env`),
 *      rött lokalt, och beroende på vilken modul som laddades först.
 *
 * En jämförelse av BESLUT har inga falska negativ: två råvärden kan inte ge
 * samma beslut och ändå ge ett splittrat tillstånd, eftersom det är just
 * beslutet varje läsare agerar på.
 *
 * Anropas av `validateEnv`, alltså inne i `ConfigModule.forRoot()` — före
 * `assignVariablesToProcess`, före `NestFactory.create()`, och långt före
 * `BullExplorer.onModuleInit` och `onApplicationBootstrap`. Boot avbryts därför
 * innan en enda konsument kopplats in eller ett enda startjobb körts.
 *
 * @throws AutomationPauseSourceError när källorna leder till olika pausbeslut.
 */
export function assertAutomationPauseSource(config: Record<string, unknown>): void {
  const konfig = config[AUTOMATION_PAUSE_VAR]
  const konfigStr = typeof konfig === 'string' && konfig !== '' ? konfig : undefined
  // LIVE, inte fryst: `validate` körs före `assignVariablesToProcess`, så
  // process.env bär här fortfarande det värde grindarna läste. Se docblocket
  // ovan för varför en snapshot var både onödig och skadlig.
  const rawProcess = process.env[AUTOMATION_PAUSE_VAR]
  const processStr = rawProcess !== undefined && rawProcess !== '' ? rawProcess : undefined

  const konfigBeslut = beslutAv(konfigStr)
  const processBeslut = beslutAv(processStr)
  // Ett ogiltigt värde (null) ägs av punkt 8 — tig här och låt den tala.
  if (konfigBeslut === null || processBeslut === null) return
  if (konfigBeslut !== processBeslut) throw new AutomationPauseSourceError(processStr, konfigStr)
}

/**
 * Ska den här processen registrera `ScheduleModule.forRoot()`?
 *
 * ── VARFÖR BESLUTET BOR HÄR OCH INTE I `app.module.ts` ──────────────────────
 *
 * `app.module.ts` går inte att importera i ett prov: modulgrafen drar in
 * `@aws-sdk/client-s3`, vars beroende `@nodable/entities` levereras som ESM och
 * fäller ts-jest med `SyntaxError: Unexpected token 'export'`. Det är skälet att
 * ingen spec i repot importerar AppModule.
 *
 * Alternativet hade varit att SKRIVA AV villkoret i provet. Då mäter provet sin
 * egen kopia: de två kan glida isär, och den dagen är provet grönt medan
 * produktionen registrerar cron i pausat läge — alltså exakt det fel som ska
 * omöjliggöras. Beslutet är därför EN funktion, anropad av både `app.module.ts`
 * och `automation-pause-startup.spec.ts`.
 *
 * Att `app.module.ts` verkligen använder den här funktionen — och inte en
 * återinförd inline-variant — bevakas av
 * `apps/api/scripts/check-automation-pause.mjs`.
 *
 * ── VILLKORET ───────────────────────────────────────────────────────────────
 *
 * Pausen är OMSLUTANDE, inte ett tredje ELLER-led. `CRON_ENABLED=true` kan alltså
 * inte öppna en pausad process. Vore den ett tredje led hade en dev-variabel
 * kunnat häva ett underhållsfönster.
 *
 * Det befintliga ELLER-villkoret står oförändrat innanför: `NODE_ENV=production`
 * registrerar cron som förut, och `CRON_ENABLED=false` pausar fortfarande INTE
 * produktionen. Det sistnämnda är ingen brist som lämnats kvar — det är själva
 * anledningen till att den här filen finns.
 */
export function schedulerShouldRegister(env: NodeJS.ProcessEnv = process.env): boolean {
  if (automationPaused(env)) return false
  return env['NODE_ENV'] === 'production' || env['CRON_ENABLED'] === 'true'
}

/** En grindad konsument, sedd av grinden själv. */
export interface AutomationGateEntry {
  /** Klassnamnet, t.ex. 'Psd2SyncWorker'. */
  readonly name: string
  /** Sant när grinden UTELÄMNADE providern ur modulen (pausat läge). */
  readonly withheld: boolean
}

const gateRegistry = new Map<string, AutomationGateEntry>()

/**
 * Hjälpare för `imports`/`providers`-arrayer: `...pausedUnless(x)` blir tom lista
 * i pausat läge och `[x]` annars.
 *
 * Finns för att grinden ska se LIKADAN ut på alla elva ställen den används.
 * Elva varianter av `...(automationPaused() ? [] : [X])` hade varit elva
 * tillfällen att skriva villkoret åt fel håll, och ett enda omvänt villkor hade
 * gett en konsument som startar just i pausat läge — den värsta formen, eftersom
 * den bara syns när pausen faktiskt behövs.
 *
 * Bevakas av `apps/api/scripts/check-automation-pause.mjs`, som härleder BÅDE
 * mängden `@Processor`-klasser ur koden OCH att var och en av dem når grinden.
 */
export function pausedUnless<T>(provider: T, env: NodeJS.ProcessEnv = process.env): T[] {
  const paused = automationPaused(env)
  const name =
    typeof provider === 'function' && typeof (provider as { name?: unknown }).name === 'string'
      ? (provider as { name: string }).name
      : '(anonym)'
  // NYCKLAT PÅ NAMN, inte push: laddas samma modulfil två gånger (dist + src,
  // olika upplösta sökvägar) hade en ren lista dubblerat talen i /v1/health utan
  // att något sa till. Varje konsumentklass grindas exakt en gång i koden, vilket
  // check-automation-pause.mjs bevakar — så en dubblett är alltid en
  // laddningsartefakt, aldrig en riktig andra konsument.
  gateRegistry.set(name, { name, withheld: paused })
  return paused ? [] : [provider]
}

/**
 * Vad grinden FAKTISKT gjorde vid modulladdning — inte vad någon skrivit i en
 * lista.
 *
 * Posterna skrivs av `pausedUnless` självt, alltså av exakt den funktion som
 * fattar beslutet, och registret kan därför inte glida ifrån verkligheten på
 * det sätt en handskriven uppräkning gör. Det är samma skäl som
 * `VALIDATED_ENV_VARS` härleds ur de strukturer `validateEnv` loopar igenom:
 * två uppräkningar som ska vara lika är inte en uppräkning.
 *
 * MOTHÅLLET ÅT ANDRA HÅLLET bärs av `apps/api/scripts/check-automation-pause.mjs`,
 * som härleder mängden @Processor-klasser UR KODEN och kräver att var och en av
 * dem når grinden. Registret ensamt kan inte se en konsument som ingen grindat —
 * den saknas ju då också här.
 *
 * FYLLS VID IMPORT, inte vid boot: raderna skrivs när modulfilen evalueras.
 * Läses den före att alla modulfiler importerats är den ofullständig, vilket i
 * praktiken bara kan hända i ett prov som importerar en enda modul.
 */
export function automationGateEntries(): readonly AutomationGateEntry[] {
  return [...gateRegistry.values()]
}
