import { BullModule } from '@nestjs/bull'
import { Global, Module } from '@nestjs/common'
import { PdfQueue } from './pdf.queue'
import { PdfWorker } from './pdf.worker'
import { QUEUE_PDF } from './pdf.types'
import { pausedUnless } from '../common/ops/automation-pause'

/**
 * PDF-jobbkön (FIX 5). Global så att feature-services kan injicera PdfQueue
 * utan att varje modul behöver importera den här modulen explicit — samma
 * upplägg som MailModule.
 *
 * PdfWorker delegerar till feature-services via ModuleRef, så den här modulen
 * importerar medvetet inga feature-moduler (skulle ge cirkulära beroenden).
 */
/**
 * DRIFTPAUS: `pausedUnless` UTELÄMNAR konsumenten ur `providers` när
 * OPS_AUTOMATION_PAUSED=true. Det är strukturellt och inte en flagga i
 * jobbkroppen: `BullExplorer.onModuleInit` anropar `queue.process(...)` för
 * varje upptäckt @Processor-provider (bull.explorer.js), så en konsument som
 * aldrig registreras kan aldrig plocka ett jobb — inte heller det första, innan
 * någon kontroll hunnit köra.
 *
 * KÖN SJÄLV REGISTRERAS SOM VANLIGT. Producenter (`*.queue.ts`) fungerar därför
 * oförändrat, och waiting/delayed-jobb blir kvar i Redis i stället för att tappas
 * eller kvitteras. Pausen stoppar KONSUMTIONEN, den tömmer ingenting.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_PDF })],
  providers: [PdfQueue, ...pausedUnless(PdfWorker)],
  exports: [PdfQueue],
})
export class PdfQueueModule {}
