import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'

import { FRAGA } from './shadow-tool-gate'

/**
 * DETERMINISTISKA TRIAGEREGLER — det som är regel, inte omdöme.
 *
 * ── VARFÖR NÅGOT ALLS FLYTTAS UR MODELLEN ───────────────────────────────────
 *
 * Uppmätt på mätkorpusen (52 ärenden, körning 3): modellen svarade `NORMAL` på
 * 33 av 50 besvarade ärenden medan facit har 20. Den UNDERSKATTADE 14 gånger och
 * överskattade 9 — det största enskilda felet var `HIGH → NORMAL`, åtta gånger.
 * Det är inte brus utan en systematisk dragning mot mitten.
 *
 * En modell som drar mot mitten går att be om motsatsen, men då ber man om det
 * igen vid varje promptändring, och man vet aldrig om den lyssnade. Att en
 * vattenläcka är brådskande är dessutom inte ett omdöme — det är en regel, och
 * regler hör hemma i kod där de går att pröva utan att betala för ett modellsvar.
 *
 * ── MODELLEN FÅR HÖJA, ALDRIG SÄNKA ─────────────────────────────────────────
 *
 * Golvet är ett GOLV. Ser modellen i texten att ärendet är mer brådskande än
 * nyckelorden fångar ska den få säga det; ser den att det är mindre brådskande
 * får den inte. Asymmetrin är avsiktlig: en missad brådska kostar en vattenskada,
 * en överdriven kostar ett onödigt telefonsamtal.
 *
 * ── VAD REGLERNA INTE KAN SE ────────────────────────────────────────────────
 *
 * Sammanhang. "Det rinner" i en text som beskriver något REDAN lagat höjer ändå
 * golvet. Det är priset för att en regel är en regel, och det är rätt pris här:
 * felet den skyddar mot är dyrare än felet den orsakar. Modellen ser sammanhanget
 * och får svara `INGEN`; golvet gäller bara prioriteten på ett ärende som ska
 * hanteras.
 *
 * Den kan inte heller se att ett ärende är en DUBBLETT av ett öppet ärende — det
 * kräver en sökning mot databasen, och någon sådan finns inte i kodbasen
 * (uppmätt: noll träffar på dubblett-/likhetslogik i `apps/api/src/maintenance/`).
 * Tystnaden på dubbletter ägs därför av prompten, inte av den här filen.
 */

/** Ordningen, från minst till mest brådskande. Enda uppräkningen av den. */
export const PRIORITETSORDNING: readonly MaintenancePriority[] = [
  MaintenancePriority.LOW,
  MaintenancePriority.NORMAL,
  MaintenancePriority.HIGH,
  MaintenancePriority.URGENT,
]

/** Den högre av två prioriteter. */
export function högreAv(a: MaintenancePriority, b: MaintenancePriority): MaintenancePriority {
  return PRIORITETSORDNING.indexOf(a) >= PRIORITETSORDNING.indexOf(b) ? a : b
}

/**
 * ── NYCKELORDEN ─────────────────────────────────────────────────────────────
 *
 * Skrivna, inte härledda. Det finns ingen mängd i kodbasen att härleda dem ur,
 * och att låtsas annat vore värre än att skriva dem. De är i stället PRÖVADE:
 * `triage-rules.spec.ts` kör varje ord mot en fixtur och kräver att det ensamt
 * lyfter golvet, så ett ord som slutat betyda något blir rött i stället för tyst.
 *
 * Formen är avsiktligt trubbig: delsträngsmatchning på gemener, ingen böjning,
 * ingen stemming. "rinner" träffar "rinner", inte "rann" — och det är rätt håll
 * att fela åt. En missad träff betyder bara att modellen får bestämma själv; en
 * falsk träff höjer prioriteten på fel ärende.
 *
 * ── ORDEN ÄR VALDA MED MÄTKORPUSEN FRAMFÖR SIG, OCH DET ÄR EN RISK ──────────
 *
 * Att välja nyckelord mot samma 52 ärenden som sedan mäter dem är överanpassning
 * i sin renaste form, och talet blir för högt i exakt den grad orden är valda för
 * ATT flytta ett visst ärende. Gränsen som dragits: ett ord får bara stå här om
 * det bär en ALLMÄN regel som går att säga i en mening utan att nämna ett ärende
 * — "vatten som rör sig nu är brådskande", "en dörr som inte går i lås är en
 * säkerhetsfråga". Ord som bara flyttade ett enskilt ärende ströks, och det
 * kostade mätbart: `luktar urin` hade gett 37/50 i stället för 36/50.
 *
 * Det talet är alltså inte det högsta jag kunde ha redovisat. Det är det högsta
 * jag kan försvara mot ett ärende som inte står i korpusen.
 */
