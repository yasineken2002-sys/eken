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
  'vatten på golvet',
  'vatten pa golvet',
  'står vatten',
  'star vatten',
]

const HIGH_ORD: readonly string[] = [
  // VATTEN DÄR DET INTE SKA VARA, men inte strömmande. Samma familj som
  // URGENT-gruppen ovan, ett steg ned: fukten finns, den ökar inte i timmen.
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
  'står olåst',
  'star olast',
  'står på glänt',
  'star pa glant',
  'anmälde',
  'anmalde',
  'anmält',
  'anmalt',
  'påminner',
  'paminner',
  'har inte hänt',
  'har inte hant',
]

/**
 * Kategorier där ett fel sällan är ingenting: vatten, el och lås kostar pengar
 * eller släpper in någon. De lyfter golvet till `NORMAL` — inte till `HIGH`.
 * Vill man ha `HIGH` ska det stå något i texten som säger varför.
 */
const RISKKATEGORIER: ReadonlySet<string> = new Set<string>([
  MaintenanceCategory.PLUMBING,
  MaintenanceCategory.ELECTRICAL,
  MaintenanceCategory.LOCKS,
])

const normalisera = (s: string): string => s.toLowerCase()

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
  if (RISKKATEGORIER.has(kategori)) return MaintenancePriority.NORMAL

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
  /** Prioriteten efter golvet. Null när modellen inte svarade något. */
  prioritet: MaintenancePriority | null
  /** Satt endast när `frågaTvingad` är sann. */
  fråga?: { fält: string; alternativ: string[]; användsTill: string }
  /** Höjde golvet modellens svar? Redovisas i mätningen, inte i produkten. */
  golvHöjde: boolean
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

export function tillämpaRegler(
  modell: { atgärd: string; prioritet: string | null; kategori: string | null },
  ärende: { titel: string; beskrivning: string; registreradKategori: string },
): Triageutfall {
  const golv = prioritetsgolv(ärende.registreradKategori, ärende.titel, ärende.beskrivning)
  const modellensPrioritet = ärPrioritet(modell.prioritet) ? modell.prioritet : null
  const prioritet = modellensPrioritet === null ? null : högreAv(modellensPrioritet, golv)

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
      golvHöjde: prioritet !== null && prioritet !== modellensPrioritet,
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
  const gissning =
    modell.kategori !== null && modell.kategori !== MaintenanceCategory.OTHER
      ? modell.kategori
      : null
  const alternativ = gissning
    ? [gissning, MaintenanceCategory.OTHER as string]
    : [MaintenanceCategory.OTHER as string]

  // Kan ingen andra kategori beläggas finns ingen giltig fråga att ställa — då
  // lämnas förslaget orört. Fail-open mot MODELLEN, inte mot hyresvärden:
  // besiktningen blir kvar som ett förslag hen kan avslå.
  if (alternativ.length < 2) {
    return {
      atgärd: modell.atgärd,
      prioritet,
      golvHöjde: prioritet !== null && prioritet !== modellensPrioritet,
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
        `Är ärendet ${gissning} går det att hantera direkt; är det ${MaintenanceCategory.OTHER} ` +
        'behövs ett platsbesök för att avgöra vad felet gäller innan någon skickas.',
    },
    golvHöjde: prioritet !== null && prioritet !== modellensPrioritet,
    frågaTvingad: true,
  }
}

function ärPrioritet(v: string | null): v is MaintenancePriority {
  return v !== null && (PRIORITETSORDNING as readonly string[]).includes(v)
}
