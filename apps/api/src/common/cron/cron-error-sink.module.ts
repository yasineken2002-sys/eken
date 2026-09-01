import { Module } from '@nestjs/common'
import { PlatformModule } from '../../platform/platform.module'
import { CronErrorSink } from './cron-error-sink'

/**
 * Gör `CronErrorSink` injicerbar för de moduler som äger cron-jobb.
 *
 * Riktningen common → platform har precedens: `common/filters/
 * global-exception.filter.ts` importerar samma tjänst direkt. `PlatformModule`
 * exporterar `PlatformErrorsService`, så inget nytt behöver öppnas.
 */
@Module({
  imports: [PlatformModule],
  providers: [CronErrorSink],
  exports: [CronErrorSink],
})
export class CronErrorSinkModule {}