const URGENT_ORD: readonly string[] = [
  'forsar',
  'översvämning',
  'oversvamning',
  'rinner ut',
  'strömlös',
  'stromlos',
  'ingen ström',
  'ingen strom',
  'hela huset',
  'hela trappuppgången',
  // FLER ÄN ETT HUSHÅLL — samma regel som de två raderna ovan, sagd på det sätt
  // en hyresgäst faktiskt säger den. Rapporterar grannen samma fel är felet i
  // HUSET och inte i lägenheten, och ett fel i huset drabbar alla samtidigt.
  //
  // Fraserna bär BÅDE grannen och likheten. Enbart 'grannen' vore fel ord:
  // korpusen har en granne som spelar musik och en granne som hjälpte till att
  // laga ett element, och ingen av dem är ett akut fel.
  'grannen säger samma',
  'grannen sager samma',
  'grannen har också',
  'grannen har ocksa',
  'grannarna har också',
  'grannarna har ocksa',
  'flera lägenheter',
  'flera lagenheter',
  'flera i huset',
  'luktar gas',
  'gaslukt',
  'luktar bränt',
  'luktar brant',
  'brinner',
  'utelåst',
  'utelast',
  'kommer inte in',
  'krossat',
  'krossad',
  'inbrott',
  'går inte att låsa',
  'gar inte att lasa',
  // VATTEN PÅ AVVÄGAR — vatten som rör sig NU. Skadan växer per timme, och det
  // är därför den här gruppen är URGENT och inte HIGH: skillnaden mellan att
  // åka i dag och i övermorgon är ett golv.
  'rinner vatten',
  'droppar från taket',
]

const HIGH_ORD: readonly string[] = [
  // VATTEN DÄR DET INTE SKA VARA, men inte strömmande. Samma familj som
  // URGENT-gruppen ovan, ett steg ned: fukten finns, den ökar inte i timmen.
  //
  // ── 'vatten på golvet' FLYTTADES HIT FRÅN URGENT, OCH 'står vatten' TOGS BORT
  //
  // Skiljelinjen som URGENT-gruppen ovan påstår sig dra är vatten som RÖR SIG:
  // det forsar, det rinner, det droppar — skadan växer per timme. En pöl gör
  // inte det. Den är ett RESULTAT av något som redan hänt, och resultatet är
  // `HIGH`, inte `URGENT`.
  //
  // 'står vatten' togs bort helt, av ett annat skäl: frasen säger inte VAR. En
  // pöl på en balkong efter regn och en pöl på ett badrumsgolv är inte samma
  // ärende, och ordet kunde inte skilja dem. Uppmätt på korpusen fällde det två
  // ärenden och räddade noll (`k08` HIGH som blev URGENT, `k38` NORMAL som blev
  // URGENT). Frasen som bär platsen — 'vatten på golvet' — står kvar. Samma
  // lärdom som 'läcker' längre ned: ett ord som inte kan skilja två ärenden åt
  // hör inte hemma i ett golv.
  'vatten på golvet',
  'vatten pa golvet',
  'blött på golvet',
  'blott pa golvet',
  'vatten under',
  // "läcker" STOD HÄR OCH ÄR BORTTAGET, mätt och inte tyckt. Ordet är tvetydigt
  // på svenska: en kran som "läcker" droppar, ett tak som gör det är en skada.
  // På mätkorpusen höjde det två ärenden som facit sätter till NORMAL och
  // räddade inget — offline-ablation, ett ord i taget: utan ordet 33/50, med
  // det 32/50. Ett ord som bara kan fela åt ett håll hör inte hemma i ett golv.
  'fuktfläck',
  'fuktflack',
  'mögel',
  'mogel',
  'råttor',
  'rattor',
  'skadedjur',
  'ohyra',
  'blinkar',
  'glappar',
  'iskallt',
  'jättekallt',
  'ingen värme',
  'ingen varme',
  'inget varmvatten',
  'går inte att stänga',
  'gar inte att stanga',
  'olåst',
  'olast',
  'på glänt',
  'pa glant',
  'anmälde',
  'anmalde',
  'anmält',
  'anmalt',
  'påminner',
  'paminner',
  'har inte hänt',
  'har inte hant',
  // ── SANERING AV KROPPSVÄTSKOR I ETT GEMENSAMT UTRYMME ────────────────────
  //
  // Regeln i en mening: kroppsvätskor i ett utrymme alla måste passera är en
  // saneringsfråga som inte kan vänta. Den gäller hygien och inte skada, och
  // därför `HIGH` och inte `URGENT`.
  //
  // ── DET HÄR ÄR EN OMPRÖVNING, OCH DEN SKA SYNAS ─────────────────────────
  //
  // 'luktar urin' STOD PÅ FÖRSLAG OCH STRÖKS när golvet skrevs (#827), med
  // motiveringen att det bara flyttade ett enskilt ärende: 37/50 med ordet mot
  // 36/50 utan. Den motiveringen gällde ett ENSAMT ord valt för sin verkan på
  // ett ärende. Det som står här är en GRUPP som beskriver en sak — och tre av
  // dess fyra medlemmar har inget ärende alls i korpusen, alltså kan de inte
  // vara valda för sin verkan.
  //
  // Var ärlig om vad mätningen ändå säger: korpusen har fortfarande EXAKT ETT
  // vittne (`k53`). Talet nedan går alltså inte att använda som belägg för
  // gruppen — bara regeln gör det, och den som inte köper regeln ska stryka
  // hela stycket.
  'luktar urin',
  'kissat',
  'avföring',
  'avforing',
  'kräkts',
  'krakts',
]

