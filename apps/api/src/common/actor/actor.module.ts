import { Module } from '@nestjs/common'

import { CronErrorSinkModule } from '../cron/cron-error-sink.module'
import { PrismaModule } from '../prisma/prisma.module'
import { ActorNullSweepService } from './actor-null-sweep.service'

/**
 * Bär bara NULL-svepet. Kontexten och interceptorn är fristående (ingen DI):
 * kontexten är en modullokal AsyncLocalStorage, och interceptorn registreras
 * globalt i `main.ts` eftersom den måste ligga ytterst.
 */
@Module({
  imports: [PrismaModule, CronErrorSinkModule],
  providers: [ActorNullSweepService],
  exports: [ActorNullSweepService],
})
export class ActorModule {}
