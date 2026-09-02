import { get } from '@/lib/api'

import type { ActorKind, EventActor } from '@/components/ui/ActorTag'

/**
 * HISTORIKENS FORM — speglad, inte importerad.
 *
 * Typerna nedan är API:ets `HistoryEvent` och `GapResult` (apps/api/src/history/)
 * uttryckta över nätet: `Date` blir ISO-sträng, resten är oförändrat. De bor här
 * och inte i `@eken/shared` därför att historiken ännu inte har någon delad
 * kontraktsyta — läggs en sådan till senare ersätter den den här filen.
 *
 * ── VARFÖR `type` ÄR `string` OCH INTE EN UNION ─────────────────────────────
 *
 * Frestelsen är att räkna upp de trettio typer som finns idag. Men två av
 * källorna bygger sin typ av DATA — `INVOICE_${event.type}`,
 * `RENT_NOTICE_${event.type}` — så uppräkningen vore osann redan vid skrivandet,
 * och varje ny källa i API:t hade gjort den osannare. En union här hade inte
 * gett säkerhet: den hade gett en tyst felkategorisering, eller ett `default`
 * som tappar raden.
 *
 * Gränssnittet klassificerar därför på FORM (prefix) och har alltid en hink som
 * tar emot det den inte känner igen — se `lib/categories.ts`. En ny händelsetyp
 * från API:t syns i flödet samma dag den finns, utan att någon rör den här filen.
 */

/**
 * Vem utförde. `UNKNOWN` = INTE BELAGT — ett av två: källan saknar
 * aktörskolumn, eller så skiljer kolumnen inte människa från AI-assistent
 * (G1 steg 1). Se `ActorTag`, som bär hela förklaringen.
 *
 * FORMEN BOR HOS `ActorTag`, som renderar den för både historiken och avins
 * händelselogg (#648). Alias och inte en egen definition: två strukturellt
 * identiska typer som ska följas åt men kan ändras var för sig är två sanningar
 * som råkar stämma överens just nu.
 */
export type HistoryActorKind = ActorKind

export type HistorySeverity = 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL'

export type HistoryActor = EventActor

export interface HistorySubject {
  kind: 'LEASE' | 'UNIT' | 'PROPERTY' | 'TENANT' | 'INVOICE' | 'RENT_NOTICE' | 'DOCUMENT' | 'NONE'
  id: string | null
  label: string | null
}

/** Var raden kom ifrån — Prisma-modell + primärnyckel. */
export interface HistorySource {
  table: string
  id: string
}

export interface HistoryEvent {
  /** ISO-8601. Serialiserad `Date` från API:t. */
  at: string
  type: string
  actor: HistoryActor
  subject: HistorySubject
  description: string
  amount: number | null
  severity: HistorySeverity
  source: HistorySource
}

/** Var förväntan kommer ifrån. Utan den är en lucka en gissning. */
export type ExpectationSource =
  | { kind: 'KONFIGURERAD'; field: string; description: string }
  | { kind: 'SYSTEMREGEL'; rule: string; description: string }
  | { kind: 'ODEFINIERAD'; why: string }

export type GapStatus = 'UPPFYLLD' | 'LUCKA' | 'GÄLLER_EJ' | 'ODEFINIERAD'

export interface GapResult {
  key: string
  label: string
  status: GapStatus
  source: ExpectationSource
  detail: string
  missingCount?: number
}

/** De tre ingångarna till samma register. */
export type HistoryDimension = 'tenants' | 'units' | 'properties'

export function fetchHistory(dimension: HistoryDimension, id: string): Promise<HistoryEvent[]> {
  return get<HistoryEvent[]>(`/history/${dimension}/${id}`)
}

export function fetchGaps(dimension: HistoryDimension, id: string): Promise<GapResult[]> {
  return get<GapResult[]>(`/history/${dimension}/${id}/gaps`)
}
