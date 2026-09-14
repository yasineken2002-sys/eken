/**
 * DRIFTVERKTYG FÖR BULL-KÖERNA — läser som standard, pausar bara på uttrycklig
 * order, och startar aldrig Nest/AppModule.
 *
 * ── VARFÖR ETT EGET VERKTYG ─────────────────────────────────────────────────
 *
 * Avskärmningsordningens steg 3 kräver en GLOBAL köpaus utan att appen startas.
 * Att boota `AppModule` för att komma åt köerna hade varit motsatsen till
 * avsikten: det startar Prisma, R2, Chromium — och i ett opausat läge även
 * konsumenterna, alltså precis det som ska stoppas. Repot hade inget sådant
 * verktyg (`src/scripts/` innehöll rotation, radering, backfill och
 * schemadrift), så det här är det minsta som gör jobbet.
 *
 * Formen är `rotate-pii-secrets.ts`:s: fristående nod-process, `--dry-run`-tänk
 * som DEFAULT snarare än som flagga, och ett kast i stället för en tyst
 * fallback när något inte går att klassificera.
 *
 * ── TRE SPÄRRAR MOT ATT RÖRA FEL SYSTEM ─────────────────────────────────────
 *
 * 1. `--redis-url` är OBLIGATORISK, och dess FORM ÄR SNÄV. Verktyget läser med
 *    flit INTE `REDIS_URL` ur miljön. En operatörs terminal bär ofta
 *    produktionens variabler, och ett verktyg som "bara kör mot det som råkade
 *    stå i miljön" antar produktion som standard — vilket uppdraget uttryckligen
 *    förbjuder.
 *
 *    URL:en tolkas EN gång, till `RedisTarget`, och både måltexten och Bulls
 *    anslutningsoptioner härleds ur den. Queryparametrar och fragment AVVISAS
 *    före anslutning. Skälet är mätt och står vid `parseRedisTarget`: skickas
 *    strängen vidare till Bull tolkas den en andra gång, på ett annat sätt, och
 *    `?host=`/`?db=`/`?keyPrefix=` blir ett tyst alternativt mål.
 * 2. Muterande åtgärder kräver `--confirm=<mål>`, där `<mål>` måste vara exakt
 *    den måltext verktyget skriver ut (schema, värd, port, databasindex och
 *    prefix).
 *
 *    VAD DEN FAKTISKT ÄR: en stavfelsspärr och en ändringsspärr — INTE ett bevis
 *    för att operatören läst läsläget först. `describeTarget` är en ren funktion
 *    av `--redis-url` och `--prefix`, utan nonce och utan något från det levande
 *    systemet, så måltexten går att räkna ut i huvudet. Det den bevisligen
 *    fångar är ett stavfel i URL:en eller prefixet mellan läsning och åtgärd,
 *    och en URL som ändrats däremellan. Påstå inte mer än så.
 * 3. Inventeringen jämförs mot koden, och `inventeringKomplett` blir `false`
 *    vid en okänd kö i Redis, vid ett avgränsat `--queues`, och när INGEN av de
 *    begärda köerna har spår under prefixet. En muterande åtgärd vägrar i det
 *    sista fallet.
 *
 *    VAD DEN SPÄRREN FAKTISKT FÅNGAR: ett HELT TOMT mål. Den skiljer inte "rätt
 *    mål" från "fel mål" — ett gammalt prefix eller ett gammalt db-index från
 *    SAMMA app bär alla elva `:id`-nycklar, och passerar. Att skilja de två
 *    kräver något läst ur det levande målet och jämfört mot något oberoende
 *    (t.ex. Redis `run_id` eller högsta jobb-id per kö) — det är inte byggt, och
 *    verktyget lovar det inte.
 *
 * ── VAD DET ALDRIG GÖR ──────────────────────────────────────────────────────
 *
 * Ingen `clean`, `empty`, `remove` eller `obliterate`. Inga jobb raderas, inga
 * markeras klara. Inga jobbpayloads och inga personuppgifter skrivs ut, och bara
 * ANTAL rapporteras.
 *
 * ── VAD SOM FAKTISKT SKRIVS UT, OCH VAD SOM INTE GÖR DET ────────────────────
 *
 * Skrivs ALDRIG: användarnamn, lösenord, query (namn och värden), fragment, en
 * sökväg som inte är ett databasindex, ett schema som inte är redis/rediss, en
 * oparserbar sträng, och innehållet i en felaktig `--confirm`.
 *
 * Skrivs MED FLIT, därför att måltexten måste gå att upprepa i `--confirm`:
 * schema, värd, port, databasindex och `--prefix`. Ett `--queues`- eller
 * `--action`-värde som avvisas skrivs också ut — utan det kan operatören inte se
 * sitt stavfel. Den som klistrar en hemlighet i NÅGON av de flaggorna får den
 * alltså i loggen, och det är en gräns värd att känna till snarare än ett
 * skydd att påstå.
 *
 * `resume` finns med därför att en återöppning ska vara ett lika uttryckligt och
 * lika spårat handgrepp som pausen — inte något som sker av sig självt vid en
 * omstart. Den bär samma `--confirm`-krav.
 *
 * ── ANVÄNDNING ──────────────────────────────────────────────────────────────
 *
 *   node -r ts-node/register src/scripts/queue-ops.ts \
 *     --redis-url=redis://HOST:PORT/DB [--prefix=bull] [--queues=a,b] [--json]
 *
 *   ... --action=pause  --confirm='<måltexten ur läsläget>'
 *   ... --action=resume --confirm='<måltexten ur läsläget>'
 *
 * Avgränsning som ska stå utskriven i varje rapport som använder verktyget: en
 * global paus stoppar KONSUMTION. Den stoppar inte producenter, inte HTTP-vägar
 * och inte en gammal process som redan håller ett aktivt jobb.
 */

import Bull from 'bull'
import type { Queue } from 'bull'
// Versionen läses ur paketets egen manifest, inte ur en literal här: ett
// hårdkodat '4.16.5' hade fortsatt påstå sig stämma efter en uppgradering,
// och just runtimeversionen är en av de saker rapporten ska kunna styrka.
import { version as BULL_VERSION } from 'bull/package.json'
import { ALLA_KONAMN } from '../common/ops/queue-inventory'

