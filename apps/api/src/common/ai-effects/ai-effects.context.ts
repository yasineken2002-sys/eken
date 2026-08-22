/**
 * UTFALLSKOPPLINGEN — AiToolExecution ska veta vad den ORSAKADE.
 *
 * ── VAD SOM SAKNADES ─────────────────────────────────────────────────────────
 *
 * `AiToolExecution` lagrade vad AI:n FÖRSÖKTE: verktygsnamn, maskerad input,
 * utfall, varaktighet. Den lagrade inte vad som faktiskt SKAPADES eller
 * ÄNDRADES. Ingen kunde därför svara på "vad gjorde AI:n i tisdags, och hur tar
 * jag tillbaka det". För en assistent går det an. För ett agentiskt bygge går det
 * inte: en åtgärd som inte går att spåra till sitt utfall går heller inte att
 * granska, verifiera eller backa.
 *
 * ── VARFÖR MEKANISM OCH INTE KONVENTION (mätt) ───────────────────────────────
 *
 * Det uppenbara vore att låta varje verktyg returnera sina id:n. Mätningen säger
 * att det inte håller:
 *
 *   • Ungefär hälften av de 29 ACTION_TOOLS returnerar ett `id` i dag. Resten
 *     returnerar antal, sammanfattningar eller bara ett meddelande. Formen är
 *     varje verktygs eget val, inte ett kontrakt.
 *   • En statisk genomgång kunde lösa upp skrivningarna för 9 av 29 verktyg.
 *     Övriga skriver 2–4 anropsnivåer ned i tjänstelagret. Kan inte en analys
 *     räkna upp dem, kan inte en verktygsförfattare göra det heller.
 *   • Flera verktyg rör ETT OBEGRÄNSAT antal rader (`generate_rent_notices`,
 *     `import_bgmax_file`, `send_overdue_reminders`).
 *
 * En regel som varje författare ska komma ihåg är en VANA. Kopplingen produceras
 * därför av skrivvägen själv: en Prisma-klientextension noterar varje skrivning
 * som sker medan `currentAiOrigin()` är satt. Ett trettionde verktyg ärver
 * spårbarheten utan att någon tänker på det — samma konstruktion som `runAsAi`
 * (#504) redan ger det `actorType: 'AI'`, och som `createReversalEntry` (#538)
 * gör med reverseringsinvarianten.
 *
 * ── VARFÖR EN KOLLEKTOR OCH INTE EN SKRIVNING PER EFFEKT ─────────────────────
 *
 * Extensionen kan inte skriva sin egen rad inne i anroparens transaktion —
 * `$extends` ser inte transaktionsklienten, så en skrivning därifrån hade gått
 * på en egen anslutning och därmed UTANFÖR transaktionen. En rollback hade då
 * lämnat en effektrad som pekar på en entitet som aldrig blev till: ett
 * revisionsspår som ljuger, vilket är värre än inget.
 *
 * Effekterna samlas därför i minnet under turen och persisteras EN gång,
 * tillsammans med `AiToolExecution` — exakt mönstret från `runWithSubjectCollector`
 * (#510). Följden är att effekterna delar auditradens livsöde: dör processen
 * mellan verktyget och loggningen försvinner båda. Det är samma accepterade risk
 * som redan gäller auditraden.
 *
 * Att de skrivs TILLSAMMANS är också skälet till att `AiToolEffect` har en
 * främmande nyckel till körningen medan `JournalEntry.aiToolExecutionId` inte
 * har det: verifikatet skrivs inne i verktygets transaktion och måste få peka i
 * tomma intet, men en effekt kan per konstruktion aldrig finnas utan sin rad.
 */

import { AsyncLocalStorage } from 'async_hooks'

/** Vad som hände med en rad. Speglar Prismas skrivoperationer, inte domänen. */
export type AiEffectOperation = 'CREATE' | 'UPDATE' | 'DELETE'

export interface AiToolEffect {
  /** Prisma-modellens namn, t.ex. `Invoice`. Versal första bokstav. */
  entityType: string
  /**
   * Radens id, när det går att veta.
   *
   * NULL för `updateMany`/`deleteMany`: Prisma returnerar bara ett antal, och
   * att slå upp id:na i efterhand hade krävt en extra fråga i skrivvägen — en
   * kostnad på VARJE skrivning för att förbättra ett revisionsspår i en
   * minoritet av fallen. `rowCount` bär då hur många rader som rördes, så
   * "AI:n rörde 47 avier" är fortfarande ett sant och användbart påstående.
   */
  entityId: string | null
  operation: AiEffectOperation
  /** Antal rader. 1 för enkeloperationer, N för *Many. */
  rowCount: number
}

interface EffectCollector {
  effects: AiToolEffect[]
}

const storage = new AsyncLocalStorage<EffectCollector>()

/**
 * Öppnar en effektinsamling. Sätts vid VERKTYGSGRÄNSEN (`executeTool`) och
 * ingen annanstans — samma ställe som `runAsAi`, så de två kontexterna alltid
 * har samma livslängd.
 */
export function runWithEffectCollector<T>(fn: () => T): T {
  return storage.run({ effects: [] }, fn)
}

/**
 * Notera en skrivning. Tyst no-op utanför en verktygskörning — varje vanlig
 * REST-, cron- och webhook-skrivning passerar extensionen, och de ska inte
 * kosta något.
 */
export function noteEffect(effect: AiToolEffect): void {
  storage.getStore()?.effects.push(effect)
}

/**
 * Hämta och TÖM turens effekter.
 *
 * Tömningen är avsiktlig: `logToolExecution` anropas en gång per körning, och en
 * kvarlämnad lista hade kunnat skrivas två gånger om en framtida väg loggar om.
 * Utanför en körning: tom lista, aldrig undefined — anroparen ska inte behöva
 * skilja "ingen kontext" från "inga effekter", för utfallet är detsamma.
 */
export function drainEffects(): AiToolEffect[] {
  const collector = storage.getStore()
  if (!collector) return []
  const ut = collector.effects
  collector.effects = []
  return ut
}
