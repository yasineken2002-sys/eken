import { PENDING_ACTION_TTL_MS } from '../pending-action-ttl'
import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'

import type { EffectDeclaration } from '../tools/effect-idempotency'
import type { ResumptionDecision, ResumptionReason } from '@prisma/client'

/**
 * ÅTERUPPTAGNINGENS OMDÖME — ren funktion, ingen databas, inga sidoeffekter.
 *
 * Motorn är den första komponenten i systemet som agerar utan att en människa
 * bett om det i samma stund. Hela dess omdöme bor därför här, i en funktion som
 * går att pröva ensam mot påhittade rader — inte utspritt i en tjänst där varje
 * prov kräver en databas och en halv Nest-graf.
 *
 * ── FAIL-CLOSED ÄR EN KONSTRUKTION, INTE EN AMBITION ────────────────────────
 *
 * `RESUME` returneras på EXAKT ETT ställe: sist i `bedöm`, efter att varje steg
 * i stegen nedan passerats. Det finns ingen annan väg dit. Ett nytt okänt
 * tillstånd faller därför ut som `ABSTAIN` av sig självt — man måste aktivt
 * lägga till ett steg för att öppna en dörr, aldrig glömma ett för att stänga
 * en.
 *
 * ── STEGEN, OCH VARFÖR DE LIGGER I DEN HÄR ORDNINGEN ────────────────────────
 *
 *  1. FORMEN      Bär raden en påbörjad tvåfasrads form?
 *  2. KLASSEN     Finns en deklaration, och är varje fält igenkänt?
 *  3. POLICYN     Får verktyget återupptas automatiskt?   ← SPÄRREN
 *  4. SPÅRET      Finns en varaktig plats som gör en omkörning ofarlig?
 *  5. GOLVET      Kan raden fortfarande vara i luften?
 *  6. TAKET       Har världen hunnit flytta sig?
 *
 * Ordningen är vald efter vilket SKÄL som är mest upplysande när flera gäller.
 * Steg 1 först därför att den förklarar hela den befintliga populationen: mätt
 * i produktion 2026-09-02 står 11 av 11 påbörjade rader som PRE_TWO_PHASE, och
 * alla 11 skulle dessutom fallit på steg 2. Rapporterades steg 2 hade man
 * trott att problemet var oklassade verktyg, när det i själva verket är att
 * raderna är äldre än tvåfasskrivningen.
 *
 * ── VAD DEN HÄR FUNKTIONEN INTE KAN SE ──────────────────────────────────────
 *
 * Den läser en RAD och en DEKLARATION. Den vet ingenting om vad som faktiskt
 * hände i världen — om brevet gick iväg, om fakturan finns. Det ägs av
 * verktygets egen idempotensmekanism (`traceDurability.plats`), och steg 4 är
 * hela dess kontroll av den saken: finns ingen varaktig plats återupptas
 * ingenting, oavsett hur ofarligt det ser ut.
 *
 * Den vet heller ingenting om KVOTEN. Den grinden är ett anrop mot databasen
 * och bor i tjänsten; den kan bara göra ett `RESUME` till ett `ABSTAIN`, aldrig
 * tvärtom.
 */

/** Raden som bedöms. Bara fälten omdömet faktiskt läser. */
export interface PåbörjadKörning {
  id: string
  organizationId: string
  toolName: string
  createdAt: Date
  completedAt: Date | null
  success: boolean
  durationMs: number
  /** Om `toolResult` är ifyllt. Innehållet läses aldrig. */
  harToolResult: boolean
}

export interface Dom {
  beslut: ResumptionDecision
  skäl: ResumptionReason
  ageMs: number
}