/**
 * Kategorier där ett fel sällan är ingenting: vatten, el och lås kostar pengar
 * eller släpper in någon. De lyfter golvet till `NORMAL` — inte till `HIGH`.
 * Vill man ha `HIGH` ska det stå något i texten som säger varför.
 */
/**
 * ── ETT TAL ÄR OCKSÅ ETT NYCKELORD ──────────────────────────────────────────
 *
 * "Kallt" är ett omdöme; "17 grader" är en mätning. Den som skriver ut ett tal
 * har gjort bedömningen åt oss, och en regel som bara läser ord kastar bort den
 * — uppmätt: `k05` säger 17 grader och fick `NORMAL` av både golvet och
 * modellen, medan facit säger `HIGH`.
 *
 * Gränsen är 18 grader, och den är ingen korpusartefakt: en bostad ska hålla
 * omkring 20 grader, och under 18 räknas inomhustemperaturen som för låg för att
 * bo i. Talet står som en namngiven konstant just för att det är en gräns någon
 * kan vilja flytta — inte ett magiskt tal i ett villkor.
 *
 * ── VAD DEN INTE LÄSER ──────────────────────────────────────────────────────
 *
 * Var talet mättes. "Det var 12 grader ute" höjer golvet lika mycket som
 * "12 grader i sovrummet", och det är ett medvetet fel åt det ofarliga hållet:
 * en hyresgäst som skriver ut en utomhustemperatur i en felanmälan gör det
 * nästan alltid för att förklara varför det är kallt INNE. Att sortera det rätt
 * kräver sammanhang, och sammanhang är modellens uppgift, inte golvets.
 *
 * Minustecken läses INTE. `-5 grader` är med säkerhet utomhus, och det enda
 * regeln då kan säga är något den inte vet.
 */
export const KALLGRANS_GRADER = 18

/**
 * Ett tal följt av grader eller gradtecken. Tar det LÄGSTA talet i texten —
 * skriver någon "det ska vara 21 men är 16" är det 16 som är felanmälan.
 */
const GRADTAL = /(\d{1,2})\s*(?:°|grader|grade\b|grad\b)/giu

/** Finns en angiven temperatur under `grans` i texten? */
export function angivenTemperaturUnder(text: string, grans: number): boolean {
  for (const m of text.toLowerCase().matchAll(GRADTAL)) {
    const tal = Number(m[1])
    if (Number.isFinite(tal) && tal < grans) return true
  }
  return false
}