export type QueueAction = 'inspect' | 'pause' | 'resume'

export interface QueueReport {
  name: string
  /** Global pausflagga i Redis (`isPaused(false)`), inte den lokala. */
  pausedGlobally: boolean
  counts: Record<string, number>
  /** ANTAL återkommande jobb. Namn och payloads skrivs aldrig ut. */
  repeatableCount: number
}

export interface OpsResult {
  action: QueueAction
  /** Måltexten operatören måste kunna upprepa för en muterande åtgärd. */
  target: string
  bullVersion: string
  redisVersion: string
  /**
   * Sant bara när HELA kodens mängd begärdes, Redis inte bär någon kö utanför
   * den, OCH minst en av de begärda köerna faktiskt har spår under prefixet.
   *
   * Det sista ledet är tillagt efter ett granskningsfynd som reproducerades
   * skarpt: utan det svarade verktyget `inventering komplett: JA` mot ett HELT
   * TOMT prefix, och `--action=pause` rapporterade elva pausade köer som inte
   * fanns. Fel prefix, fel databasindex eller fel Redis hade alltså läst som en
   * verifierad avskärmning — exakt det utfall spärren finns för att stoppa.
   */
  inventeringKomplett: boolean
  /** Antal begärda köer som har spår under prefixet. Noll = fel mål. */
  funnaIRedis: number
  /**
   * Köer i koden som inte har ett enda spår under prefixet. Den OFARLIGA
   * riktningen: en kö som aldrig fått ett jobb har inga nycklar, och det finns
   * då heller ingenting att pausa. Rapporteras ändå — ett oväntat namn här
   * betyder oftast fel prefix.
   */
  utanSparIRedis: string[]
  /**
   * Köer som finns under prefixet men INTE i koden. Den FARLIGA riktningen: en
   * konsument som kodinventeringen missat, eller en gammal generation som skriver
   * mot samma Redis. Ett sådant fynd gör utfallet obrukbart som avskärmningsbevis.
   */
  okandaIRedis: string[]
  queues: QueueReport[]
  /** Vad som FAKTISKT skrevs. Tom lista i läsläge. */
  atgardade: string[]
}

/**
 * Klipper bort de led i en redis-URL som kan bära en credential: användare,
 * lösenord, hela queryn, fragmentet, och en sökväg som inte är ett
 * databasindex. Är strängen inte en redis-URL återges den inte alls.
 *
 * VAD DEN INTE KLIPPER: schema, värd och port, som måste synas för att
 * operatören ska se vilken adress som föll. Får aldrig kringgås i utskrift.
 *
 * ── QUERYN ÄR OCKSÅ EN CREDENTIALVÄG ────────────────────────────────────────
 *
 * `u.password` täcker bara `redis://user:pw@värd`. Bull 4.16.5 spretar in HELA
 * queryn i klientoptionerna (`queue.js:352-354`), så `?password=…` är en fullt
 * verksam credential som `new URL()` INTE lägger i `u.password` — och den formen
 * återgavs tidigare oförändrad härifrån. Uppmätt i granskningen med ett
 * syntetiskt värde:
 *
 *   in  redis://example:6379/0?password=SYNTHETIC_TEST_VALUE
 *   ut  redis://example:6379/0?password=SYNTHETIC_TEST_VALUE   ← oförändrad
 *
 * Därför maskeras VARJE queryvärde, inte bara de parameternamn vi råkar känna
 * igen. En lista över "hemliga namn" åldras vid nästa biblioteksversion; en
 * generell maskering gör det inte. Fragmentet maskeras av samma skäl.
 *
 * Funktionen är sista utvägen, inte förstahandsvalet: den normala utskriften är
 * `describeTarget`, som är härledd ur den validerade formen och per konstruktion
 * inte kan bära en credential.
 */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url)

    // ÄR DET INTE EN REDIS-URL ÅTERGES INGENTING. `new URL()` godtar vilket
    // schema som helst, så `synthetic-test-value:x` tolkas utan fel — och
    // returnerades tidigare OFÖRÄNDRAD, alltså precis det den här funktionen
    // finns för att omöjliggöra. Resonemanget i catch-grenen nedan gällde bara
    // den ena halvan: en sträng vi inte kan PLACERA är lika farlig som en vi
    // inte kan tolka. Funnet av en granskare.
    if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
      return '(inte en redis-url — utelämnad)'
    }

    if (u.password) u.password = '***'
    if (u.username) u.username = '***'

    // QUERYN UTELÄMNAS HELT — NAMN OCH ALLT. Att maskera värdena räckte inte:
    // ett queryled utan `=` blir ett NAMN med tomt värde, så
    //
    //   --redis-url=redis://h:6379/0?SYNTHETIC_TEST_VALUE
    //
    // loggades som `redis://h:6379/0?SYNTHETIC_TEST_VALUE=***` — hemligheten
    // oförändrad, bara med ett maskerat tomt värde efter sig. Uppmätt genom
    // verkliga `main` av en granskare.
    //
    // Querynamn är ingen betrodd, ofarlig mängd bara för att värdena maskeras.
    // Och eftersom formen ändå AVVISAS av `parseRedisTarget` finns det ingen som
    // helst anledning att återge dess innehåll: ANTALET är allt operatören
    // behöver för att se att det var queryn som fällde adressen.
    const ledAntal = u.search === '' ? 0 : u.search.slice(1).split('&').filter(Boolean).length
    const hadeFragment = u.hash !== ''
    u.search = ''
    u.hash = ''

    // SÖKVÄGEN FÅR BARA VARA ETT DATABASINDEX. `redis://h:6379/SYNTHETIC_TEST_VALUE`
    // gick oförändrad genom maskeringen: funktionen rörde bara användare,
    // lösenord, query och fragment. Är ledet inte ett heltal vet vi inte vad det
    // är, och då återges det inte. Funnet av en granskare.
    const bana = u.pathname.replace(/^\//, '')
    if (bana !== '' && !/^[0-9]{1,5}$/.test(bana)) u.pathname = '/(ej återgivet)'

    return (
      u.toString() +
      (ledAntal > 0 ? ` (+${ledAntal} queryparameter(rar) utelämnade)` : '') +
      (hadeFragment ? ' (+fragment utelämnat)' : '')
    )
  } catch {
    // Går URL:en inte att tolka får ingenting skrivas ut — en oparserbar sträng
    // kan mycket väl vara en hel credential.
    return '(oparserbar redis-url — utelämnad)'
  }
}

