/**
 * AI-URSPRUNG SOM REQUEST-SCOPED KONTEXT (#504).
 *
 * ── VARFÖR INTE ETT EXPLICIT ARGUMENT ──────────────────────────────────────
 *
 * Alternativet var att tråda ned ett valfritt `actorContext` genom varje
 * anropskedja: tool-executor → InvoicesService → InvoiceEventsService. Det är
 * lättare att läsa, men det uppfyller inte kravet — en framtida anropare KAN
 * glömma att skicka med det, och då skrivs `USER` på en AI-utförd handling utan
 * att något faller. Precis det hålet är skälet till att det här ärendet finns:
 * #503 trädde igenom id:t till två verifikatvägar, och de fyra andra vägarna
 * fortsatte skriva USER för att ingen kom ihåg dem.
 *
 * Med en AsyncLocalStorage sätts ursprunget EN gång, vid AI-gränsen
 * (`ToolExecutorService.executeTool`), och allt som körs innanför den — hur
 * djupt ned i anropskedjan det än ligger, inklusive tjänster som skrivs i
 * morgon — ser det utan att någon behöver minnas något.
 *
 * ── VAD DET KOSTAR ─────────────────────────────────────────────────────────
 *
 * 1. Dataflödet blir implicit. Läser man `InvoiceEventsService.record` ser man
 *    inte var `AI` kommer ifrån. Det är därför `resolveActorType` har ett namn
 *    som syns i diffen och en doc som pekar hit.
 * 2. Kontexten följer med i asynkrona kedjor men INTE över processgränser. Ett
 *    Bull-jobb som köas inne i ett verktyg körs senare, i en egen kontext, och
 *    märks alltså inte som AI. Det är korrekt: jobbet utförs av systemet.
 * 3. Tester måste sätta kontexten explicit. Vakten i den här PR:en gör det.
 *
 * ── VARFÖR DET INTE KAN LÄCKA ──────────────────────────────────────────────
 *
 * `runAsAi` omsluter exakt ett verktygsanrop. Allt som körs där inne ÄR per
 * definition AI-initierat. Utanför den returnerar `currentAiOrigin()`
 * `undefined`, och `resolveActorType` lämnar tillbaka det anroparen bad om.
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { EventActorType } from '@prisma/client'

type AiOrigin = {
  /** Id på den `AiToolExecution`-rad som skrivs efter körningen. */
  aiToolExecutionId: string
}

const storage = new AsyncLocalStorage<AiOrigin>()

/** Kör `fn` med AI-ursprung i kontexten. Sätts vid AI-gränsen, ingen annanstans. */
export function runAsAi<T>(aiToolExecutionId: string, fn: () => T): T {
  return storage.run({ aiToolExecutionId }, fn)
}

/** AI-ursprunget för den pågående kedjan, eller `undefined` utanför AI-vägen. */
export function currentAiOrigin(): AiOrigin | undefined {
  return storage.getStore()
}

/**
 * Aktörstypen som ska skrivas: `AI` inne i en verktygskörning, annars den typ
 * anroparen angav.
 *
 * ALLA händelseskrivningar ska gå genom den här funktionen — även cron- och
 * webhook-vägar, som aldrig kan hamna i AI-kontext. Utanför AI returnerar den
 * sitt argument oförändrat, så deras beteende är detsamma. Skälet till att de
 * ändå går via den är att regeln då blir mekaniskt kontrollerbar: en
 * hårdkodad `actorType: 'USER'` någonstans är per definition en väg som glömt
 * ursprunget, och vakten kan säga det utan att känna till vilka vägar som finns.
 */
export function resolveActorType(fallback: EventActorType): EventActorType {
  return currentAiOrigin() ? 'AI' : fallback
}

/**
 * Fält att sprida in i en händelserad som bär `aiToolExecutionId`.
 *
 * Returnerar ett TOMT objekt utanför AI-vägen i stället för
 * `{ aiToolExecutionId: undefined }` — `exactOptionalPropertyTypes: true` gör
 * skillnad på "fältet saknas" och "fältet är undefined", och Prismas
 * `UncheckedCreateInput` accepterar inte det senare.
 *
 * Bara `InvoiceEvent` och `JournalEntry` har kolumnen (#503).
 * `RentNoticeEvent` och `AccountingPeriodEvent` har den inte, och får därför
 * bara aktörstypen — ingen migration behövs för det här ärendet.
 */
export function aiOriginColumns(): { aiToolExecutionId: string } | Record<string, never> {
  const origin = currentAiOrigin()
  return origin ? { aiToolExecutionId: origin.aiToolExecutionId } : {}
}
