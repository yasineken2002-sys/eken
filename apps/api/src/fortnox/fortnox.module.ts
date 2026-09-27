import { Module } from '@nestjs/common'

import { PrismaModule } from '../common/prisma/prisma.module'
import { FortnoxOutboxService } from './fortnox-outbox.service'
import { FORTNOX_PROVIDER } from './fortnox.types'
import { StubFortnoxProvider } from './providers/stub-fortnox.provider'

/**
 * Fortnox skiva 01 — OANSLUTEN modul.
 *
 * Registreras INTE i AppModule (kontrakt G7), och `fortnox-inert.spec.ts` fäller
 * om någon fil utanför den här katalogen importerar den. Stub är den enda
 * providern: ingen env läses, ingen flagga finns, ingen skarp adapter finns.
 * Mocken injiceras bara direkt i prov, aldrig via modulen.
 *
 * DI-SPÄRR, samma som PSD2: modulen importerar aldrig AccountingModule. En
 * framtida koppling till affärshändelser är ett eget, granskat steg.
 *
 * Den här modulen mäter att ingenting är PÅKOPPLAT. Den kan inte se att en
 * framtida inkoppling beter sig rätt — det ägs av den inkopplingens egna prov.
 */
@Module({
  imports: [PrismaModule],
  providers: [{ provide: FORTNOX_PROVIDER, useClass: StubFortnoxProvider }, FortnoxOutboxService],
  exports: [FortnoxOutboxService],
})
export class FortnoxModule {}