/**
 * DEN VALIDERADE REPRESENTATIONEN. En enda tolkning av `--redis-url`, som BÅDE
 * bekräftelsetexten och de verkliga anslutningsoptionerna härleds ur.
 */
export interface RedisTarget {
  readonly schema: 'redis' | 'rediss'
  /** Utan IPv6-klamrar — det är formen ioredis vill ha. */
  readonly host: string
  readonly port: number
  readonly db: number
  readonly prefix: string
  readonly username?: string
  readonly password?: string
  /** Sant bara för `rediss://`. Bärs UTTRYCKLIGEN vidare — se `bullQueueOptions`. */
  readonly tls: boolean
}

/**
 * Redis MATCH-metatecken. `*` och `?` är de uppenbara, `[`…`]` är en teckenklass
 * och `\` dess escape-tecken. Alla fyra gör ett prefix till ett MÖNSTER i stället
 * för en sträng.
 */
const GLOBTECKEN = /[*?[\]\\]/

/** IPv4 i punktform eller IPv6 (som alltid bär kolon). Se `bullQueueOptions`. */
const ÄR_IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|.*:)/

/**
 * Maskerar varje redis-adress som råkar ligga inbäddad i en text.
 *
 * Finns för EN väg: `--confirm` ekas tillbaka till operatören, och `--confirm`
 * och `--redis-url` bär båda en `redis://…`-sträng. Att klistra fel av de två är
 * nära till hands, och då hade lösenordet hamnat på stderr genom den enda väg
 * som inte gick genom `redactRedisUrl`. Funnet av en granskare.
 */
export function maskeraAdresser(text: string): string {
  // `i`-FLAGGAN BÄR. Utan den gick en versal adress rakt igenom:
  //
  //   --confirm=REDIS://user:SYNTHETIC_TEST_VALUE@h:6379/0
  //     angivet:   REDIS://user:SYNTHETIC_TEST_VALUE@h:6379/0
  //
  // Uppmätt genom hela CLI:s felväg av en granskare. `new URL()` normaliserar
  // schemat, så själva maskeringen klarade formen — det var matchningen som inte
  // såg den.
  const medAdresserMaskerade = text.replace(/rediss?:\/\/\S+/gi, (m) => redactRedisUrl(m))

  // SISTA UTVÄGEN: en userinfo-del i något som INTE såg ut som en redis-adress.
  // En `//nånting:nånting@`-sekvens är nästan säkert en credential och nästan
  // säkert inte måltext. NÄSTAN: ett `--prefix` med ett `@` i skulle hamna i
  // måltexten, så premissen "måltexten bär aldrig ett @" — som stod här — är
  // inte sann. Regeln är ändå rätt riktning, och `--confirm` ekas numera inte
  // alls som rå text (se `beskrivConfirm`), så den här är ett bälte till hängslet.
  return medAdresserMaskerade.replace(/\/\/[^\s/@]*:[^\s/@]*@/g, '//***:***@')
}

/**
 * Hur en FELAKTIG `--confirm` beskrivs — aldrig som rå användartext.
 *
 * `maskeraAdresser` täcker bara ADRESSFORMADE strängar. En felpastad bar
 * hemlighet (`--confirm=SYNTHETIC_TEST_VALUE`, eller `user:pw@h:6379` utan
 * snedstreck) ekades oförändrad. Mätt av en granskare.
 *
 * Och ekot behövs inte: operatören ser sin egen inmatning i sitt skal, och det
 * felet ska säga är vilken text som FÖRVÄNTADES. Den står redan på raden ovanför
 * och är per konstruktion credentialfri. Här räcker därför en beskrivning — om
 * något angavs, och om det ens liknade en adress.
 */
export function beskrivConfirm(confirm: string | undefined): string {
  if (confirm === undefined) return '(inget)'
  if (confirm === '') return '(tom sträng)'
  const adressformad = /^rediss?:\/\//iu.test(confirm)
  return adressformad
    ? `(en adress angavs, men den matchar inte måltexten ovan — ${confirm.length} tecken)`
    : `(något angavs som inte ens är en redis-adress — ${confirm.length} tecken, återges inte)`
}

/**
 * ETT PREFIX ÄR EN STRÄNG, INTE ETT MÖNSTER — och skillnaden är en spärr.
 *
 * `scanQueueNames` bygger `MATCH ${prefix}:*:${suffix}`. Är prefixet självt ett
 * glob läser SCAN ett ANNAT nyckelrum än det Bull sedan muterar, för Bull
 * behandlar `keyPrefix` bokstavligt. Tommålsspärren passeras då av nycklar som
 * inte ligger där åtgärden landar.
 *
 * Uppmätt mot isolerad riktig Redis 7.4.8, seedad med `bull:pdf:id` och
 * `bull:mail:high:id`. Kolumnen "utan literalkontroll" är loopkroppen SOM DEN SÅG
 * UT FÖRE den här rättningen — den bokstavliga per-träff-kontrollen i
 * `scanQueueNames` infördes i samma commit som den här spärren, och utan den
 * skillnaden är talen inte reproducerbara mot dagens kod:
 *
 *   prefix        utan literalkontroll          med (dagens kod)
 *   "bu?l"        pdf, mail:high, psd2-sync     []
 *   "bul*"        pdf, mail:high, psd2-sync     []
 *   "b[ua]ll"     "2-sync", "l:high"            []
 *
 * Den sista raden är värd att dröja vid: namnet skalas fram med `prefix.length`,
 * och ett mönster som är längre än strängen det matchar ger inte bara fel mål
 * utan STYMPADE könamn. Utfallet var alltså inte ens internt konsekvent.
 *
 * DE TVÅ SPÄRRARNA ÄR INTE SAMMA SPÄRR, och det är skälet att båda finns. Den
 * bokstavliga kontrollen gör SCAN-resultatet tomt, vilket leder till att en
 * muterande åtgärd vägras av tommålsspärren. Men `--allow-empty-target` häver
 * just den vägran — och då hade Bull pausat under det bokstavliga globprefixet.
 * Avvisningen här är det som stoppar den vägen.
 *
 * Valet är att AVVISA i stället för att escapea. Ett escapeat glob hade gett en
 * korrekt SCAN mot ett prefix som ändå inte kan vara ett Bull-prefix i den här
 * appen — alltså komplexitet utan ett legitimt fall bakom sig.
 *
 * @throws när prefixet är tomt eller bär ett Redis-metatecken.
 */