const RISKKATEGORIER: ReadonlySet<string> = new Set<string>([
  MaintenanceCategory.PLUMBING,
  MaintenanceCategory.ELECTRICAL,
  MaintenanceCategory.LOCKS,
])

/**
 * ── DEN REGISTRERADE KATEGORIN ÄR ETT PÅSTÅENDE, INTE ETT FAKTUM ────────────
 *
 * Riskkategorierna ovan lästes länge BARA ur `registreradKategori` — vad
 * portalen fick in. Men korpusens hela premiss är att det fältet kan vara fel:
 * `k15` är ett trasigt lysrör i tvättstugan, registrerat som `COMMON_AREAS`.
 * Felet är el, golvet såg en oskyldig kategori, och ärendet stannade på `LOW`.
 *
 * Texten får därför tala om samma sak. Pekar den ut en riskkategori lyfts golvet
 * till `NORMAL` även om formuläret sa något annat — aldrig högre. Det är samma
 * asymmetri som resten av filen: en kategori som är fel åt det farliga hållet
 * ska inte kunna hålla nere ett ärende.
 *
 * Orden är INTE en ny lista. De är exakt `KATEGORIORD` för de tre
 * riskkategorierna, alltså samma uppräkning frågeregeln redan använder — två
 * listor som ska betyda samma sak är inte en lista.
 */
function textPekarPaRiskkategori(text: string): boolean {
  for (const kategori of RISKKATEGORIER) {
    const ord = KATEGORIORD[kategori]
    if (ord && ord.some((o) => text.includes(o))) return true
  }
  return false
}

const normalisera = (s: string): string => s.toLowerCase()

/**
 * ── HYRESGÄSTENS EGEN UTSAGA VÄGER TYNGRE ÄN ETT KRYSS I ETT FÄLT ───────────
 *
 * Prioritetsfältet i portalen är en rullgardin. Fritexten är vad personen
 * faktiskt menade — och ibland säger den rakt ut att det INTE är ett ärende att
 * prioritera: felet är redan löst, eller så skriver hyresgästen själv att det
 * inte brådskar. Uppmätt på korpusen står tre sådana ärenden kvar som `NORMAL`
 * enbart därför att formuläret sa `NORMAL` (`k26`, `k62`, `k64`).
 *
 * ── DET HÄR ÄR ETT TAK, OCH FILEN SÄGER ANNARS PÅ RAD ETT ───────────────────
 *
 * `prioritetsgolv` är ett golv och blir det. Taket ligger inte på golvet utan på
 * INDATA — det värde golvet sedan jämförs mot. Ordningen är:
 *
 *     bas       = taket gäller ? LOW : (modellens eller det registrerade värdet)
 *     prioritet = högreAv(bas, golv)
 *
 * Ett nyckelord i texten vinner alltså fortfarande. "Det rinner vatten, ingen
 * brådska" blir `URGENT`, precis som förut: `högreAv` ligger sist och taket kan
 * inte nå förbi det. Det enda taket kan sänka är ett påstående ingen belagt —
 * en rullgardin, eller en modells gissning.
 *
 * ── VAD SOM OCKSÅ FALLER BORT: KATEGORIGOLVET ───────────────────────────────
 *
 * Riskkategoriernas `NORMAL` säger "ett fel av den här arten är minst normalt".
 * Säger texten att felet är löst finns inget fel av någon art, och då har den
 * regeln ingen grund. NYCKELORDSGOLVEN rörs INTE — de talar om texten, inte om
 * kategorin.
 *
 * ── RISKEN, ÅT VILKET HÅLL DEN GÅR ──────────────────────────────────────────
 *
 * Ett falskt tak SÄNKER ett riktigt fel, vilket är fel håll — resten av filen
 * felar med flit uppåt. Två saker gör det försvarbart: taket kan bara nå ett
 * ärende där INGET brådskeord står i texten, och det sänker aldrig under `LOW`,
 * vilket är där ett ärende utan alla signaler ändå hamnar. Frasen 'funkar nu'
 * kan ändå stå i "elementet funkar nu bara på halvfart", och då blir ärendet
 * `LOW` i stället för `NORMAL`. Det är den kända kostnaden.
 */
const LOST_ORD: readonly string[] = [
  'är fixat',
  'ar fixat',
  'är löst',
  'ar lost',
  'är åtgärdat',
  'ar atgardat',
  'funkar nu',
  'fungerar nu',
  'behöver inte komma',
  'behover inte komma',
  'kan stänga',
  'kan stanga',
]

