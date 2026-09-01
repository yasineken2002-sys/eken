import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { PlatformErrorsService } from '../../platform/errors/platform-errors.service'
import { CronErrorSink } from './cron-error-sink'

/**
 * Gör `CronErrorSink` injicerbar för de moduler som äger cron-jobb.
 *
 * ── VARFÖR INTE `imports: [PlatformModule]` ─────────────────────────────────
 *
 * Det var första versionen, och den gav en MODULCYKEL som ingen enhetstest kunde
 * se — sviten var grön på 340 sviter medan API:t inte startade alls:
 *
 *     NotificationsModule → CronErrorSinkModule → PlatformModule
 *                         → InvoicesModule → NotificationsModule
 *
 * `PlatformModule` importerar `InvoicesModule` (rad 42), som importerar
 * `NotificationsModule` (rad 13). Att koppla sänkan till notifications slöt
 * alltså ringen.
 *
 * `PlatformErrorsService` behöver bara `PrismaService` (`constructor(private
 * prisma: PrismaService)`), så modulen tillhandahåller den själv i stället.
 * Ingen `forwardRef` behövs, och ingen cykel uppstår.
 *
 * KONSEKVENSEN, uttalad: appen får en andra instans av `PlatformErrorsService`.
 * Den är tillståndslös och skriver bara via Prisma, så instanserna kan inte
 * driva isär — det är IMPLEMENTATIONEN som delas, och den finns fortfarande på
 * ett ställe. Hade tjänsten haft tillstånd vore det här fel lösning.
 */
@Module({
  imports: [PrismaModule],
  providers: [PlatformErrorsService, CronErrorSink],
  exports: [CronErrorSink],
})
export class CronErrorSinkModule {}
