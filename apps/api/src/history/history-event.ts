/**
 * HISTORIKENS NORMALISERADE HÄNDELSEFORM.
 *
 * En rad i historiken svarar på åtta frågor, och alla åtta har ett eget fält:
 *
 *   när · vad · aktör · vad det gällde · beskrivning · belopp · allvar · källa
 *
 * ── VARFÖR `källa` BÄR BÅDE TABELL OCH ID ───────────────────────────────────
 *
 * Historiken SAMMANSTÄLLS vid läsning ur domäntabellerna (planens Del 8) — den
 * skrivs aldrig till en egen händelsetabell. Följden är att varje rad måste
 * kunna peka tillbaka på den domänpost den härleddes ur, annars går den inte
 * att verifiera och inte att klicka vidare till. `source` ÄR den kopplingen.
 *
 * ── VARFÖR AKTÖREN HAR FYRA VÄRDEN OCH INTE TRE ─────────────────────────────
 *
 * Planen kräver att aktören ska kunna vara människa, agent eller system — och
 * att fältet finns FRÅN BÖRJAN, så att agentens arbete syns i samma flöde som
 * allt annat när den väl finns. Det kravet är uppfyllt.
 *
 * Men flera domäntabeller BÄR INGEN AKTÖRSKOLUMN. `Lease`, `Deposit`,
 * `TerminationRequest` och `MiscCharge` har varken `createdById` eller
 * `actorType`. Att då skriva `SYSTEM` vore ett PÅSTÅENDE om att maskinen gjorde
 * något en människa sannolikt gjorde — i ett spår som ska gå att revidera. Det
 * är samma familj som "konsumerat är inte utfört": ett fält som inte vet ska
 * säga att det inte vet, inte gissa.
 *
 * ── `UNKNOWN` BETYDER TVÅ SAKER, OCH BÅDA ÄR SAMMA PÅSTÅENDE ────────────────
 *
 * Ursprungligen betydde `UNKNOWN` exakt en sak: KÄLLAN SAKNAR AKTÖRSKOLUMN.
 * Sedan G1 steg 1 betyder det ETT AV TVÅ:
 *
 *   1. källan saknar aktörskolumn (`ACTOR_UNKNOWN`), eller
 *   2. källan HAR en, men kolumnen bevisar inte att en människa skrev raden
 *      (`humanOrUnknown` — se dess docblock).
 *
 * De två är samma påstående utåt: VI VET INTE VEM SOM UTFÖRDE. Att skilja dem
 * åt i typen hade gett läsaren en distinktion som inte ändrar något — båda är
 * frånvaro av belägg, och båda upphör när G1 steg 3 lägger det varaktiga
 * aktörsslaget på raden.
 */

/** Vem utförde. Se docblocket ovan för varför `UNKNOWN` finns. */
export type HistoryActorKind = 'HUMAN' | 'AGENT' | 'SYSTEM' | 'UNKNOWN'

/** Hur allvarligt. Rangordnad — `CRITICAL` är värst. */
export type HistorySeverity = 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL'

export interface HistoryActor {
  kind: HistoryActorKind
  /** `User.id`, `Tenant.id` eller `AiToolExecution.id` — null när källan inte vet. */
  id: string | null
  /** Redan lagrad, icke-härledd etikett (t.ex. `InvoiceEvent.actorLabel`). */
  label: string | null
}

/** Vad händelsen gällde — den domänpost händelsen HANDLAR om. */
export interface HistorySubject {
  kind: 'LEASE' | 'UNIT' | 'PROPERTY' | 'TENANT' | 'INVOICE' | 'RENT_NOTICE' | 'DOCUMENT' | 'NONE'
  id: string | null
  label: string | null
}

/** Var raden kom ifrån. Klickbar till den riktiga domänposten. */
export interface HistorySource {
  /** Prisma-modellens namn, t.ex. `RentNoticeEvent`. */
  table: string
  /** Primärnyckeln i den tabellen. */
  id: string
}

