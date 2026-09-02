import { Module } from '@nestjs/common'

import { PrismaModule } from '../prisma/prisma.module'
import { ActorNullSweepService } from './actor-null-sweep.service'

/**
 * Bär bara NULL-svepet. Kontexten och interceptorn är fristående (ingen DI):
 * kontexten är en modullokal AsyncLocalStorage, och interceptorn registreras
 * globalt i `main.ts` eftersom den måste ligga ytterst.
 */
@Module({
  imports: [PrismaModule],
  providers: [ActorNullSweepService],
  exports: [ActorNullSweepService],
})
export class ActorModule {}