/**
 * GOLVET — yngre än så här kan raden fortfarande vara i luften.
 *
 * Härlett ur de STÖRSTA konfigurerade budgetar som kan hålla arbete igång i
 * processen, mätta i koden 2026-09-02:
 *
 *     Prisma-transaktion, betalvägen   8 000 ms   (PAYMENT_TX_LIMITS)
 *     Prisma-transaktion, default      5 000 ms   (PRISMA_DEFAULT_TX_LIMITS)
 *     Bulls stall-kuvert              ~60 000 ms  (lockDuration 30 s + stalledInterval 30 s)
 *     graceful shutdown SIGTERM→exit   2 564 ms   (uppmätt, main.ts)
 *
 * 60 s är den största av dem. En rad som är äldre än så kan inte vara i luften
 * under någon budget som finns konfigurerad — processen har antingen stängt
 * raden eller är borta.
 *
 * OBSERVERAT UTFÖRANDE ligger tre storleksordningar under: `durationMs` p95 var
 * 51 ms i prod och 87 ms i dev. Men de mätningarna är gjorda på LÄSVERKTYG
 * (`get_*`) — noll bindande verktyg har någonsin körts i produktion — så golvet
 * vilar på konfigurationen och inte på observationen. Det står här därför att
 * skillnaden betyder något den dag någon vill sänka talet.
 */
export const ATERUPPTAGNING_GOLV_MS = 60_000

/**
 * TAKET — äldre än så här har världen flyttat sig.
 *
 * Inte ett nytt tal. Systemet har redan en gräns för hur länge en AI-avsikt är
 * giltig: `PENDING_ACTION_TTL_MS`, fem minuter, med motiveringen att en
 * bekräftelse måste ske i rimlig anslutning till att AI:n föreslog åtgärden.
 *
 * Argumentet är ett TAK-argument, inte en exakt härledning, och det är värt att
 * vara tydlig med skillnaden. De två gränserna styr olika saker — den ena en
 * MÄNNISKAS bekräftelse av ett förslag, den andra en MASKINS omkörning av något
 * som redan påbörjats. Men riktningen är entydig: vägrar systemet låta en
 * människa bekräfta en fem minuter gammal avsikt, kan det inte vara rätt att en
 * maskin obevakat agerar på en äldre. Taket får alltså vara högst så tillåtande
 * som den gräns som redan finns.
 *
 * ── KONSEKVENSEN SOM MÅSTE AVGÖRAS FÖRE SKARPT LÄGE ─────────────────────────
 *
 * Fönstret blir [60 s, 5 min] — fyra minuter brett. Motorn måste alltså titta
 * OFTARE än var fjärde minut, annars hinner varje rad åldras förbi taket innan
 * den setts, och taket blir i praktiken en spärr mot all återupptagning.
 * I skuggläget spelar det ingen roll (ingenting utförs). Det gör det i skarpt
 * läge, och det är ett beslut för en människa — se ärendet som PR:en öppnar.
 */
export const ATERUPPTAGNING_TAK_MS = PENDING_ACTION_TTL_MS

/** Läsbar svensk text per skäl. Enumvärdena är engelska av Prisma-mekanik. */
export const SKAL_TEXT: Record<ResumptionReason, string> = {
  PRE_TWO_PHASE: 'raden bär inte en påbörjad tvåfasrads form — tillståndet är okänt',
  UNKNOWN_CLASSIFICATION: 'verktyget saknar deklaration, eller har ett oigenkänt fält',
  REQUIRES_HUMAN: 'verktyget kräver en människa',
  NO_TRACE: 'ingen varaktig spårplats — en omkörning kan inte veta om effekten finns',
  TOO_FRESH: 'yngre än golvet: kan fortfarande vara i luften',
  TOO_OLD: 'äldre än taket: världen har flyttat sig',
  QUOTA_BLOCKED: 'organisationens dagliga AI-budget är slut',
  RESUMABLE: 'återupptagbar',
}

// ── Igenkända fältvärden. Ett värde utanför listorna är en OKÄND klassificering,
// inte ett fel att tolka bort. Listorna är avsiktligt skrivna här och inte
// härledda ur typerna: en ny variant i typen ska falla ut som okänd tills någon
// tagit ställning till vad motorn ska göra med den.
const KÄNDA_KLASSER = new Set(['IDEMPOTENT', 'DEDUPLICERBAR'])
const KÄNDA_ENHETER = new Set(['ANROP', 'EFFEKT'])
const KÄNDA_PLATSER = new Set([
  'DATABAS_INDEX',
  'DATABAS_TILLSTÅND',
  'DATABAS_HASH',
  'KÖ_FÖNSTER',
  'EJ_TILLÄMPLIG',
  'INGET',
])
const KÄNDA_INTEGRITETER = new Set(['TRANSAKTIONELL', 'FÖRE_EFFEKTEN', 'BÄST_MÖJLIGA'])
/** Platser som INTE bär en omkörning. `INGET` är den enda i dag. */
const PLATSER_UTAN_SPÅR = new Set(['INGET'])

