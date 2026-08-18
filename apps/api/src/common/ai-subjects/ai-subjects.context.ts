/**
 * ÄMNESKOPPLING SOM TUR-SCOPAD KONTEXT (#510).
 *
 * ── PROBLEMET ──────────────────────────────────────────────────────────────
 *
 * `AiMessage` och `AiMemory` bär ingen koppling till hyresgäst. När en
 * raderingsbegäran kommer går det därför inte att peka ut vilka rader som
 * handlar om personen — bara att söka på namn i fritext. Den vägen är avfärdad
 * (#494): en enda `AiMessage`-rad i dev namngav FEM olika hyresgäster, så raden
 * är fel enhet för en gissning.
 *
 * Det här modulen sparar kopplingen NÄR DEN UPPSTÅR i stället. Den som kan
 * svaret säkert är verktygslagret: `get_tenants` VET vilka `Tenant.id` det slog
 * upp. Den kunskapen kastades tidigare bort när verktyget returnerade.
 *
 * ── VARFÖR AsyncLocalStorage OCH INTE ETT ARGUMENT ─────────────────────────
 *
 * Samma skäl som `ai-origin.context.ts` (#504), och medvetet samma form så att
 * de två läses ihop: ett nedträtt argument KAN glömmas av en framtida
 * anropskedja, och då blir kopplingen tyst tom. En kontext sätts EN gång vid
 * turens början och ses av allt som körs innanför — inklusive kod som skrivs i
 * morgon.
 *
 * Skillnaden mot `ai-origin`: den kontexten omsluter EN verktygskörning, den
 * här omsluter HELA TUREN. Kopplingen uppstår i ett verktyg men ska skrivas på
 * meddelandet, som persisteras efter att tool-loopen tagit slut.
 *
 * ── VAD DEN INTE FÅNGAR — LUCKAN, UTTALAD ──────────────────────────────────
 *
 * Kopplingen kommer UTESLUTANDE från verktygskörningar. Nämner modellen en
 * hyresgäst som inget verktyg rörde — för att den läste namnet ur
 * konversationshistoriken, ur portföljsammanfattningen i systemprompten, eller
 * för att operatören skrev det själv i klartext — blir raden OKOPPLAD.
 *
 * Det är en känd och avsiktlig lucka, inte ett förbiseende:
 *
 *   • Alternativet vore textmatchning på namn, vilket är precis det som
 *     avfärdades. En koppling som ibland pekar på fel person är sämre än ingen,
 *     eftersom den inbjuder till en riktad radering som träffar en oskyldig.
 *   • Kopplingen är därför HÖGPRECIS men OFULLSTÄNDIG. Den får användas för att
 *     HITTA rader, aldrig för att påstå att alla rader om en person är hittade.
 *
 * Den som senare bygger verkställandet måste utgå från det. Se #510.
 */

import { AsyncLocalStorage } from 'async_hooks'

/** Rå UUID-form. Kandidaterna valideras mot Tenant innan något skrivs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Skydd mot patologiskt djupa verktygsresultat. Samma tak som sanitizeForAudit. */
const MAX_DEPTH = 12

export interface SubjectCollector {
  /**
   * Organisationen turen tillhör. Kandidater valideras mot DENNA org, så ett
   * id som läckt in från en annan organisation kan aldrig bli en koppling.
   */
  organizationId: string
  /** Råa UUID-kandidater, ovaliderade. */
  candidates: Set<string>
}

const storage = new AsyncLocalStorage<SubjectCollector>()

/**
 * Öppnar en tur. Sätts vid AI-ingångarna (`chat`, `confirmAction`, `streamChat`)
 * och ingen annanstans.
 */
export function runWithSubjectCollector<T>(organizationId: string, fn: () => T): T {
  return storage.run({ organizationId, candidates: new Set<string>() }, fn)
}

/** Turens kollektor, eller `undefined` utanför en AI-tur. */
export function currentSubjectCollector(): SubjectCollector | undefined {
  return storage.getStore()
}

/**
 * Plockar ut UUID-liknande strängar ur ett godtyckligt värde och lägger dem som
 * kandidater. Tyst no-op utanför en tur — en bakgrundsjobbsväg som råkar anropa
 * ett verktyg ska inte krascha.
 *
 * Medvetet TYPBLIND: den letar inte efter fältnamnet `tenantId`, utan efter
 * varje UUID. Skälet är att verktygen returnerar olika former (`{ id }`,
 * `{ tenant: { id } }`, `{ tenantId }`, listor av allt detta) och en
 * fältnamnslista hade blivit ännu en uppräkning som tyst missar nästa verktyg.
 * Överskottet — fastighets-id, avtals-id — kostar ingenting: valideringen mot
 * `Tenant` släpper bara igenom det som faktiskt är en hyresgäst i rätt org.
 */
export function noteSubjectCandidates(value: unknown, depth = 0): void {
  const collector = storage.getStore()
  if (!collector || depth > MAX_DEPTH || value === null || value === undefined) return

  if (typeof value === 'string') {
    if (UUID_RE.test(value)) collector.candidates.add(value.toLowerCase())
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) noteSubjectCandidates(v, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      noteSubjectCandidates(v, depth + 1)
    }
  }
}