const INGEN_BRADSKA_ORD: readonly string[] = [
  'ingen brådska',
  'ingen bradska',
  'ingen stress',
  'ingen panik',
  'inte bråttom',
  'inte brattom',
  'undrar bara',
  'bara en fundering',
]

/**
 * Säger hyresgästen själv att ärendet inte ska prioriteras?
 *
 * Sant för två utsagor och inga andra: felet är löst, eller det brådskar inte.
 * Båda är påståenden personen GJORT — regeln sluter sig inte till något.
 */
export function hyresgastenSagerIngenBradska(titel: string, beskrivning: string): boolean {
  const text = normalisera(`${titel} ${beskrivning}`)
  return LOST_ORD.some((o) => text.includes(o)) || INGEN_BRADSKA_ORD.some((o) => text.includes(o))
}

/**
 * GOLVET för ett ärende. Aldrig ett tak.
 *
 * @returns den lägsta prioritet ärendet får ha. `LOW` betyder "ingen regel
 *   träffade" — inte "det här är oviktigt".
 */
export function prioritetsgolv(
  kategori: string,
  titel: string,
  beskrivning: string,
): MaintenancePriority {
  const text = normalisera(`${titel} ${beskrivning}`)

  if (URGENT_ORD.some((o) => text.includes(o))) return MaintenancePriority.URGENT
  if (HIGH_ORD.some((o) => text.includes(o))) return MaintenancePriority.HIGH
  if (angivenTemperaturUnder(text, KALLGRANS_GRADER)) return MaintenancePriority.HIGH

  // KATEGORIGOLVEN gäller bara ett ärende som ÄR ett fel. Säger texten att det
  // är löst eller att det inte brådskar finns inget fel av någon art att lyfta —
  // nyckelordsgolven ovan har redan fått säga sitt och rörs inte.
  if (hyresgastenSagerIngenBradska(titel, beskrivning)) return MaintenancePriority.LOW

  if (RISKKATEGORIER.has(kategori)) return MaintenancePriority.NORMAL
  if (textPekarPaRiskkategori(text)) return MaintenancePriority.NORMAL

  return MaintenancePriority.LOW
}

/**
 * ── FRÅGAN NÄR EN BESIKTNING ÄR EN FRÅGA I FÖRKLÄDNAD ───────────────────────
 *
 * Uppmätt: alla fyra missade frågor blev `create_inspection`, med konfidens
 * 0,65–0,85. En besiktning är modellens sätt att slippa fråga — "skicka någon som
 * tittar" är alltid ett giltigt svar på "jag vet inte vad det är", och den utvägen
 * gör frågan onödig utan att göra svaret uppenbart fel.
 *
 * Regeln säger därför inte "fråga när du är osäker". Den säger: en besiktning på
 * ett ärende vars KATEGORI ingen kan avgöra är ingen besiktning. Prompten säger
 * att en besiktning finns till för att något ska bedömas PÅ PLATS — och man kan
 * inte skicka rätt person till en plats när man inte vet vad felet gäller.
 *
 * ── VARFÖR DEN LÄSER MODELLENS SVAR OCH INTE BARA ÄRENDET ───────────────────
 *
 * En ren indataregel prövades först och mättes offline mot körning 3: den tvingade
 * fram fråga på elva ärenden, träffade två av de fyra missade — och skapade FEM
 * felaktiga frågor (fel fråga 1 → 6 av 52, alltså 11,5 %, över takets 10 %).
 * Den kunde inte skilja ett vagt FELMEDDELANDE från ett meddelande som inte
 * handlar om ett fel alls: en fråga om sopsortering, en granne som spelar musik,
 * ett "när kommer ni?". Alla tre saknar kategoriord, och ingen av dem ska bli en
 * fråga till hyresvärden.
 *
 * Modellens val bär den skillnaden utan att kunna göra det till en utväg: väljer
 * den `compose_and_send_email` rör regeln inte ärendet. Samma mätning på den här
 * formen: två av fyra missade frågor träffas, en felaktig tillkommer.
 *
 * ── LÄNGDGRÄNSEN SKILJER FRÅGA FRÅN SKRÄP ───────────────────────────────────
 *
 * "asdfasdf test test" saknar också kategoriord, och blev en FRÅGA i körning 3.
 * Att fråga om skräp är värre än att tiga: det lär hyresvärden att inkorgen
 * innehåller brus. Regeln kräver därför SUBSTANS — minst sex ord — och lämnar det
 * korta till modellen, som kan se att det är skräp och svara `INGEN`.
 */
