import { BullModule } from '@nestjs/bull'
import { Global, Module } from '@nestjs/common'
import { PdfQueue } from './pdf.queue'
import { PdfWorker } from './pdf.worker'
import { QUEUE_PDF } from './pdf.types'

/**
 * PDF-jobbkön (FIX 5). Global så att feature-services kan injicera PdfQueue
 * utan att varje modul behöver importera den här modulen explicit — samma
 * upplägg som MailModule.
 *
 * PdfWorker delegerar till feature-services via ModuleRef, så den här modulen
 * importerar medvetet inga feature-moduler (skulle ge cirkulära beroenden).
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_PDF })],
  providers: [PdfQueue, PdfWorker],
  exports: [PdfQueue],
})
export class PdfQueueModule {}
