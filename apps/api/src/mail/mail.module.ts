import { BullModule } from '@nestjs/bull'
import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { MailQueue } from './mail.queue'
import { MailRenderer } from './mail.renderer'
import { MailService } from './mail.service'
import { MailWorkerHigh, MailWorkerNormal, MailWorkerLow } from './mail.worker'
import { QUEUE_HIGH, QUEUE_LOW, QUEUE_NORMAL } from './mail.types'
// Providas HÄR, inte via AviseringModule: den modulen importerar MailModule, så
// ett import åt andra hållet vore en cykel. Tjänsten bär inget tillstånd och
// beror bara på PrismaService, så en andra instans är samma skrivare.
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { pausedUnless } from '../common/ops/automation-pause'

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
  imports: [
    ConfigModule,
    PrismaModule,
    BullModule.registerQueue({ name: QUEUE_HIGH }, { name: QUEUE_NORMAL }, { name: QUEUE_LOW }),
  ],
  providers: [
    RentNoticeEventsService,
    MailRenderer,
    MailQueue,
    MailService,
    ...pausedUnless(MailWorkerHigh),
    ...pausedUnless(MailWorkerNormal),
    ...pausedUnless(MailWorkerLow),
  ],
  exports: [MailService],
})
export class MailModule {}
