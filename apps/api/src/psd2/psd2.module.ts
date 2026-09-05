import { BullModule } from '@nestjs/bull'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
import { Module, Logger, Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { ReconciliationModule } from '../reconciliation/reconciliation.module'
import { Psd2Controller } from './psd2.controller'
import { Psd2ConsentService } from './psd2-consent.service'
import { Psd2SyncService } from './psd2-sync.service'
import { Psd2SyncQueue, PSD2_SYNC_QUEUE } from './psd2-sync.queue'
import { Psd2SyncWorker } from './psd2-sync.worker'
import { BankConsentCryptoService } from './bank-consent-crypto.service'
import { PSD2_PROVIDER, type BankDataProvider } from './psd2.types'
import { psd2ProviderFactory } from './psd2-provider.factory'

/**
 * PSD2-bankkopplingsmodulen. Flaggan `PSD2_ENABLED` känns till på EXAKT ett ställe:
 * PSD2_PROVIDER-factoryn. Inaktiveringen bärs av providern (Stub), inte spridda
 * flagg-checkar.
 *
 * - `PSD2_ENABLED` != 'true' (default) → StubBankDataProvider (503, strukturellt
 *   inert; ingen sync enqueueas, inget samtycke kan skapas).
 * - `PSD2_ENABLED` == 'true' → fail-fast: token-krypto krävs, och skarp adapter
 *   (Enable Banking/Tink) levereras först i P3. Går alltså inte att aktivera i P2.
 *   Undantaget är mock-vägen nedan, som bara finns utanför produktion.
 *
 * DI-SPÄRR: modulen importerar ReconciliationModule (för den härdade ingestFromApi-
 * seamen) men ALDRIG AccountingModule — PSD2-koden kan strukturellt inte röra
 * journal/verifikat direkt, bara via den enda härdade vägen in.
 */
@Module({
  imports: [
    // CronErrorSinkModule (#605 batch 2) — importerar bara PrismaModule, ingen cykel.
    CronErrorSinkModule,
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
      useFactory: psd2ProviderFactory,
      inject: [ConfigService, BankConsentCryptoService],
    },
  ],
  exports: [Psd2ConsentService, Psd2SyncService, BankConsentCryptoService],
})
export class Psd2Module {
  private readonly logger = new Logger(Psd2Module.name)

  /**
   * Boot-raden skriver ut VILKEN provider som valdes, inte bara om flaggan är av.
   * Formen är `BankidModule`s, och skälet är detsamma: E2E-jobbet sätter
   * `PSD2_PROVIDER=mock` i sin `env`, och en variabel som inte når API-processen
   * ger Stub — alltså 503 på varje PSD2-endpoint, ett fel som ser ut som en
   * trasig spec och inte som en trasig konfiguration. CI grepar raden INNAN en
   * enda spec körs (`ci.yml`, steget "Verifiera att uppmjukningen är aktiv").
   *
   * Providern INJICERAS i stället för att härledas om ur `PSD2_PROVIDER_VAR`.
   * En andra uträkning hade kunnat säga något annat än det som faktiskt byggdes
   * — och då hade raden bevisat sig själv i stället för factoryn.
   *
   * VAD RADEN INTE KAN SE: att providern gör rätt när den väl valts. Det ägs av
   * `psd2-provider.spec.ts` (portkontraktet).
   */
  constructor(config: ConfigService, @Inject(PSD2_PROVIDER) provider: BankDataProvider) {
    if (config.get<string>('PSD2_ENABLED') !== 'true') {
      this.logger.log('[psd2] inaktiverat (PSD2_ENABLED != true) — Stub-provider, API-ytan inert.')
      return
    }
    this.logger.log(`[psd2] aktivt — provider ${provider.name}.`)
  }
}