function ärIgenkänd(d: EffectDeclaration): boolean {
  return (
    KÄNDA_KLASSER.has(d.effectIdempotency) &&
    KÄNDA_ENHETER.has(d.idempotencyUnit) &&
    KÄNDA_PLATSER.has(d.traceDurability?.plats) &&
    KÄNDA_INTEGRITETER.has(d.traceIntegrity)
  )
}

/**
 * Har raden formen av något `beginToolExecution` skrev och aldrig stängde?
 *
 * `beginToolExecution` skriver alltid `success: false`, `durationMs: 0` och
 * inget `toolResult`. Den GAMLA vägen skrev raden EFTER körningen, med allt
 * ifyllt — och fick `completedAt = NULL` när kolumnen tillkom, eftersom
 * migrationen medvetet avstod från en backfill som hade påstått något ingen
 * mätt.
 *
 * `completedAt !== null` prövas också, trots att tjänstens fråga filtrerar bort
 * stängda rader. Det är en fail-closed-gren utan känd väg hit: den finns för att
 * en framtida anropare inte ska kunna öppna en dörr genom att glömma ett filter.
 */
function bärPåbörjadForm(rad: PåbörjadKörning): boolean {
  return (
    rad.completedAt === null &&
    rad.success === false &&
    rad.durationMs === 0 &&
    rad.harToolResult === false
  )
}

/**
 * Domen om EN rad.
 *
 * @param nu injiceras av proven; tjänsten skickar en och samma tidpunkt för
 *           hela körningen, så två rader i samma varv mäts mot samma klocka.
 */
export function bedöm(rad: PåbörjadKörning, nu: Date): Dom {
  const ageMs = nu.getTime() - rad.createdAt.getTime()
  const avstå = (skäl: ResumptionReason): Dom => ({ beslut: 'ABSTAIN', skäl, ageMs })

  // 1. FORMEN.
  if (!bärPåbörjadForm(rad)) return avstå('PRE_TWO_PHASE')

  // 2. KLASSEN. Saknad deklaration OCH oigenkänt fältvärde är samma sak för
  //    motorn: den vet inte vad den har framför sig.
  const dekl = EFFECT_DECLARATIONS[rad.toolName]
  if (!dekl || !ärIgenkänd(dekl)) return avstå('UNKNOWN_CLASSIFICATION')

  // 3. SPÄRREN. `policyBeslutad: false` räknas som KRÄVER_MÄNNISKA — fältet
  //    finns just för att "ingen har tänkt på det här än" inte ska se ut som
  //    ett fattat beslut. Det här är ENDA stället policyn prövas; tas raden
  //    bort faller varje KRÄVER_MÄNNISKA-verktyg igenom till RESUME, och alla
  //    15 av dem har ett spår som bär dem förbi steg 4.
  if (dekl.resumptionPolicy !== 'AUTOMATISK' || !dekl.policyBeslutad) {
    return avstå('REQUIRES_HUMAN')
  }

  // 4. SPÅRET.
  if (PLATSER_UTAN_SPÅR.has(dekl.traceDurability.plats)) return avstå('NO_TRACE')

  // 5. GOLVET.
  if (ageMs < ATERUPPTAGNING_GOLV_MS) return avstå('TOO_FRESH')

  // 6. TAKET. `>` och inte `>=`: exakt taket är innanför.
  //
  // TOO_OLD ÄR INTE ETT AVSLAG BLAND ANDRA. En rad som når hit har passerat
  // steg 1–5 — den VAR återupptagbar, och det enda som stoppar den är att
  // motorn inte hann titta i tid. Se `ärUtåldrad` nedan.
  if (ageMs > ATERUPPTAGNING_TAK_MS) return avstå('TOO_OLD')

  // ENDA VÄGEN TILL RESUME.
  return { beslut: 'RESUME', skäl: 'RESUMABLE', ageMs }
}

