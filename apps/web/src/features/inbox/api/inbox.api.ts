import type { DecideAssignmentInput } from '@eken/shared'
import { get, patch, post } from '@/lib/api'

import type {
  AnswerQuestionInput,
  CreateDelegationFromAssignmentInput,
  RequestUndoInput,
} from '@eken/shared'

export type AssignmentStatus =
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  // ── DE TRE UTFÖRANDESTATUSARNA (etapp 9) ────────────────────────────────
  //
  // De fanns i enumen sedan etapp 8 men hade ingen skrivare. Nu har de en
  // (`AiAgentExecutionService`), och en läsyta som inte känner till dem hade
  // visat en tom status för varje utförd åtgärd.
  | 'EXECUTED'
  | 'FAILED'
  | 'LAPSED'

/** Klickbar data bakom motiveringen. Tom lista = ingen post att öppna. */
export interface InboxEvidence {
  entityType: string
  entityId: string
  label: string
}

/**
 * Ett förslag i inkorgen.
 *
 * Fälten speglar planens fem krav på vad hyresvärden ska se: `toolName` +
 * `toolInput` (vad agenten hade gjort), `reasoning` (varför), `evidence`
 * (vilken information den använde), `confidence` (hur säker), `consequence`
 * (vad som hade krävt godkännande).
 */
export interface InboxItem {
  id: string
  /**
   * VILKEN SORTS RAD DET ÄR (etapp 8).
   *
   * `TOOL_PROPOSAL` — agenten föreslår ett verktyg för ett fall.
   * `DELEGATION_PROPOSAL` — agenten föreslår att du GER BORT rätten.
   * `QUESTION` — agenten saknar en uppgift och frågar. Svaras med ett av
   *   alternativen i `toolInput`, aldrig med ja/nej.
   *
   * Skilt från `shadow`, som svarar på om något UTFÖRS vid ett godkännande.
   */
  kind: 'TOOL_PROPOSAL' | 'DELEGATION_PROPOSAL' | 'QUESTION'
  shadow: boolean
  toolName: string
  toolInput: Record<string, unknown>
  title: string
  reasoning: string
  consequence: string
  undoHint: string
  evidence: InboxEvidence[]
  confidence: number | null
  prediction: Record<string, unknown> | null
  outcome: Record<string, unknown> | null
  status: AssignmentStatus
  statusReason: string | null
  deadline: string
  decidedAt: string | null
  createdAt: string
  /** ── TORRLÄGETS DOM (etapp 8) ────────────────────────────────────────────
   *
   * `null` betyder INGEN DOM ÄNNU, inte "hade inte fått". De två är olika
   * svar, och kortet måste kunna säga vilket — se `verdiktText`.
   */
  executionVerdict: 'WOULD_EXECUTE' | 'NO_DELEGATION' | 'BLOCKED' | null
  verdictReason: string | null
  verdictAt: string | null
  verdictDelegationId: string | null
  verdictDelegation: {
    id: string
    villkor: Record<string, unknown> | null
    expiresAt: string
  } | null
}

export interface InboxPage {
  rader: InboxItem[]
  total: number
  limit: number
  offset: number
}

/** Träffgrad för ETT fält. `andel` är null när inget facit finns än. */
export interface Traffgrad {
  besvarade: number
  traffar: number
  andel: number | null
}

export interface InboxSummary {
  status: Record<AssignmentStatus, number>
  traffgrad: Record<string, Traffgrad>
}

export const fetchInbox = (params: {
  status?: AssignmentStatus
  limit?: number
  offset?: number
}) =>
  get<InboxPage>('/ai/assignments', {
    shadow: 'true',
    ...(params.status ? { status: params.status } : {}),
    ...(params.limit ? { limit: String(params.limit) } : {}),
    ...(params.offset ? { offset: String(params.offset) } : {}),
  })

export const fetchInboxSummary = () =>
  get<InboxSummary>('/ai/assignments/summary', { shadow: 'true' })

/**
 * ÅNGRAVÄGEN, beräknad av SERVERN.
 *
 * Härledd ur `supportsUndo` och `HUMAN_PATHS`, som båda bor i API:t. Att räkna
 * ut den här hade krävt en kopia av effektkatalogen i webben — en andra källa
 * till samma regel, och den som syns för hyresvärden hade blivit den som ingen
 * prövat.
 */
export type Angravag =
  | { möjlig: true; rutt: string; atgard: string; text: string }
  | { möjlig: false; text: string }

/** En rad i "Gjort" — en åtgärd agenten faktiskt utförde, eller försökte. */
export interface GjortItem extends InboxItem {
  aiToolExecutionId: string | null
  authorityKind: 'APPROVAL' | 'DELEGATION'
  delegationId: string | null
  delegation: { id: string; toolName: string; villkor: Record<string, unknown> | null } | null
  ångra: Angravag
  /** När någon senast begärde att åtgärden skulle backas. Null = ingen har. */
  ångraBegärd: string | null
}

export interface GjortPage {
  rader: GjortItem[]
  total: number
  limit: number
  offset: number
}