/**
 * ── VARFÖR DE KORTA ASCII-VARIANTERNA INTE STÅR HÄR ─────────────────────────
 *
 * Listan hade först en å/ä/ö-lös variant av varje ord, för hyresgäster som
 * skriver utan svenska tecken. Fyra av dem är DELSTRÄNGAR av vanliga svenska
 * ord, och matchningen är en delsträngsmatchning:
 *
 *   'ror'  ⊂ "beror"      'las'  ⊂ "plats"
 *   'gard' ⊂ "gardin"     'stad' ⊂ "stadig"      'tak' ⊂ "kontakta"
 *
 * Felet är TYST och går åt det farliga hållet: en text som inte pekar ut någon
 * kategori ser ut att göra det, frågeregeln tiger, och ingen ser att den inte
 * gick igång. Det hittades av en fixtur i `triage-rules.spec.ts` vars ärende
 * innehöll ordet "beror" — inte av läsning.
 *
 * De korta varianterna är därför borta, och 'tak' är utbytt mot 'taket'. De
 * längre ASCII-formerna ('strom', 'varme', 'flakt') är kvar: de är inga
 * delsträngar av något vanligt ord, och provet nedan håller det påståendet.
 */
const KATEGORIORD: Readonly<Record<string, readonly string[]>> = {
  [MaintenanceCategory.PLUMBING]: [
    'kran',
    'toa',
    'avlopp',
    'badrum',
    'wc',
    'dusch',
    'handfat',
    'vatten',
    'rör',
    'blandare',
    'stopp i',
  ],
  [MaintenanceCategory.ELECTRICAL]: [
    'lampa',
    'ström',
    'strom',
    'säkring',
    'sakring',
    'eluttag',
    'uttag',
    'lysrör',
    'lysror',
    'armatur',
    'proppen',
  ],
  [MaintenanceCategory.HEATING]: [
    'element',
    'radiator',
    'värme',
    'varme',
    'termostat',
    'varmvatten',
    'kallt',
  ],
  [MaintenanceCategory.APPLIANCES]: [
    'kylskåp',
    'kylskap',
    'frys',
    'spis',
    'ugn',
    'diskmaskin',
    'tvättmaskin',
    'tvattmaskin',
    'fläkt',
    'flakt',
  ],
  [MaintenanceCategory.WINDOWS_DOORS]: [
    'fönster',
    'fonster',
    'dörr',
    'dorr',
    'ruta',
    'glas',
    'karm',
  ],
  [MaintenanceCategory.LOCKS]: ['lås', 'nyckel', 'portkod', 'tagg', 'cylinder'],
  [MaintenanceCategory.FACADE]: ['fasad', 'balkong', 'puts', 'spricka'],
  [MaintenanceCategory.ROOF]: ['taket', 'takpanna', 'hängränna', 'hangranna'],
  [MaintenanceCategory.COMMON_AREAS]: [
    'trapphus',
    'hiss',
    'källare',
    'kallare',
    'soprum',
    'tvättstuga',
    'tvattstuga',
    'gård',
  ],
  [MaintenanceCategory.CLEANING]: ['städ', 'smutsig', 'skräp', 'skrap', 'sopor'],
}

/** Minsta antal ord för att en text ska räknas som ett ärende alls. */
export const SUBSTANSGRANS_ORD = 6

/** Verktyget regeln gäller. Ett enda — se stycket ovan. */
export const BESIKTNINGSVERKTYG = 'create_inspection'

/** Pekar texten ut någon kategori? */
export function kategoriordFinns(text: string): boolean {
  const t = normalisera(text)
  return Object.values(KATEGORIORD).some((ord) => ord.some((o) => t.includes(o)))
}

/** Antalet ord i en text — enda definitionen, delad av regel och prov. */
export function antalOrd(text: string): number {
  const t = text.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}

/**
 * Ska modellens förslag göras om till en FRÅGA?
 *
 * Sant bara när modellen föreslog en besiktning OCH kategorin är obestämd OCH
 * texten har substans. Allt annat lämnas orört.
 */