export function assertScanSafePrefix(prefix: string): void {
  if (prefix === '') {
    throw new Error(
      '--prefix är tomt. Ett tomt prefix gör MATCH-mönstret till `:*:id`, som ' +
        'inte kan matcha en Bull-nyckel — läsningen hade då svarat "tomt mål" om ' +
        'varje Redis, hur full den än är.',
    )
  }
  if (GLOBTECKEN.test(prefix)) {
    throw new Error(
      `--prefix '${prefix}' bär ett Redis-metatecken (* ? [ ] \\). Ett prefix är en ` +
        'STRÄNG för Bull och ett MÖNSTER för SCAN. Uppmätt mot riktig Redis ' +
        'träffar `bu?l:*:id` nycklarna under `bull:`, medan Bull muterar det ' +
        'BOKSTAVLIGA prefixet `bu?l` — alltså ett annat nyckelrum än det som lästes.',
    )
  }
}

/**
 * Tolkar `--redis-url` EN gång, till en validerad form, eller avvisar den.
 *
 * ── VARFÖR URL:EN ALDRIG FÅR TOLKAS TVÅ GÅNGER ──────────────────────────────
 *
 * Verktyget skickade tidigare URL-STRÄNGEN vidare till `new Bull(name, url, …)`.
 * Måltexten räknades då fram med `new URL()` och anslutningen med Bulls egen
 * `redisOptsFromUrl` — två olika tolkningar av samma sträng. De går isär, och
 * det är mätt nätverksfritt mot oförändrad Bull 4.16.5 med en inspelande
 * ioredis-attrapp:
 *
 *   redis://display.example:6379/0?db=2&host=actual.example&port=6381
 *     bekräftelsen visade   redis://display.example:6379/db0 prefix=bull
 *     klienten FICK         host=actual.example port=6381 db=2
 *
 *   redis://h.example:6379/0?keyPrefix=actual-prefix
 *     SCAN läste prefix     bull
 *     Bull muterade prefix  actual-prefix
 *
 * `queue.js:352-354` spretar in hela queryn i optionerna EFTER värd/port/db, så
 * varje parameter med ett optionsnamn vinner över det bekräftelsen visade. Den
 * andra raden är den farligaste: den läser ett nyckelrum och pausar ett annat,
 * alltså precis det tommålsspärren finns för att omöjliggöra.
 *
 * Därför avvisas query och fragment HELT. En begränsad och dokumenterad form är
 * bättre än ett tyst alternativt mål — och behövs en option som bara går att nå
 * genom queryn ska den läggas till som en egen flagga, synlig i måltexten.
 *
 * @throws när formen inte är exakt `redis://`- eller `rediss://`-formen nedan.
 */
