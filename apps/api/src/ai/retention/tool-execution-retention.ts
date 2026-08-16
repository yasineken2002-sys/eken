import { ACCOUNTING_ONLY_ACTIONS, ACTION_TOOLS, TOOLS } from '../tools/ai-tools.definition'

/**
 * GALLRINGSFRIST FÖR `AiToolExecution` — differentierad per verktyg.
 *
 * ── VARFÖR INTE ETT TAL ─────────────────────────────────────────────────────
 *
 * Ett uppslag i en enhetslista och ett verifikat som AI:n bokförde är inte
 * samma sorts spår, och ska inte ha samma frist.
 *
 * ── DEN AVGÖRANDE MÄTNINGEN ─────────────────────────────────────────────────
 *
 * Bokförings-verktygen får LÄNGRE frist än övriga, och skälet är inte ett
 * lagkrav — det är ett hål i datamodellen. Uppmätt i koden:
 *
 *   EventActorType     = USER | SYSTEM | WEBHOOK        ← ingen AI-variant
 *   JournalEntrySource = MANUAL | INVOICE | PAYMENT | …  ← ingen AI-variant
 *   create_journal_entry skriver  source: 'MANUAL', createdById: userId
 *
 * Ett verifikat som AI:n skapade är alltså i dagens data OMÖJLIGT att skilja
 * från ett som en människa skrev direkt i gränssnittet. Det finns ingen FK från
 * `JournalEntry`/`InvoiceEvent` till `AiToolExecution`.
 *
 * `AiToolExecution` är därmed den ENDA platsen där faktumet "detta gjordes av
 * AI, bekräftat av användare X vid tidpunkt Y" existerar. Gallras den tidigt
 * försvinner den distinktionen permanent för äldre poster.
 *
 * Den rätta långsiktiga åtgärden är att flytta faktumet dit det hör hemma — en
 * `AI`-variant i `EventActorType` och en nullbar referens på verifikatet — och
 * DÅ blir en kortare frist här oproblematisk. Så länge det inte är gjort är två
 * år en riskavvägning, inte en juridisk frist.
 *
 * ── VAD SOM ÄR AVGJORT OCH VAD SOM INTE ÄR DET ──────────────────────────────
 *
 * Bedömningen att `AiToolExecution` inte är räkenskapsinformation, och att
 * verifikatet är posten medan verktygsloggen är operativ metadata, kommer från
 * en AI-genererad bokföringsbedömning som ligger i GDPR-ärendet och som ska
 * MÄNNISKOVERIFIERAS mot BFN-vägledning. Inget lagrum skrivs här.
 *
 * Talen nedan är därför satta så att de tål att bedömningen faller åt andra
 * hållet: den längsta fristen täcker innevarande räkenskapsår plus det år då
 * bokslut och revision för det året normalt avslutas.
 */

/** Verktyg som rör bokföringen. Bär den längsta fristen — se docblocken ovan. */
export const ACCOUNTING_TOOLS: ReadonlySet<string> = new Set<string>([
  ...ACCOUNTING_ONLY_ACTIONS,
  // Bokföringsnära handlingar som ligger i ACTION_TOOLS men inte i den
  // ACCOUNTANT-avgränsade mängden: de skapar eller ändrar bokförda poster.
  'create_invoice',
  'mark_invoice_paid',
  'export_sie4',
  'apply_rent_increase',
])

export const ACCOUNTING_TOOL_RETENTION_DAYS = 730

/**
 * Övriga handlingsverktyg: **365 dagar**.
 *
 * Bindande handlingar, men var och en har en egen domänpost som bär sin egen
 * historik — `Lease`, `Property`, `MaintenanceTicket`, `InvoiceEvent`. Ett år
 * täcker reklamationer och tvister utan att låtsas att loggen är underlag.
 */
export const ACTION_TOOL_RETENTION_DAYS = 365

/**
 * Läsande verktyg: **90 dagar**.
 *
 * Ren telemetri. Inget domänobjekt skapas, ingenting att rekonstruera. Talet
 * speglar `CONSUMED_RETENTION_DAYS` i bilagestädningen i stället för att
 * uppfinna ett nytt.
 */
export const READ_TOOL_RETENTION_DAYS = 90

export type RetentionBucket = 'accounting' | 'action' | 'read'

export function bucketForTool(toolName: string): RetentionBucket {
  if (ACCOUNTING_TOOLS.has(toolName)) return 'accounting'
  if (ACTION_TOOLS.has(toolName)) return 'action'
  return 'read'
}

export function retentionDaysForBucket(bucket: RetentionBucket): number {
  switch (bucket) {
    case 'accounting':
      return ACCOUNTING_TOOL_RETENTION_DAYS
    case 'action':
      return ACTION_TOOL_RETENTION_DAYS
    case 'read':
      return READ_TOOL_RETENTION_DAYS
  }
}

/**
 * Alla verktygsnamn som finns i definitionen.
 *
 * Används av specen för att kräva att hinkindelningen täcker varje verktyg.
 * Poängen är att gallringspolicyn inte ska kunna driva isär från
 * behörighetsmodellen den dag någon lägger till ett verktyg — samma klass av
 * fel som en uppräkning som slutar spegla det den räknar upp.
 *
 * Notera att `bucketForTool` är FAIL-OPEN mot 90 dagar: ett okänt verktyg
 * hamnar i den kortaste hinken. Det är rätt för PII (mindre exponering) och fel
 * för spårbarhet, och det är precis därför specen kräver att varje verktyg är
 * klassat i stället för att lita på defaulten.
 */
export function allToolNames(): string[] {
  return TOOLS.map((t) => t.name)
}

/**
 * Verktygsnamn som INTE hamnar i läs-hinken.
 *
 * Läs-hinken definieras som komplementet, inte som en egen lista. Skälet är att
 * `AiToolExecution` kan innehålla rader skrivna av verktyg som sedan tagits bort
 * ur definitionen — en `in`-fråga på dagens läsverktyg hade lämnat dem kvar för
 * alltid, osynligt. Med `notIn` fångas de av den kortaste fristen, vilket är
 * rätt svar för ett verktyg vi inte längre kan klassificera.
 */
export function nonReadToolNames(): string[] {
  return allToolNames().filter((name) => bucketForTool(name) !== 'read')
}