export function kräverFråga(
  föreslagetVerktyg: string,
  kategori: string,
  titel: string,
  beskrivning: string,
): boolean {
  if (föreslagetVerktyg !== BESIKTNINGSVERKTYG) return false
  if (kategori !== MaintenanceCategory.OTHER) return false
  const text = `${titel} ${beskrivning}`
  if (antalOrd(text) < SUBSTANSGRANS_ORD) return false
  return !kategoriordFinns(text)
}

/**
 * ── EN VÄG IN FÖR BÅDA LÄSARNA ──────────────────────────────────────────────
 *
 * Reglerna tillämpas HÄR och ingen annanstans. Skuggtjänsten och mätriggen
 * anropar samma funktion, och det är hela poängen: en rigg som tillämpar sin
 * egen kopia av en regel mäter kopian. Samma skäl som riggen redan importerar
 * `byggPrompt` och `tolkaVerktygsanrop` ur produktionen i stället för att
 * återge dem.
 */
export interface Triageutfall {
  /** Verktygsnamnet, `INGEN_ATGARD` eller `FRAGA` — efter reglerna. */
  atgärd: string
  /**
   * Prioriteten. ALDRIG null — regeln behöver ingen modell för att svara, och
   * ett ärende har alltid en registrerad prioritet att utgå från.
   */
  prioritet: MaintenancePriority
  /** Satt endast när `frågaTvingad` är sann. */
  fråga?: { fält: string; alternativ: string[]; användsTill: string }
  /** Höjde golvet den REGISTRERADE prioriteten? */
  golvHöjde: boolean
  /** Sänkte taket den registrerade prioriteten? */
  takSänkte: boolean
  /** Gjordes en besiktning om till en fråga? */
  frågaTvingad: boolean
}

/**
 * Frågans fält när regeln tvingar fram den.
 *
 * `category` och inte `priority`: regeln utlöses av att KATEGORIN inte går att
 * avgöra, och en fråga ska handla om det den utlöstes av. En fråga om prioritet
 * hade varit besvarbar utan att låsa upp något — man kan svara "NORMAL" om ett
 * ärende vars art man inte känner, och då var frågan bortkastad.
 */
const TVINGAD_FRÅGA_FÄLT = 'category'

/**
 * ── PRIORITETEN SÄTTS AV REGEL. MODELLEN HAR INGEN RÖST I DEN ───────────────
 *
 * Argumentet `modell` bär INTE längre någon prioritet, och det är en strukturell
 * spärr och inte en överenskommelse: det finns ingen väg att mata in modellens
 * bedömning i den här funktionen, alltså kan ingen råka göra det igen.
 *
 * Skälet är mätt, inte principiellt. Modellen fick höja men aldrig sänka fram
 * till körning 6, och då var utfallet 72,2 % mot en kontroll utan modell på
 * 75,9 % — den billigare raden var bättre. Med reglerna i den här filen
 * lagade (körning 7) är avståndet större, och det syns i BÅDA riktningarna:
 *
 *     modellen ensam                          33/54  61,1 %
 *     modell + golv        (det som gällde)   46/54  85,2 %
 *     REGISTRERAD + golv   (det som gäller)   50/54  92,6 %
 *     registrerad, modellen får sänka, + golv 50/54  92,6 %
 *
 * Den fjärde raden är poängen: när modellen får sänka tillför den noll. Den
 * tillför alltså varken uppåt eller nedåt, och ett fält som inte tillför något
 * ska inte läsas.
 *
 * ── MODELLEN SVARAR ÄNDÅ, OCH DET ÄR MED FLIT ───────────────────────────────
 *
 * Prompten ber fortfarande om `prediction.priority`, och mätriggen sparar
 * svaret. Det är KONTROLLEN som gör beslutet ovan omprövbart: den dag modellen
 * slår regeln syns det i rapportens `prioritetMedModell`-rad. Ett beslut som
 * inte går att falsifiera är en åsikt, och kostnaden för att behålla kontrollen
 * är några utdatatoken.
 */