export function parseRedisTarget(redisUrl: string, prefix: string): RedisTarget {
  let u: URL
  try {
    u = new URL(redisUrl)
  } catch {
    // Adressen återges INTE — en sträng vi inte kan tolka kan vara en credential.
    throw new Error(
      '--redis-url går inte att tolka som en URL. Formen är ' +
        'redis://[användare:lösenord@]värd[:port][/db] (eller rediss://), utan ' +
        'query och utan fragment. Adressen återges inte här: en oparserbar sträng ' +
        'kan mycket väl vara en hel credential.',
    )
  }

  const schema = u.protocol.replace(/:$/, '')
  if (schema !== 'redis' && schema !== 'rediss') {
    // SCHEMAT ÅTERGES INTE. `--redis-url=SYNTHETIC_TEST_VALUE:x` tolkas av
    // `new URL()` med hemligheten som schema, och den interpolerades hit.
    throw new Error(
      '--redis-url har ett schema som inte stöds (det återges inte här — en ' +
        'felpastad sträng kan tolkas som ett schema). Endast redis:// och rediss:// ' +
        'stöds. En form vi inte kan bära vidare utan att tappa en egenskap avvisas ' +
        'före anslutning — aldrig genom en tyst nedgradering.',
    )
  }

  if (u.search !== '') {
    // INGENTING UR QUERYN ÅTERGES — VARKEN NAMN ELLER VÄRDE.
    //
    // Regeln höll tidigare tillbaka bara led UTAN `=`, med resonemanget att ett
    // `namn=värde`-par har ett namn som är säkert att visa. Det resonemanget var
    // fel, och motexemplet är trivialt:
    //
    //   --redis-url=redis://h.example:6379/0?SYNTHETIC_TEST_VALUE=
    //     [queue-ops] AVBRUTEN: --redis-url bär 1 queryparameter(rar)
    //                           (SYNTHETIC_TEST_VALUE). …
    //
    // Ett likhetstecken gör inte namnet betrott. Den som klistrar en credential
    // i fel flagga kan lika gärna få med ett efterföljande `=`, och samma sak
    // gäller ett par där hemligheten står i NAMNET.
    //
    // ANTALET OCH EN FAST ORSAK RÄCKER. Operatören behöver veta att det var
    // queryn som fällde adressen och hur många led den bar; vilka de hette
    // tillför ingenting när formen ändå är avvisad. Måltexten är oförändrat
    // säker och skrivs separat.
    const antalLed = u.search.slice(1).split('&').filter(Boolean).length
    throw new Error(
      `--redis-url bär ${antalLed} queryparameter(rar). Namn och värden återges inte — ` +
        'ett queryled kan bära en credential i BÅDA leden, och formen är ändå avvisad. ' +
        'Den avvisas därför att Bull 4.16.5 låter queryn ersätta värd, port, databas ' +
        'och keyPrefix EFTER att måltexten räknats fram, alltså ett tyst alternativt ' +
        'mål. Ange värd, port och databas i URL:ens egen form och prefixet med --prefix.',
    )
  }
  if (u.hash !== '') {
    throw new Error(
      '--redis-url bär ett fragment (#…). Fragmentet ingår inte i den ' +
        'dokumenterade formen och tolkas inte av någon av parterna lika — det ' +
        'avvisas hellre än bärs vidare otolkat.',
    )
  }

  // IPv6 kommer med klamrar ur `new URL`; ioredis vill ha adressen utan.
  const rawHost = u.hostname
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (host === '') {
    throw new Error('--redis-url saknar värd. Formen är redis://VÄRD[:port][/db].')
  }

  const bana = u.pathname.replace(/^\//, '')
  if (bana !== '' && !/^[0-9]{1,5}$/.test(bana)) {
    // LEDET ÅTERGES INTE. `redis://h:6379/SYNTHETIC_TEST_VALUE` la hemligheten
    // i sökvägen, och den stod både här och på den maskerade loggraden.
    throw new Error(
      '--redis-url har ett databasindex som inte är ett heltal (värdet återges inte ' +
        'här). Bull läser samma led som ett tal; en sökväg som inte är det hade gett ' +
        'databas NaN i klienten och db0 i måltexten.',
    )
  }
  const db = bana === '' ? 0 : Number(bana)

  // Procentavkodning, EN gång och med flit: `new URL` lämnar användare och
  // lösenord kodade, och ett lösenord med `@` eller `/` måste kodas för att
  // URL:en ska gå att tolka alls.
  let username: string | undefined
  let password: string | undefined
  try {
    username = u.username === '' ? undefined : decodeURIComponent(u.username)
    password = u.password === '' ? undefined : decodeURIComponent(u.password)
  } catch {
    throw new Error(
      '--redis-url har en trasig procentkodning i användare eller lösenord. ' +
        'Värdena återges inte här.',
    )
  }

  assertScanSafePrefix(prefix)

  return {
    schema,
    host,
    port: u.port === '' ? 6379 : Number(u.port),
    db,
    prefix,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    tls: schema === 'rediss',
  }
}

/**
 * Måltexten. Den här strängen är BÅDE utskriften och det operatören måste
 * upprepa i `--confirm`, och det är avsiktligt en och samma funktion: två
 * formuleringar hade gjort bekräftelsen möjlig att uppfylla av misstag.
 *
 * Den är nu härledd ur `RedisTarget` och INTE ur råsträngen. Det är hela poängen
 * med fynd 1: en måltext som läses ur en annan tolkning än anslutningens kan
 * beskriva ett mål som aldrig kontaktas.
 *
 * Den bär varken användarnamn, lösenord eller query — men den ÄR inte
 * credentialfri "per konstruktion", vilket den här kommentaren tidigare påstod:
 * `--prefix` går rakt in i texten, så en hemlighet klistrad DÄR skrivs ut, både
 * i klartextläget och i `--json`. Måltexten måste kunna upprepas ordagrant, så
 * prefixet kan inte maskeras. Gränsen står i filens huvud.
 *
 * SCHEMAT MÅSTE MED. `redis://h:6379/0` och `rediss://h:6379/0` är två olika mål
 * — ofta en oskyddad och en TLS-skyddad instans — och utan det ledet delade de
 * samma måltext, alltså samma giltiga --confirm.
 */
export function describeTarget(mal: RedisTarget): string {
  const värd = mal.host.includes(':') ? `[${mal.host}]` : mal.host
  return `${mal.schema}://${värd}:${mal.port}/db${mal.db} prefix=${mal.prefix}`
}

/**
 * Bulls anslutnings- och köoptioner, härledda ur SAMMA validerade form som
 * måltexten. Bull får ett OPTIONSOBJEKT och aldrig strängen — det är det som
 * omöjliggör en andra, avvikande tolkning.
 *
 * ── TLS BÄRS UTTRYCKLIGEN ───────────────────────────────────────────────────
 *
 * `rediss://` gav tidigare INGEN TLS. Bull omvandlar URL:en till ett
 * optionsobjekt utan `tls`, och ioredis egen `rediss`-detektering gäller bara
 * STRÄNGARGUMENTET — som ioredis aldrig ser. Uppmätt: rapporten sa `rediss`,
 * klientoptionerna saknade `tls`, och ioredis valde vanlig nätverksanslutning.
 * Alltså en tyst nedgradering, i det enda läge verktyget påstår sig vara skyddat.
 *
 * `rejectUnauthorized` sätts UTTRYCKLIGEN till true. Node har det som default,
 * men `NODE_TLS_REJECT_UNAUTHORIZED=0` i operatörens skal hade annars slagit
 * igenom — och en operatörsterminal är precis den miljö verktyget är byggt för
 * att misstro.
 */
export function bullQueueOptions(mal: RedisTarget): Bull.QueueOptions {
  return {
    prefix: mal.prefix,
    redis: {
      host: mal.host,
      port: mal.port,
      db: mal.db,
      ...(mal.username !== undefined ? { username: mal.username } : {}),
      ...(mal.password !== undefined ? { password: mal.password } : {}),
      // `servername` BARA för ett värdnamn. RFC 6066 tillåter inte SNI för en
      // IP-adress, och Node varnar (DEP0123) och aviserar att den kommer att
      // ignoreras. Identitetskontrollen faller då tillbaka på IP-SAN i
      // certifikatet, vilket är rätt beteende — och `rejectUnauthorized`
      // står kvar oavsett. Funnet av en granskare.
      ...(mal.tls
        ? {
            tls: {
              ...(ÄR_IP.test(mal.host) ? {} : { servername: mal.host }),
              rejectUnauthorized: true,
            },
          }
        : {}),
    },
  }
}

function log(msg: string): void {
  // console.log är bannlyst i projektet.
  console.warn(`[queue-ops] ${msg}`)
}

async function readQueue(queue: Queue): Promise<QueueReport> {
  // `getJobCounts()` UTAN argument — Bull 4.16.5:s signatur. `isPaused(false)`
  // är den GLOBALA flaggan; `isPaused(true)` hade bara sagt något om den här
  // klienten, alltså om verktyget självt, vilket vore meningslöst.
  const [pausedGlobally, counts, repeatable] = await Promise.all([
    queue.isPaused(false),
    queue.getJobCounts(),
    queue.getRepeatableJobs(0, -1, true),
  ])
  return {
    name: queue.name,
    pausedGlobally,
    counts: counts as unknown as Record<string, number>,
    repeatableCount: repeatable.length,
  }
}

/**
 * Vilka könamn har faktiskt spår under prefixet? Läses ur Redis och inte ur
 * koden, så att en TOLFTE kö som ingen lagt till i inventeringen blir SYNLIG i
 * stället för att tyst saknas.
 *
 * ── SUFFIXEN ÄR MÄTTA, INTE GISSADE ─────────────────────────────────────────
 *
 * Bull 4.16.5 har ingen `:meta`-nyckel — det är BullMQ:s form, och en skanning
 * efter den ger NOLL mot varje verklig Bull-kö. Det är exakt det falska lugn
 * filen finns för att undvika, och det inträffade under utvecklingen av just den
 * här funktionen.
 *
 * Uppmätt mot en riktig, seedad Bull 4.16.5-instans skapas `:id` (jobbräknaren)
 * av första `add`, och `:wait`/`:delayed` av jobben. `:meta-paused` skapas av en
 * global paus — och den är med av ett eget skäl: en TOM men PAUSAD kö har inga
 * jobbnycklar alls, och skulle utan det suffixet försvinna ur inventeringen
 * precis när den är som mest intressant.
 */
export const KO_MARKORSUFFIX = ['id', 'wait', 'delayed', 'meta-paused'] as const

export async function scanQueueNames(
  client: { scan: (...a: unknown[]) => Promise<[string, string[]]> },
  prefix: string,
): Promise<string[]> {
  // FÖRE första kommandot. Ett globprefix gör MATCH till ett mönster över ett
  // annat nyckelrum än det Bull sedan muterar — se `assertScanSafePrefix`.
  // Kontrollen ligger här OCH i `parseRedisTarget`, därför att den här
  // funktionen är exporterad och kan nås utan att gå genom målvalideringen.
  assertScanSafePrefix(prefix)

  const found = new Set<string>()
  for (const suffix of KO_MARKORSUFFIX) {
    const inledning = `${prefix}:`
    const avslutning = `:${suffix}`
    let cursor = '0'
    do {
      // SCAN och inte KEYS: KEYS blockerar hela Redis-instansen, och verktyget
      // är skrivet för att kunna riktas mot en produktionsinstans i LÄSLÄGE.
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}:*:${suffix}`, 'COUNT', 500)
      cursor = next
      for (const key of keys) {
        // BOKSTAVLIG KONTROLL PÅ VARJE TRÄFF, inte bara på mönstret. Att MATCH
        // gav en träff säger bara att nyckeln matchade ETT MÖNSTER; det som ska
        // gälla är att den ligger under exakt det prefix åtgärden kommer att
        // mutera. Kontrollen är billig och är den enda som håller om Redis
        // globregler skulle skilja sig från vår bild av dem.
        if (!key.startsWith(inledning) || !key.endsWith(avslutning)) continue
        // `<prefix>:<könamn>:<suffix>` — könamnet kan självt innehålla kolon
        // (`mail:high`), så namnet skalas fram från ändarna i stället för att
        // splittas på kolon och tas på index 1.
        const utan = key.slice(inledning.length, key.length - avslutning.length)
        if (utan) found.add(utan)
      }
    } while (cursor !== '0')
  }
  return [...found].sort()
}

/**
 * ETT STAVFEL I `--queues` SKA AVBRYTA, inte "pausa" en kö som inte finns.
 *
 * `new Bull('mail-high', …).pause(false)` LYCKAS — Bulls pause-script sätter
 * `meta-paused` villkorslöst, även för ett namn ingen konsument lyssnar på.
 * Bindestreck i stället för kolon hade alltså gett raden
 * `mail-high: globalPaus=true`, operatören hade bockat av mejlköerna, och
 * `mail:high` hade konsumerat vidare.
 *
 * Egen exporterad funktion, inte en rad inuti `runQueueOps`, så att den går att
 * pröva utan att en Redis-anslutning öppnas — kontrollen ligger med flit FÖRE
 * anslutningen, och ett prov som måste ansluta för att nå den hade mätt
 * anslutningen i stället.
 *
 * ── OCH DUBBLETTER AVVISAS ──────────────────────────────────────────────────
 *
 * En upprepning är inte ofarlig här, därför att den tidigare kunde LÅTSAS vara
 * fullständighet. Uppmätt i ett nätverksfritt anrop av verkliga `runQueueOps`
 * med elva förekomster av `pdf`:
 *
 *   inventeringKomplett = true
 *   funnaIRedis         = 11
 *   åtgärdade           = pdf, elva gånger
 *
 * De tio andra köerna rördes aldrig, och utfallet gick att redovisa som en
 * fullständig avskärmning. Att avvisa i stället för att tyst deduplicera är
 * samma val som för stavfelet ovan: en operatör som skrivit samma namn elva
 * gånger menade något annat, och ska få veta det.
 *
 * @throws när något begärt namn saknas i kodens inventering, eller upprepas.
 */
export function assertKnownQueues(begarda: readonly string[]): void {
  const okanda = begarda.filter((n) => !ALLA_KONAMN.includes(n))
  if (okanda.length > 0) {
    throw new Error(
      `--queues innehåller namn som inte finns i kodens inventering: ` +
        `${okanda.join(', ')}. Giltiga: ${ALLA_KONAMN.join(', ')}.`,
    )
  }

  const antal = new Map<string, number>()
  for (const n of begarda) antal.set(n, (antal.get(n) ?? 0) + 1)
  const dubbletter = [...antal].filter(([, c]) => c > 1).map(([n, c]) => `${n} (x${c})`)
  if (dubbletter.length > 0) {
    throw new Error(
      `--queues innehåller upprepade namn: ${dubbletter.join(', ')}. En upprepning ` +
        'blåser upp antalet begärda köer utan att täcka en enda extra kö — och ' +
        'fullständighetsomdömet räknade tidigare LISTLÄNGD, så elva `pdf` lästes ' +
        'som alla elva köerna. Ange varje kö en gång.',
    )
  }
}

export interface RunOptions {
  redisUrl: string
  prefix: string
  action: QueueAction
  /** Begärda könamn. Utelämnad = kodens fulla mängd. */
  queues?: readonly string[]
  confirm?: string
  /**
   * Tillåt en muterande åtgärd mot ett mål där INGEN begärd kö har spår.
   *
   * Finns för det legitima fallet: en nyprovisionerad Redis, eller en instans
   * efter `FLUSHDB` under en incident, som ska förberedas-pausas INNAN appen
   * startar. Utan flaggan hade verktyget gjort just det omöjligt.
   *
   * `inventeringKomplett` förblir `false` — flaggan häver vägran, aldrig
   * omdömet. Ett utfall med den här flaggan får alltså aldrig redovisas som en
   * verifierad avskärmning.
   */
  allowEmptyTarget?: boolean
}

export async function runQueueOps(opts: RunOptions): Promise<OpsResult> {
  // EN tolkning, före allt annat. Både måltexten och anslutningsoptionerna
  // härleds härifrån — se `parseRedisTarget` för varför en andra tolkning är
  // det farligaste enskilda felet i den här filen.
  const mal = parseRedisTarget(opts.redisUrl, opts.prefix)
  const target = describeTarget(mal)
  const begarda = opts.queues && opts.queues.length > 0 ? [...opts.queues].sort() : [...ALLA_KONAMN]

  assertKnownQueues(begarda)

  if (opts.action !== 'inspect') {
    if (opts.confirm !== target) {
      throw new Error(
        `--action=${opts.action} kräver --confirm med EXAKT måltexten.\n` +
          `  förväntat: ${target}\n` +
          `  angivet:   ${beskrivConfirm(opts.confirm)}\n` +
          'Kör först utan --action och läs måltexten ur rapporten.',
      )
    }
  }

  // OPTIONSOBJEKT, aldrig strängen: `new Bull(name, url, …)` hade låtit Bull
  // tolka `--redis-url` en andra gång med sin egen parser, och queryn hade då
  // kunnat ersätta värd, port, databas och prefix EFTER att `target` räknats
  // fram. Formen är avvisad i `parseRedisTarget`, och det här är den andra
  // halvan av samma spärr: även en form som slinker förbi kan inte längre nå
  // Bulls URL-väg.
  const bullOpts = bullQueueOptions(mal)
  const koer = begarda.map((name) => new Bull(name, bullOpts))
  const atgardade: string[] = []
  try {
    await Promise.all(koer.map((q) => q.isReady()))

    const client = koer[0]!.client as unknown as {
      scan: (...a: unknown[]) => Promise<[string, string[]]>
      info: (section: string) => Promise<string>
      client: (underkommando: string) => Promise<string>
    }
    const redisInfo = await client.info('server')
    const redisVersion = /redis_version:([^\r\n]+)/.exec(redisInfo)?.[1]?.trim() ?? '(okänd)'

    // ── DATABASINDEXET MÄTS PÅ DEN LEVANDE ANSLUTNINGEN ───────────────────
    //
    // Formkontrollen i `parseRedisTarget` säger bara att ledet ÄR ett tal. Den
    // säger ingenting om att servern accepterade det, och ioredis kör `SELECT` i
    // sin `connectHandler` och SVÄLJER felet (`silentEmit('error', …)`):
    // anslutningen blir `ready` på db 0 ändå. Uppmätt mot riktig Redis 7.4.8 med
    // två seedade nycklar i db0:
    //
    //   --redis-url=redis://127.0.0.1:6399/99
    //     måltext             redis://127.0.0.1:6399/db99 prefix=sond-d1
    //     funnaIRedis         2
    //     inventeringKomplett true          ← "inventering komplett: JA"
    //     åtgärden landade i  db 0
    //
    // Det är samma defekt som queryn, via ett annat led: bekräftelsen beskriver
    // ett mål som aldrig kontaktades. `redis://…/16` mot en standardinstans
    // (`databases 16`, alltså index 0-15) är en helt vanlig operatörsmiss.
    //
    // `CLIENT INFO` är det enda stället där servern SJÄLV säger vilken databas
    // anslutningen står i. Går den inte att läsa vägrar vi — en spärr som tyst
    // hoppas över när den inte kan mäta är ingen spärr.
    let faktiskDb: number
    try {
      const klientInfo = await client.client('INFO')
      const träff = /(?:^|\s)db=(\d+)/.exec(klientInfo)
      if (!träff) throw new Error('CLIENT INFO saknar db=')
      faktiskDb = Number(träff[1])
    } catch (err) {
      throw new Error(
        'kunde inte läsa CLIENT INFO för att verifiera databasindexet ' +
          `(${err instanceof Error ? err.message : String(err)}). Utan den läsningen kan ` +
          'verktyget inte veta vilken databas det står i: ioredis sväljer ett misslyckat ' +
          'SELECT och blir ready på db 0 ändå. Kräver Redis 6.2 eller senare.',
      )
    }
    if (faktiskDb !== mal.db) {
      throw new Error(
        `måltexten säger db${mal.db}, men anslutningen står i db${faktiskDb}. ` +
          'ioredis SELECT misslyckades och felet sväljs tyst, så läsningen hade beskrivit ' +
          'en databas den aldrig var i — och en åtgärd hade landat i ' +
          `db${faktiskDb}. Kontrollera databasindexet i --redis-url mot instansens ` +
          '`databases`-inställning.',
      )
    }

    const iRedis = await scanQueueNames(client, mal.prefix)
    const iRedisMangd = new Set(iRedis)
    const kodensMangd = new Set(ALLA_KONAMN)
    const begardaMangd = new Set(begarda)
    const utanSparIRedis = ALLA_KONAMN.filter((n) => !iRedisMangd.has(n))
    const okandaIRedis = iRedis.filter((n) => !kodensMangd.has(n))
    // MÄNGDER, INTE LISTLÄNGDER. `begarda.length === ALLA_KONAMN.length` var
    // sant för elva `pdf`, och gav ett urval på EN kö fullständigt klartecken
    // medan tio köer stod orörda. Dubbletter avvisas numera redan i
    // `assertKnownQueues`, men omdömet får inte vila på att den spärren håller:
    // det är jämförelsen här som är påståendet.
    const allaBegarda =
      begardaMangd.size === kodensMangd.size && [...kodensMangd].every((n) => begardaMangd.has(n))
    const funnaIRedis = [...begardaMangd].filter((n) => iRedisMangd.has(n)).length
    // ASYMMETRIN ÄR AVSIKTLIG. En ENSKILD kö utan spår i Redis kan inte
    // konsumera något — den är ofarlig, och en kö som aldrig fått ett jobb har
    // inga nycklar. En kö i Redis som koden inte känner till är motsatsen: den
    // kan ha en konsument vi inte inventerat.
    //
    // MEN NOLL FUNNA ÄR INTE SAMMA SAK SOM ELVA OFARLIGA. Hittas ingen enda av
    // de begärda köerna är den överlägset troligaste förklaringen fel prefix,
    // fel databasindex eller fel Redis — inte att produktionen aldrig kört ett
    // jobb. Utan det ledet svarade verktyget "komplett: JA" mot ett tomt
    // prefix, vilket ett granskningsfynd visade skarpt.
    const inventeringKomplett = allaBegarda && okandaIRedis.length === 0 && funnaIRedis > 0

    if (
      (opts.action === 'pause' || opts.action === 'resume') &&
      funnaIRedis === 0 &&
      !opts.allowEmptyTarget
    ) {
      // VÄGRA, i stället för att lyckas. Bulls `pause(false)` sätter
      // `meta-paused` villkorslöst och lyckas alltid — även för ett könamn som
      // inte finns. En paus mot fel mål är därför inte ett fel som märks; den
      // ser ut som elva pausade köer. Enda sättet att skilja fallen åt är att
      // kräva att målet bevisligen BÄR köerna.
      throw new Error(
        `ingen av de ${begarda.length} begärda köerna har spår under ` +
          `${target}. Bull:s pause/resume lyckas även mot ett könamn som inte finns, ` +
          'så en åtgärd här hade rapporterat framgång mot fel prefix, fel ' +
          'databasindex eller fel Redis. Läsläget svarar likadant — kontrollera ' +
          'måltexten mot den instans appen faktiskt använder. Är målet TOMT MED ' +
          'FLIT (nyprovisionerad eller nyss flushad Redis): --allow-empty-target. ' +
          'Inventeringen förblir då ofullständig.',
      )
    }

    if (opts.action === 'pause' || opts.action === 'resume') {
      for (const q of koer) {
        // GLOBAL (`false`), inte lokal. En lokal paus hade bara gällt den här
        // kortlivade processen och varit verkningslös i samma ögonblick
        // verktyget avslutas.
        if (opts.action === 'pause') await q.pause(false)
        else await q.resume(false)
        atgardade.push(q.name)
      }
    }

    // Läses EFTER åtgärden, så rapporten visar utfallet och inte avsikten.
    const queues: QueueReport[] = []
    for (const q of koer) queues.push(await readQueue(q))

    return {
      action: opts.action,
      target,
      bullVersion: BULL_VERSION,
      redisVersion,
      inventeringKomplett,
      funnaIRedis,
      utanSparIRedis,
      okandaIRedis,
      queues,
      atgardade,
    }
  } finally {
    await Promise.all(koer.map((q) => q.close()))
  }
}

/* istanbul ignore next -- entry point; logiken provas via runQueueOps */
function parseArgs(argv: readonly string[]): RunOptions {
  const get = (namn: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${namn}=`))?.slice(namn.length + 3)

  const redisUrl = get('redis-url')
  if (!redisUrl) {
    throw new Error(
      '--redis-url saknas. Verktyget läser med flit INTE REDIS_URL ur ' +
        'miljön — ett verktyg som kör mot "det som råkade stå i miljön" antar ' +
        'produktion som standard.',
    )
  }
  const action = (get('action') ?? 'inspect') as QueueAction
  if (!['inspect', 'pause', 'resume'].includes(action)) {
    throw new Error(`okänd --action='${action}'. Giltiga: inspect | pause | resume.`)
  }
  const queues = get('queues')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    redisUrl,
    prefix: get('prefix') ?? 'bull',
    action,
    ...(queues ? { queues } : {}),
    ...(get('confirm') !== undefined ? { confirm: get('confirm')! } : {}),
    ...(argv.includes('--allow-empty-target') ? { allowEmptyTarget: true } : {}),
  }
}

/* istanbul ignore next -- entry point */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)

  // MÅLBESKRIVNINGEN, INTE ADRESSEN. Den är härledd ur den validerade formen och
  // kan per konstruktion inte bära en credential eller en godtycklig query.
  // Råadressen skrivs bara när den AVVISATS, och bara maskerad — då behöver
  // operatören se vilken adress som föll, men inte dess hemligheter.
  let mal
  try {
    mal = parseRedisTarget(opts.redisUrl, opts.prefix)
  } catch (err) {
    log(`avvisad --redis-url: ${redactRedisUrl(opts.redisUrl)}`)
    throw err
  }
  log(`mål: ${describeTarget(mal)} · action=${opts.action}`)

  const result = await runQueueOps(opts)

  if (argv.includes('--json')) {
    console.warn(JSON.stringify(result, null, 2))
  } else {
    log(`bull ${result.bullVersion} · redis ${result.redisVersion}`)
    log(
      `inventering komplett: ${result.inventeringKomplett ? 'JA' : 'NEJ'}` +
        ` · köer med spår: ${result.funnaIRedis}/${result.queues.length}` +
        (result.utanSparIRedis.length
          ? ` · utan spår i Redis: ${result.utanSparIRedis.join(', ')}`
          : '') +
        (result.okandaIRedis.length ? ` · okända i Redis: ${result.okandaIRedis.join(', ')}` : ''),
    )
    for (const q of result.queues) {
      const c = q.counts
      log(
        `${q.name}: globalPaus=${q.pausedGlobally} waiting=${c.waiting ?? 0} ` +
          `active=${c.active ?? 0} delayed=${c.delayed ?? 0} paused=${c.paused ?? 0} ` +
          `completed=${c.completed ?? 0} failed=${c.failed ?? 0} repeatable=${q.repeatableCount}`,
      )
    }
    if (result.atgardade.length > 0)
      log(`${result.action} utförd på: ${result.atgardade.join(', ')}`)
    else log('läsläge — ingenting skrevs')
  }

  if (!result.inventeringKomplett) {
    log(
      'OBS: inventeringen är INTE komplett. Utfallet får inte redovisas som en ' +
        'verifierad produktionsavskärmning.',
    )
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[queue-ops] AVBRUTEN:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