export const fetchGjorda = (params: { limit?: number; offset?: number } = {}) =>
  get<GjortPage>('/ai/assignments/gjorda', {
    ...(params.limit ? { limit: String(params.limit) } : {}),
    ...(params.offset ? { offset: String(params.offset) } : {}),
  })

/**
 * ÅNGRA — en BEGÄRAN, inte en backning.
 *
 * Servern skriver en händelse och svarar med vägen att göra det för hand.
 * Skälet står i API:ts `undo-hint.ts`: att anropa varje verktygs backningsväg
 * generiskt hade varit en andra utförandeväg utan någon av grindarna.
 */
export const begarAngra = (params: { id: string; note?: string }) => {
  // ANNOTERAD, inte inferrerad. Utan annoteringen är literalen en `const` och
  // TypeScript kör då ingen överskottskontroll — ett fält som finns här men
  // inte i kontraktet hade passerat tyst. Se CLAUDE.md, "Kontraktet webb↔API".
  const kropp: RequestUndoInput = {
    ...(params.note ? { note: params.note } : {}),
  }
  return post<{ ångra: Angravag }>(`/ai/assignments/${params.id}/undo`, kropp)
}

export const decideInboxItem = (params: { id: string } & DecideAssignmentInput) => {
  const kropp: DecideAssignmentInput = {
    decision: params.decision,
    ...(params.reason ? { reason: params.reason } : {}),
  }
  return patch<InboxItem>(`/ai/assignments/${params.id}/decision`, kropp)
}

/** Svaret på "kan det här förslaget bli en delegation?". */
export interface KanDelegera {
  kan: boolean
  skäl?: string
  förifylltVillkor?: Record<string, unknown>
  /**
   * Läses ur en KONSTANT i API:t, aldrig hårdkodad prosa här.
   *
   * Meningen "Agenten utför fortfarande ingenting förrän utföraren finns" är sann
   * bara så länge det INTE finns en utförare. Skriven i en komponent hade den
   * blivit kvar den dag etapp 8–9 landar, och då står en osanning i det enda
   * gränssnitt hyresvärden har för att förstå vad hen ger bort.
   */
  utförareFinns: boolean
  /**
   * ── TAKET KRÄVS FÖR VISSA VERKTYG, OCH SERVERN SÄGER VILKA ────────────────
   *
   * Härlett ur effektkatalogen (`DEDUPLICERBAR`), aldrig en lista här. En
   * uppräkning i webben hade blivit en andra källa till samma regel, och den
   * som syns för hyresvärden hade varit den som ingen prövat.
   *
   * Fanns fältet inte svarade `can-create` ja medan `POST` kastade 400 — mätt
   * för tre av åtta delegerbara verktyg.
   */
  kräverFrekvensvillkor?: boolean
  förifylltFrekvensvillkor?: { maxAntal: number; periodDagar: number }
}

export const fetchKanDelegera = (assignmentId: string) =>
  get<KanDelegera>(`/agent/delegations/can-create/${assignmentId}`)

export const skapaDelegationUrForslag = (
  params: { assignmentId: string } & CreateDelegationFromAssignmentInput,
) => {
  // Nyttolasten byggs som en NAMNGIVEN, delad-typad variabel och inte som ett
  // objektliteral i anropet. `check-request-contract.mjs` läser anropsstället:
  // ett literal går inte att binda till en typ i @eken/shared, och då finns
  // ingen kompileringstidskoppling mellan webbens fält och API:ts DTO.
  const dto: CreateDelegationFromAssignmentInput = {
    ...(params.villkor ? { villkor: params.villkor } : {}),
    ...(params.frekvensvillkor ? { frekvensvillkor: params.frekvensvillkor } : {}),
  }
  return post<{ id: string }>(`/agent/delegations/from-assignment/${params.assignmentId}`, dto)
}

/** Frågans strukturerade innehåll, som det ligger i `toolInput`. */
export interface FraganInnehall {
  fält: string
  alternativ: string[]
  användsTill: string
}

/**
 * Är raden en fråga med giltigt innehåll?
 *
 * FAIL-CLOSED: en fråga utan alternativ kan inte besvaras strukturerat, och att
 * visa den som ett vanligt kort hade bett hyresvärden godkänna en fråga.
 */
export function fraganInnehall(item: InboxItem): FraganInnehall | null {
  if (item.kind !== 'QUESTION') return null
  const i = item.toolInput as Record<string, unknown>
  const alt = i['alternativ']
  if (typeof i['fält'] !== 'string' || !Array.isArray(alt) || alt.length < 2) return null
  return {
    fält: i['fält'],
    alternativ: alt.filter((a): a is string => typeof a === 'string'),
    användsTill: typeof i['användsTill'] === 'string' ? i['användsTill'] : '',
  }
}

export const svaraPaFraga = (assignmentId: string, svar: string) => {
  // NAMNGIVEN, DELAD-TYPAD nyttolast — se check-request-contract.
  const dto: AnswerQuestionInput = { svar }
  return post<{ ok: boolean }>(`/ai/assignments/${assignmentId}/answer`, dto)
}