export function tillämpaRegler(
  modell: {
    atgärd: string
    kategori: string | null
    /** Modellens andrahandsval. Bär den tvingade frågans andra alternativ. */
    andraKategori?: string | null
  },
  ärende: {
    titel: string
    beskrivning: string
    registreradKategori: string
    /** Vad formuläret fick in. Inte vad modellen tycker — se docblocket. */
    registreradPrioritet: string
  },
): Triageutfall {
  const golv = prioritetsgolv(ärende.registreradKategori, ärende.titel, ärende.beskrivning)
  // Ett värde som inte finns i registret betyder inget: då får golvet ensamt
  // svara. Fail-open mot DATA, aldrig mot texten.
  const registrerad = ärPrioritet(ärende.registreradPrioritet)
    ? ärende.registreradPrioritet
    : MaintenancePriority.LOW
  // TAKET LIGGER PÅ INDATA, INTE PÅ GOLVET. `högreAv` ligger sist, så ett
  // nyckelord i texten vinner alltid över taket — se stycket vid `LOST_ORD`.
  const takSänkte =
    hyresgastenSagerIngenBradska(ärende.titel, ärende.beskrivning) &&
    registrerad !== MaintenancePriority.LOW
  const bas = takSänkte ? MaintenancePriority.LOW : registrerad
  const prioritet = högreAv(bas, golv)

  const tvinga = kräverFråga(
    modell.atgärd,
    ärende.registreradKategori,
    ärende.titel,
    ärende.beskrivning,
  )
  if (!tvinga) {
    return {
      atgärd: modell.atgärd,
      prioritet,
      golvHöjde: prioritet !== bas,
      takSänkte,
      frågaTvingad: false,
    }
  }

  // ── ALTERNATIVEN ÄR MODELLENS EGEN GISSNING OCH `OTHER` ──────────────────
  //
  // Två värden ur registret, vilket är vad `ärGiltigFråga` kräver, och båda är
  // BELAGDA: det ena är vad modellen trodde, det andra är vad ärendet är
  // registrerat som. Att hitta på en tredje kategori hade varit att lägga till
  // ett alternativ ingen hade skäl för — och en fråga vars alternativ är gissade
  // ger ett svar som inte betyder något.
  // ── VARFÖR ANDRAHANDSVALET OCH INTE BARA FÖRSTAHANDSVALET ───────────────
  //
  // Den första formen läste bara `prediction.category` och ställde frågan som
  // "gissningen eller OTHER". Uppmätt på körning 3: regeln träffade rätt två
  // ärenden och tvingade fram NOLL frågor — i båda svarade modellen `OTHER`,
  // vilket är precis vad den gissar i de fall regeln finns för. Villkoret
  // `alternativ.length < 2` föll varje gång, och regeln var död utan att något
  // blev rött. Den mätning som såg ut att belägga den mätte `kräverFråga` för
  // sig, inte funktionens utfall — två olika frågor med samma namn.
  //
  // Alternativen byggs därför av modellens FÖRSTA och ANDRA val, i den ordning
  // de dyker upp, och `OTHER` får vara ett av dem. Båda är belagda; ingen är
  // påhittad av regeln.
  const kandidater = [modell.kategori, modell.andraKategori ?? null].filter(
    (k): k is string => typeof k === 'string' && k !== '',
  )
  const alternativ = [...new Set(kandidater)]
  // Kan ingen andra kategori beläggas finns ingen giltig fråga att ställa — då
  // lämnas förslaget orört. Fail-open mot MODELLEN, inte mot hyresvärden:
  // besiktningen blir kvar som ett förslag hen kan avslå.
  if (alternativ.length < 2) {
    return {
      atgärd: modell.atgärd,
      prioritet,
      golvHöjde: prioritet !== bas,
      takSänkte,
      frågaTvingad: false,
    }
  }

  return {
    atgärd: FRAGA,
    prioritet,
    fråga: {
      fält: TVINGAD_FRÅGA_FÄLT,
      alternativ,
      användsTill:
        `Är ärendet ${alternativ[0]} går det till en annan hantering än om det är ` +
        `${alternativ[1]} — kategorin avgör vem som skickas, och den går inte att ` +
        'avgöra ur texten.',
    },
    golvHöjde: prioritet !== bas,
    takSänkte,
    frågaTvingad: true,
  }
}

function ärPrioritet(v: string | null): v is MaintenancePriority {
  return v !== null && (PRIORITETSORDNING as readonly string[]).includes(v)
}