export interface HistoryEvent {
  /** när */
  at: Date
  /** vad — stabil nyckel, aldrig en översatt sträng */
  type: string
  /** aktör */
  actor: HistoryActor
  /** vad det gällde */
  subject: HistorySubject
  /** beskrivning — svensk, läsbar */
  description: string
  /** belopp i SEK, eller null när händelsen inte har något */
  amount: number | null
  /** allvar */
  severity: HistorySeverity
  /** källa */
  source: HistorySource
}

/** `EventActorType` (Prisma) → historikens aktörsform. */
export function actorFromEventActorType(
  actorType: 'USER' | 'SYSTEM' | 'WEBHOOK' | 'AI',
  actorId: string | null,
  actorLabel: string | null,
): HistoryActor {
  // WEBHOOK → SYSTEM: en inkommande leveransstatus är ingen människa, och
  // historiken har ingen egen webhook-nivå. AI → AGENT, men `actorId` bär
  // fortfarande användaren som bad om det (schema.prisma, EventActorType.AI).
  const kind: HistoryActorKind =
    actorType === 'USER' ? 'HUMAN' : actorType === 'AI' ? 'AGENT' : 'SYSTEM'
  return { kind, id: actorId, label: actorLabel }
}

/**
 * En aktörskolumn som bär en `User.id` — men UTAN att påstå att en människa
 * gjorde det (G1 steg 1).
 *
 * ── VARFÖR DEN INTE LÄNGRE SÄGER HUMAN ──────────────────────────────────────
 *
 * Den sa `HUMAN` så snart kolumnen var ifylld. Det påståendet håller inte:
 * AI-assistenten skriver UPPDRAGSGIVARENS userId i domänraden — den agerar
 * aldrig av sig själv, och `executeTool` får `user.sub` — så en AI-skapad
 * felanmälan bar exakt samma `reportedById` som en handskriven.
 *
 * Uppmätt: minst 4 av de 10 kolumner som gick genom den här funktionen skrivs
 * av ett AI-verktyg med människans id (`uploadedById`, `sentById`,
 * `createdById` direkt i exekveraren, `reportedById` via tjänsten).
 *
 * ── VARFÖR UPPSLAGET INTE KAN RÄDDA HUMAN ───────────────────────────────────
 *
 * `HistoryService` slår upp `AiToolEffect` på `(entityType, entityId)` och
 * uppgraderar träffar till `AGENT`. Men frånvaron av en effektpost bevisar
 * INTE att en människa skrev raden, av två mätta skäl:
 *
 *   1. `entityId` är NULL för `updateMany`/`deleteMany` — medvetet, för att
 *      slippa en extra fråga i varje skrivväg. Rader ändrade den vägen har
 *      ingen effektpost som pekar på sig.
 *   2. Revisionsskrivningen ligger i en try/catch som SVÄLJER TYST, och det är
 *      avsiktligt: "en audit-logg-bugg ska inte blockera AI:n".
 *
 * Uppslaget kan alltså BEKRÄFTA agent, aldrig bekräfta människa. Därför är
 * `UNKNOWN` det enda ärliga svaret här — samma regel som docblocket överst:
 * ett fält som inte vet ska säga att det inte vet.
 *
 * ── ID:T BEHÅLLS ────────────────────────────────────────────────────────────
 *
 * `kind` blir `UNKNOWN`, men `id` bär kvar userId:t. Vi vet VILKEN användare
 * raden är knuten till — vi vet bara inte om hon skrev den själv eller bad
 * assistenten göra det. Att kasta id:t hade gjort svaret sämre utan att göra
 * det ärligare.
 *
 * Det här är en MELLANSTÄLLNING. G1 steg 3 lägger ett varaktigt aktörsslag på
 * de 21 modeller som behöver det, och då kan `HUMAN` sägas igen — på ett
 * belägg i stället för på en frånvaro.
 */
export function humanOrUnknown(userId: string | null | undefined): HistoryActor {
  if (!userId) return { kind: 'UNKNOWN', id: null, label: null }
  return { kind: 'UNKNOWN', id: userId, label: null }
}

/** Källan saknar aktörskolumn — se docblocket. */
export const ACTOR_UNKNOWN: HistoryActor = { kind: 'UNKNOWN', id: null, label: null }

/** Prisma `Decimal` → SEK som `number`, med null-genomsläpp. */
export function toAmount(value: { toString(): string } | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return Number(value.toString())
}
