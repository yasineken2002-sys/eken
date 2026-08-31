import type { HistoryEvent } from '../api/history.api'

/**
 * KATEGORISERING PÅ FORM — aldrig på uppräkning.
 *
 * Filterflikarna får inte kunna GÖMMA en händelse. Två egenskaper garanterar
 * det tillsammans, och båda behövs:
 *
 *   1. `categoryOf` är TOTAL. Den sista regeln matchar allt, så varje händelse
 *      får exakt en kategori. Det finns ingen väg ut ur funktionen som
 *      returnerar `undefined`.
 *   2. Flikarna HÄRLEDS UR DATAN (`categoriesPresent`), inte ur listan nedan.
 *      En kategori renderas därför att den finns i svaret — inte därför att
 *      någon kom ihåg att lägga till den.
 *
 * Tillsammans betyder de att en händelsetyp API:t hittar på i morgon syns i
 * flödet i morgon: den hamnar i `ÖVRIGT` med sin egen svenska beskrivning
 * intakt, och `ÖVRIGT`-fliken dyker upp av sig själv. Den skrivs aldrig bort.
 *
 * Ordningen i `RULES` är betydelsebärande — första träff vinner.
 */
export type EventCategory =
  | 'AVTAL'
  | 'EKONOMI'
  | 'UNDERHÅLL'
  | 'BESIKTNING'
  | 'OBJEKT'
  | 'DOKUMENT'
  | 'KOMMUNIKATION'
  | 'PERSONUPPGIFTER'
  | 'AI'
  | 'ÖVRIGT'

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  AVTAL: 'Avtal',
  EKONOMI: 'Ekonomi',
  UNDERHÅLL: 'Underhåll',
  BESIKTNING: 'Besiktning',
  OBJEKT: 'Objekt',
  DOKUMENT: 'Dokument',
  KOMMUNIKATION: 'Kommunikation',
  PERSONUPPGIFTER: 'Personuppgifter',
  AI: 'AI',
  ÖVRIGT: 'Övrigt',
}

/** Prefixregler. Första träff vinner; sista raden matchar allt. */
const RULES: ReadonlyArray<readonly [RegExp, EventCategory]> = [
  [/^LEASE_/, 'AVTAL'],
  [/^TERMINATION_/, 'AVTAL'],
  [/^(INVOICE|RENT_NOTICE|DEPOSIT|CONSUMPTION|MISC)_/, 'EKONOMI'],
  [/^MAINTENANCE_PLAN_/, 'UNDERHÅLL'],
  [/^MAINTENANCE_/, 'UNDERHÅLL'],
  [/^INSPECTION_/, 'BESIKTNING'],
  [/^(KEY|METER|EQUIPMENT)_/, 'OBJEKT'],
  [/^DOCUMENT_/, 'DOKUMENT'],
  [/^(MESSAGE|NEWS)_/, 'KOMMUNIKATION'],
  [/^TENANT_ANONYMIZED/, 'PERSONUPPGIFTER'],
  [/^AI_/, 'AI'],
]

export function categoryOf(type: string): EventCategory {
  for (const [pattern, category] of RULES) if (pattern.test(type)) return category
  return 'ÖVRIGT'
}

/**
 * Kategorierna som FAKTISKT förekommer, i `EventCategory`-ordning.
 *
 * Härledd ur händelserna, aldrig ur en konstant — det är den halva av
 * garantin ovan som gör att en okänd typ inte kan bli oåtkomlig.
 */
export function categoriesPresent(events: readonly HistoryEvent[]): EventCategory[] {
  const finns = new Set(events.map((e) => categoryOf(e.type)))
  return (Object.keys(CATEGORY_LABELS) as EventCategory[]).filter((c) => finns.has(c))
}

/**
 * "Vad" — en kort svensk etikett för händelsetypen.
 *
 * Tre steg, och det tredje ljuger inte: exakt känd typ → familjenamn ur
 * prefixet → nyckeln rå. Alternativet, att avstava och versalisera nyckeln
 * automatiskt, hade producerat ENGELSKA rader ("Invoice overdue") i ett
 * svenskt gränssnitt och sett översatt ut utan att vara det. Detaljerna bärs
 * ändå av `description`, som API:t redan skriver på svenska.
 */
const EXACT: Record<string, string> = {
  LEASE_CREATED: 'Avtal skapat',
  LEASE_ACTIVATED: 'Avtal aktiverat',
  LEASE_TERMINATED: 'Avtal avslutat',
  TERMINATION_REQUESTED: 'Uppsägning begärd',
  TERMINATION_REVIEWED: 'Uppsägning behandlad',
  DEPOSIT_CREATED: 'Deposition skapad',
  DEPOSIT_PAID: 'Deposition betald',
  DEPOSIT_REFUNDED: 'Deposition återbetald',
  CONSUMPTION_CHARGED: 'Förbrukning debiterad',
  MISC_CHARGED: 'Övrig debitering',
  MAINTENANCE_REPORTED: 'Felanmälan',
  MAINTENANCE_COMPLETED: 'Fel åtgärdat',
  MAINTENANCE_PLAN_CREATED: 'Underhållsplan skapad',
  MAINTENANCE_PLAN_COMPLETED: 'Underhåll utfört',
  INSPECTION_SCHEDULED: 'Besiktning inplanerad',
  INSPECTION_COMPLETED: 'Besiktning utförd',
  KEY_ISSUED: 'Nyckel utlämnad',
  KEY_RETURNED: 'Nyckel återlämnad',
  METER_INSTALLED: 'Mätare installerad',
  METER_REMOVED: 'Mätare borttagen',
  METER_READING: 'Mätaravläsning',
  EQUIPMENT_INSTALLED: 'Utrustning installerad',
  EQUIPMENT_REPLACED: 'Utrustning utbytt',
  EQUIPMENT_REMOVED: 'Utrustning borttagen',
  DOCUMENT_ADDED: 'Dokument tillagt',
  DOCUMENT_SIGNED: 'Dokument signerat',
  MESSAGE_SENT: 'Meddelande skickat',
  NEWS_PUBLISHED: 'Nyhet publicerad',
  TENANT_ANONYMIZED: 'Personuppgifter borttagna',
  AI_TOOL_EXECUTED: 'AI utförde åtgärd',
  AI_TOOL_FAILED: 'AI-åtgärd misslyckades',
}

/** Familjenamn för de källor som bygger sin typ av data. */
const FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^INVOICE_/, 'Fakturahändelse'],
  [/^RENT_NOTICE_/, 'Avihändelse'],
  [/^AI_/, 'AI-åtgärd'],
]

export function eventLabel(type: string): string {
  const exakt = EXACT[type]
  if (exakt) return exakt
  for (const [pattern, family] of FAMILIES) if (pattern.test(type)) return family
  return type
}