/**
 * ÅLDRADES DEN HÄR RADEN UT UTAN ATT HA ÅTERUPPTAGITS?
 *
 * ── VARFÖR DET INTE RÄCKER ATT LÄSA `skäl === 'TOO_OLD'` ────────────────────
 *
 * Det gör det i dag, men bara på grund av STEGORDNINGEN: taket prövas sist, så
 * en rad som får TOO_OLD har redan passerat form, klass, policy, spår och golv.
 * Den egenskapen är implicit, och en omkastning av stegen skulle tyst göra
 * TOO_OLD till en hink som också rymmer rader som aldrig var återupptagbara.
 *
 * Funktionen gör egenskapen EXPLICIT genom att fråga rakt ut: hade den här
 * raden återupptagits om den varit yngre? Den frågan är sann eller falsk oavsett
 * i vilken ordning stegen står, och `resumption-policy.spec.ts` fastnaglar
 * ekvivalensen åt båda hållen.
 *
 * ── VARFÖR UTFALLET MÅSTE VARA URSKILJBART ──────────────────────────────────
 *
 * "Åldrades ut" är det enda avslaget som beskriver ett fel hos MOTORN och inte
 * hos raden. Blir det vanligt i drift är taket för snävt eller kadensen för
 * gles, och det ska gå att läsa ur data i stället för att gissas. Ett
 * Railway-omstartsvarv mättes till 90–165 s 2026-09-02; ett långsammare varv
 * äter en märkbar del av det fyra minuter breda fönstret.
 */
export function ärUtåldrad(rad: PåbörjadKörning, nu: Date): boolean {
  if (bedöm(rad, nu).skäl !== 'TOO_OLD') return false
  // Samma rad, förflyttad till mitten av fönstret. Blir domen RESUME var det
  // ÅLDERN och ingenting annat som stoppade den.
  const mitten = ATERUPPTAGNING_GOLV_MS + (ATERUPPTAGNING_TAK_MS - ATERUPPTAGNING_GOLV_MS) / 2
  const förflyttad: PåbörjadKörning = { ...rad, createdAt: new Date(nu.getTime() - mitten) }
  return bedöm(förflyttad, nu).beslut === 'RESUME'
}

/**
 * SKA DET HÄR PASSET LÄMNA ETT SPÅR?
 *
 * Ren funktion, och det är hela poängen: den avgör om motorn syns, och den
 * frågan får inte bo där bara en databas kan svara på den.
 *
 * ── VARFÖR INTE "ALLTID" ────────────────────────────────────────────────────
 *
 * Motorn tittar varje minut. Skrev den en körningsrad varje gång blev det
 * 1 440 rader per dygn, i all evighet, för att bära budskapet "ingenting hände".
 * En logg som ingen orkar läsa är en annan sorts tystnad.
 *
 * ── OCH VARFÖR INTE "BARA NÄR NÅGOT HÄNDE" ──────────────────────────────────
 *
 * Därför att det är precis den tystnad vi rensat bort. "Motorn avstod från
 * allt" och "motorn kördes aldrig" hade blivit omöjliga att skilja åt, och det
 * är den farligare av de två som hade sett normal ut.
 *
 * Alltså: skriv när det fanns något att säga, OCH minst en gång i timmen ändå.
 * En tom timme lämnar då ett kvitto, och en motor som slutat köra syns genom
 * att kvittona upphör.
 */
export function skallSkrivaKörning(args: {
  antalBedömda: number
  nu: Date
  /** Millisekunder sedan epoch för senast skrivna körningsrad; 0 = aldrig. */
  senasteHjärtslag: number
  hjärtslagMs: number
}): boolean {
  if (args.antalBedömda > 0) return true
  return args.nu.getTime() - args.senasteHjärtslag >= args.hjärtslagMs
}
