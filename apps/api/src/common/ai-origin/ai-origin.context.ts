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

/**
 * UPPDRAGSGIVAREN — vem körningen sker PÅ UPPDRAG AV.
 *
 * AI:n agerar aldrig av sig själv. Varje verktygskörning har en människa
 * bakom sig: en inloggad operatör i `web`, eller en hyresgäst i `portal`. De
 * två är olika sorters subjekt i olika tabeller (`User` respektive `Tenant`),
 * och ett fält som bara bar id:t hade inte kunnat skilja dem åt — därför en
 * diskriminerad union och inte en sträng.
 *
 * `kind` är alltså inte en etikett man kan glömma att sätta rätt: den avgör
 * vilken tabell `id` slår upp i, och typen tvingar fram valet.
 */
export type AiPrincipal =
  /** En inloggad användare i `web`. `id` är en `User.id`. */
  | { readonly kind: 'USER'; readonly id: string }
  /** En hyresgäst i `portal`. `id` är en `Tenant.id`. */
  | { readonly kind: 'TENANT'; readonly id: string }

type AiOrigin = {
  /** Id på den `AiToolExecution`-rad som skrivs efter körningen. */
  aiToolExecutionId: string
  /** Vem körningen sker på uppdrag av. Se `AiPrincipal`. */
  uppdragsgivare: AiPrincipal
}

const storage = new AsyncLocalStorage<AiOrigin>()

const GILTIGA_SLAG = new Set<AiPrincipal['kind']>(['USER', 'TENANT'])

/**
 * EN AI-KÖRNING UTAN DEKLARERAD UPPDRAGSGIVARE SKA INTE KUNNA STARTA.
 *
 * ── VARFÖR BÅDE EN TYP OCH EN KONTROLL I KÖRTID ────────────────────────────
 *
 * Typen ensam räcker inte. Den försvinner vid kompilering, och kodbasen har
 * redan `as never` på flera ställen där en attrapp trängs in i en riktig
 * signatur — ett testanrop eller en framtida anropare kan alltså sätta
 * `undefined` utan att något faller. Kontrollen i körtid är det som gör
 * påståendet mekaniskt i stället för dokumenterat.
 *
 * Kontrollen i körtid ensam räcker inte heller: den faller först NÄR koden
 * körs, och en väg som saknar täckning hade sluppit undan. Typen fäller vid
 * bygget, kontrollen fäller det typen inte kan se. Båda behövs, och båda
 * prövas var för sig i `ai-origin.spec.ts`.
 *
 * ── DEN FALLER STÄNGT ──────────────────────────────────────────────────────
 *
 * Den KASTAR, den varnar inte. En AI-körning vars uppdragsgivare är okänd
 * skriver rader ingen kan härleda i efterhand, och en varning hade blivit en
 * rad i en logg ingen läser. Det är samma val som `effectTraceIntegrity`
 * gör för okända verktyg: hellre stopp än ett spår som ser komplett ut.
 */
export function assertUppdragsgivare(u: AiPrincipal): asserts u is AiPrincipal {
  if (!u || typeof u !== 'object') {
    throw new Error('AI-körning utan uppdragsgivare: aktörsobjektet saknas')
  }
  if (!GILTIGA_SLAG.has(u.kind)) {
    throw new Error(`AI-körning med okänt uppdragsgivarslag: ${JSON.stringify(u.kind)}`)
  }
  if (typeof u.id !== 'string' || u.id.trim() === '') {
    throw new Error(`AI-körning utan uppdragsgivar-id (slag ${u.kind})`)
  }
}

/**
 * Kör `fn` med AI-ursprung i kontexten. Sätts vid AI-gränsen, ingen annanstans.
 *
 * `uppdragsgivare` är OBLIGATORISK och står FÖRE `fn` med flit: en ny anropare
 * kan inte utelämna den, och ett valfritt argument efter callbacken hade
 * kunnat glömmas utan att något föll. Se `assertUppdragsgivare`.
 */
export function runAsAi<T>(aiToolExecutionId: string, uppdragsgivare: AiPrincipal, fn: () => T): T {
  assertUppdragsgivare(uppdragsgivare)
  return storage.run({ aiToolExecutionId, uppdragsgivare }, fn)
}

/**
 * Uppdragsgivaren för den pågående kedjan, eller `undefined` utanför AI-vägen.
 *
 * Finns för G1 steg 3, som skriver det varaktiga aktörsslaget på domänraden.
 * Tills dess har den ingen anropare i produktionskod — och det är ett medvetet
 * undantag från "bygg inte frågevägen i förväg": den här läser en uppgift som
 * ALDRIG hade kunnat rekonstrueras i efterhand om den inte bars i kontexten
 * från början, och kostar noll att exponera.
 */
export function currentAiPrincipal(): AiPrincipal | undefined {
  return storage.getStore()?.uppdragsgivare
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
