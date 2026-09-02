import { SetMetadata, type Type } from '@nestjs/common'

/**
 * `@SinkIn` — jobbet PEKAR UT var dess felsänka bor (#619).
 *
 * ── PROBLEMET ───────────────────────────────────────────────────────────────
 *
 * `check-cron-error-sink.mjs` avgör om ett `@Cron`-jobb når den varaktiga
 * felsänkan genom att läsa jobbets egen metodkropp plus dess `*Unsafe`-delegat.
 * Det är rätt avgränsning för de flesta formerna, men inte för den som landade
 * i #617: sänkan ligger i den INRE tjänsten, och cron-metodens nakna `catch`
 * sväljer JUST DÄRFÖR att rapporteringen redan skett en nivå ner. Ett andra
 * sänkanrop där uppe hade gett två rader för ett fel.
 *
 * Utfallet var att `backup.scheduler.ts` stod som KVITTERAT — alltså som skuld
 * i formen, fast konverteringen var gjord. Sanningen bodde i prosa i en
 * kvitteringslista i stället för i en mätning.
 *
 * ── VARFÖR EN DEKLARATION OCH INTE ANROPSFÖLJNING ───────────────────────────
 *
 * Det uppenbara alternativet var att låta vakten följa anrop ut ur cron-metoden
 * ett steg. Det MÄTTES 2026-09-02 mot `8a43026` innan det valdes bort:
 *
 *     26 @Cron-jobb · 24 synligt täckta · 2 kvitterade
 *     ett steg ut fångar 1 av 2   (dailyFreshnessCheck, inte dailyBackup)
 *
 *     61 utgående anrop ur de 26 cron-kropparna
 *     29 upplöses till en klass i repot
 *      2 landar i en klass som binder en sänka
 *      8 jobb har FLER ÄN ETT upplöst anrop
 *
 * Talet som avgjorde är sprängradien. Distinkta cron-jobb per callee-klass:
 *
 *     LockService 7 · MailService 5 · PaymentFreshnessService 3
 *
 * Den dag `MailService` får en sänkbindning — fullt rimligt, den skickar sådant
 * som fallerar — hade anropsföljning flippat FEM jobb till "täckt" utan att
 * någon beslutat det. `LockService` sju. En vakt som ändrar svar på sju jobb av
 * en redigering i en helt annan fil mäter inte längre jobben.
 *
 * En deklaration kostar en rad, bor hos jobbet, och ändrar sig bara när någon
 * ändrar den.
 *
 * ── DEKLARATIONEN ÄR EN PEKARE, INTE ETT PÅSTÅENDE ──────────────────────────
 *
 * Vakten LITAR INTE på den. Den slår upp den utpekade klassen och metoden och
 * kräver att målet faktiskt når sänkan. En `@SinkIn` som pekar på en metod utan
 * sänka är RÖD, och en `@SinkIn` på ett jobb som redan når sänkan direkt är
 * också röd — annars blir deklarationen självcertifierande, vilket är exakt den
 * defekt kvitteringslistan hade, fast med finare syntax.
 *
 * ── VAD DEN INTE GÖR ────────────────────────────────────────────────────────
 *
 * Ingenting i runtime. Metadatan sätts med `SetMetadata` (husets mönster, jfr
 * `roles.decorator.ts`) och läses i dag av ingen `Reflector`. Deklarationen
 * finns för vakten och för läsaren. Typparametern gör dock att ett felstavat
 * metodnamn fälls av `tsc` och inte först av vakten.
 */
export const SINK_IN_KEY = 'cron:sink-in'

export interface SinkInDeklaration {
  /** Klassnamnet, som vakten slår upp i källträdet. */
  readonly tjänst: string
  /** Metoden i den klassen som anropar sänkan. */
  readonly metod: string
}

export const SinkIn = <T>(tjänst: Type<T>, metod: keyof T & string) =>
  SetMetadata<string, SinkInDeklaration>(SINK_IN_KEY, { tjänst: tjänst.name, metod })
