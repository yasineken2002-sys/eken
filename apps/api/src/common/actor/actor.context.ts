/**
 * VEM UTFÖRDE — SOM KONTEXT, INTE SOM ARGUMENT (G1 steg 3).
 *
 * ── VARFÖR INTE ETT FÄLT SOM ANROPSSTÄLLET SÄTTER ───────────────────────────
 *
 * Uppmätt: de 23 modeller som bär kolumnen skrivs från **187 anropsställen**,
 * varav **183 inte är AI-vägen** (146 HTTP i 33 filer, 31 cron i 6, 3 kö, 3
 * webhook). Ett fält som 183 ställen måste komma ihåg att sätta ÄR den defekt
 * `runAsAi` byggdes för att undvika — `ai-origin.context.ts` skriver ut den:
 * "en framtida anropare KAN glömma att skicka med det, och då skrivs USER på en
 * AI-utförd handling utan att något faller". #503 trädde ned id:t till två
 * vägar, och fyra andra fortsatte skriva fel.
 *
 * Med en kontext sätts aktören EN gång vid var och en av tre gränser, och
 * `actorStampExtension` stämplar varje skrivning som sker innanför.
 *
 *     183 handpåläggningar  →  1 extension + 3 gränssättare
 *
 * ── PRISET, SOM INTE DÖLJS ──────────────────────────────────────────────────
 *
 * Dataflödet blir IMPLICIT. Läser man `InvoicesService.create` ser man inte var
 * `actorKind` kommer ifrån. Det är exakt den kostnad #504 redan accepterat och
 * dokumenterat för AI-ursprunget, och den betalas en andra gång här med öppna
 * ögon: mekanismen har ett namn som syns i diffen, en doc som pekar hit, och en
 * BLOCKERANDE vakt som fäller om påkopplingen försvinner.
 *
 * Kontexten korsar inte processgränser. Ett Bull-jobb som köas i en HTTP-request
 * körs senare i sin egen kontext och stämplas `SYSTEM`. Det är korrekt: jobbet
 * utförs av systemet.
 *
 * ── NULL ÄR OKÄNT, OCH DET FÅR INTE BLI TYST NORMALTILLSTÅND ────────────────
 *
 * En skrivning utanför alla tre gränserna får NULL. Aldrig ett default, aldrig
 * HUMAN. Att NULL är billigt är designens farligaste egenskap: en stämpling som
 * tyst slutar stämpla ger NULL överallt, och NULL betyder okänt — ett totalt
 * haveri hade alltså sett ut som ett normalt gammalt dataläge.
 *
 * MOTMEDLET ÄR EN BRYTPUNKT. Rader skapade före migrationen är legitimt NULL;
 * rader skapade EFTER den med NULL är precis läckan:
 *
 *     actorKind IS NULL AND createdAt > AKTORSKOLUMNENS_BRYTPUNKT
 *
 * Ingen räknare att glömma att öka, inget som kan gå ur synk — raderna ÄR
 * mätningen. `ActorNullSweepService` kör den över alla 23 tabeller och larmar
 * när talet är skilt från noll. Ett bortkopplat stämplande blir därmed det mest
 * HÖGLJUDDA utfallet, inte det tystaste.
 */
import { AsyncLocalStorage } from 'async_hooks'

/** Se `ActorKind` i schema.prisma. NULL/undefined = okänt, aldrig människa. */
export type ActorKind = 'HUMAN' | 'AGENT' | 'SYSTEM'

/**
 * BRYTPUNKTEN: när kolumnen började skrivas.
 *
 * Måste vara migrationens tidpunkt, inte deployens — en rad skriven mellan
 * migrationen och deployen får legitimt NULL, och en brytpunkt som ligger
 * FÖRE den kan bara ge falska larm (läsbara), medan en som ligger EFTER ger
 * tystnad (inte läsbar). Konservativt åt rätt håll.
 */
export const AKTORSKOLUMNENS_BRYTPUNKT = new Date('2026-09-02T00:00:00Z')

const storage = new AsyncLocalStorage<ActorKind>()

/**
 * Kör `fn` med en känd aktör i kontexten. Sätts vid EN av tre gränser:
 *
 *   HUMAN   `JwtAuthGuard`-vägen — en inloggad användare eller hyresgäst.
 *   SYSTEM  cron-wrappern och köns workers.
 *   AGENT   `runAsAi` — AI-gränsen, som redan bär sin uppdragsgivare.
 *
 * INGA ANDRA STÄLLEN. Vakten `check-actor-stamping` härleder gränserna ur
 * källkoden och fäller om de blir fler eller färre, just för att "sätt den här
 * på lämpligt ställe" är hur en mekanism blir en konvention.
 */
export function runWithActor<T>(kind: ActorKind, fn: () => T): T {
  return storage.run(kind, fn)
}

/** Aktören för den pågående kedjan, eller `undefined` utanför alla gränser. */
export function currentActor(): ActorKind | undefined {
  return storage.getStore()
}
