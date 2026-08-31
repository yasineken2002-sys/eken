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
 * `UNKNOWN` betyder därför exakt en sak: KÄLLAN SAKNAR AKTÖRSKOLUMN. Det är en
 * mätbar egenskap hos schemat, inte en osäkerhet i koden — och den dagen en
 * sådan kolumn läggs till kan raden byta värde utan att formen ändras.
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

/** En `User.id` som aktör, eller `UNKNOWN` när kolumnen är null. */
export function humanOrUnknown(userId: string | null | undefined): HistoryActor {
  if (!userId) return { kind: 'UNKNOWN', id: null, label: null }
  return { kind: 'HUMAN', id: userId, label: null }
}

/** Källan saknar aktörskolumn — se docblocket. */
export const ACTOR_UNKNOWN: HistoryActor = { kind: 'UNKNOWN', id: null, label: null }

/** Prisma `Decimal` → SEK som `number`, med null-genomsläpp. */
export function toAmount(value: { toString(): string } | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return Number(value.toString())
}
