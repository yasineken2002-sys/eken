import { Module } from '@nestjs/common'
import { PrismaModule } from '../common/prisma/prisma.module'
import { VerifikationsnummerService } from './verifikationsnummer.service'

/**
 * Fristående modul för verifikationsnummertilldelning. Importeras av alla
 * moduler som skapar JournalEntry (Accounting, Ai, Notifications) — håller
 * tilldelningslogiken på ett ställe utan att skapa cirkulära beroenden
 * (beror enbart på PrismaModule).
 */
@Module({
  imports: [PrismaModule],
  providers: [VerifikationsnummerService],
  exports: [VerifikationsnummerService],
})
export class VerifikationsnummerModule {}
