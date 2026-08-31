/**
 * KÄLLAN SKA GÅ ATT KLICKA PÅ — ELLER SYNAS SOM ATT DEN INTE GÖR DET.
 *
 * Varje historikrad bär `source: { table, id }`, som pekar på den domänpost
 * raden härleddes ur. Poängen är att påståendet ska gå att verifiera.
 *
 * Men webben har inte en detaljvy per tabell. Nycklar (`KeyHandover`), övriga
 * debiteringar (`MiscCharge`) och anonymiseringsloggen har ingen egen route i
 * `app/router.tsx` — mätt, inte antaget. Frestelsen är att länka dem till
 * närmaste sida ändå, så att allt ser lika klickbart ut.
 *
 * Det vore samma fel som en tom lista som betyder två saker: en länk som inte
 * leder dit den utger sig för att leda är ett falskt påstående om att posten
 * går att slå upp. Tabeller utan destination får därför `null` och renderas som
 * TEXT — synligt oklickbara, med tabellnamn och id kvar så uppgiften ändå går
 * att slå upp för hand.
 *
 * Destinationerna nedan är listsidor, inte enskilda poster: appens detaljvyer
 * öppnas som modaler ur en tabell och har ingen egen URL. Länken tar alltså
 * användaren till rätt vy — inte till rätt rad — och etiketten lovar inte mer
 * än så.
 */
export type SourceRoute =
  | '/leases'
  | '/invoices'
  | '/avisering'
  | '/maintenance'
  | '/inspections'
  | '/deposits'
  | '/terminations'
  | '/documents'
  | '/messages'
  | '/consumption'
  | '/maintenance-plan'
  | '/news'
  | '/ai'
  | '/units'

interface SourceTarget {
  route: SourceRoute
  /** Vad användaren kommer till — inte vad hen letade efter. */
  label: string
}

const TARGETS: Record<string, SourceTarget> = {
  Lease: { route: '/leases', label: 'Avtal' },
  InvoiceEvent: { route: '/invoices', label: 'Fakturor' },
  RentNoticeEvent: { route: '/avisering', label: 'Hyresavier' },
  MaintenanceTicket: { route: '/maintenance', label: 'Felanmälan' },
  Inspection: { route: '/inspections', label: 'Besiktningar' },
  Deposit: { route: '/deposits', label: 'Depositioner' },
  TerminationRequest: { route: '/terminations', label: 'Uppsägningar' },
  Document: { route: '/documents', label: 'Dokument' },
  SentMessage: { route: '/messages', label: 'Meddelanden' },
  ConsumptionCharge: { route: '/consumption', label: 'Förbrukning' },
  Meter: { route: '/consumption', label: 'Mätare' },
  MaintenancePlan: { route: '/maintenance-plan', label: 'Underhållsplan' },
  NewsPost: { route: '/news', label: 'Nyheter' },
  AiToolExecution: { route: '/ai', label: 'AI-assistenten' },
  UnitEquipment: { route: '/units', label: 'Objekt' },
  UnitEquipmentEvent: { route: '/units', label: 'Objekt' },
  // Utan destination — MEDVETET, inte glömt:
  //   KeyHandover, MiscCharge, TenantAnonymizationLog
  // Ingen av dem har en route i app/router.tsx. De renderas som text.
}

/** `null` = ingen vy att gå till. Rendera som text, aldrig som länk. */
export function sourceTarget(table: string): SourceTarget | null {
  return TARGETS[table] ?? null
}

/** Kort, igenkännbart id-fragment för handuppslag. Aldrig hela UUID:t i en rad. */
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
