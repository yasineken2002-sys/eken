import { BullModule } from '@nestjs/bull'
import { Module, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { ReconciliationModule } from '../reconciliation/reconciliation.module'
import { Psd2Controller } from './psd2.controller'
import { Psd2ConsentService } from './psd2-consent.service'
import { Psd2SyncService } from './psd2-sync.service'
import { Psd2SyncQueue, PSD2_SYNC_QUEUE } from './psd2-sync.queue'
import { Psd2SyncWorker } from './psd2-sync.worker'
import { BankConsentCryptoService } from './bank-consent-crypto.service'
import { PSD2_PROVIDER } from './psd2.types'
import { StubBankDataProvider } from './providers/stub-bank-data.provider'

/**
 * PSD2-bankkopplingsmodulen. Flaggan `PSD2_ENABLED` känns till på EXAKT ett ställe:
 * PSD2_PROVIDER-factoryn. Inaktiveringen bärs av providern (Stub), inte spridda
 * flagg-checkar.
 *
 * - `PSD2_ENABLED` != 'true' (default) → StubBankDataProvider (503, strukturellt
 *   inert; ingen sync enqueueas, inget samtycke kan skapas).
 * - `PSD2_ENABLED` == 'true' → fail-fast: token-krypto krävs, och skarp adapter
 *   (Enable Banking/Tink) levereras först i P3. Går alltså inte att aktivera i P2.
 *
 * DI-SPÄRR: modulen importerar ReconciliationModule (för den härdade ingestFromApi-
 * seamen) men ALDRIG AccountingModule — PSD2-koden kan strukturellt inte röra
 * journal/verifikat direkt, bara via den enda härdade vägen in.
 */
@Module({
  imports: [
    PrismaModule,
    ReconciliationModule,
    BullModule.registerQueue({ name: PSD2_SYNC_QUEUE }),
  ],
  controllers: [Psd2Controller],
  providers: [
    Psd2ConsentService,
    Psd2SyncService,
    Psd2SyncQueue,
    Psd2SyncWorker,
    BankConsentCryptoService,
    {
      provide: PSD2_PROVIDER,
      useFactory: (config: ConfigService, crypto: BankConsentCryptoService) => {
        const enabled = config.get<string>('PSD2_ENABLED') === 'true'
        if (!enabled) return new StubBankDataProvider()

        // Fail-closed: flaggan på men förutsättningar saknas → krascha vid boot,
        // aldrig en halvkonfigurerad bankkoppling i produktion.
        if (!crypto.configured) {
          throw new Error('[psd2] PSD2_ENABLED=true men PSD2_TOKEN_KEY saknas/ogiltig — fail-fast.')
        }
        throw new Error(
          '[psd2] PSD2_ENABLED=true men ingen skarp bank-data-adapter är konfigurerad. ' +
            'Enable Banking/Tink-adaptern levereras i P3 (kräver avtal/nycklar).',
        )
      },
      inject: [ConfigService, BankConsentCryptoService],
    },
  ],
  exports: [Psd2ConsentService, Psd2SyncService, BankConsentCryptoService],
})
export class Psd2Module {
  private readonly logger = new Logger(Psd2Module.name)
  constructor(config: ConfigService) {
    if (config.get<string>('PSD2_ENABLED') !== 'true') {
      this.logger.log('[psd2] inaktiverat (PSD2_ENABLED != true) — Stub-provider, API-ytan inert.')
    }
  }
}
