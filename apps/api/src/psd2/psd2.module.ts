import { BullModule } from '@nestjs/bull'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
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
import { PSD2_PROVIDER, type BankDataProvider } from './psd2.types'
import {
  PSD2_PROVIDER_VAR,
  PSD2_MOCK_SCENARIO_VAR,
  psd2MockRequested,
  psd2MockScenario,
} from './psd2-provider-mode'
import { MockBankDataProvider } from './providers/mock-bank-data.provider'
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
 *   Undantaget är mock-vägen nedan, som bara finns utanför produktion.
 *
 * DI-SPÄRR: modulen importerar ReconciliationModule (för den härdade ingestFromApi-
 * seamen) men ALDRIG AccountingModule — PSD2-koden kan strukturellt inte röra
 * journal/verifikat direkt, bara via den enda härdade vägen in.
 */
/**
 * Providervalet, UTBRUTET ur modulen så att `psd2.module.spec.ts` kan pröva det
 * utan att bygga hela grafen — och pröva SAMMA funktion, inte en kopia. Formen
 * är `bankIdProviderFactory`:s (#745 PR 3).
 *
 * Fail-closed: flaggan på men förutsättningar saknas → krascha vid boot, aldrig
 * en halvkonfigurerad bankkoppling i produktion.
 *
 * ── FYRA UTFALL, INTE TRE ───────────────────────────────────────────────────
 *
 *   flaggan av                                   → Stub (inert, 503)
 *   flaggan på, krypto saknas                    → kastar, om NYCKELN
 *   flaggan på, krypto finns, PSD2_PROVIDER=mock och NODE_ENV != production
 *                                                → Mock (dev och e2e)
 *   flaggan på, krypto finns, i övrigt           → kastar, om den SAKNADE ADAPTERN
 *
 * Mock-grenen ligger EFTER krypto-kontrollen med flit, och skälet är ett annat
 * än BankID:s. Där bar nyckeln identitetsbindningen; här bär `PSD2_TOKEN_KEY`
 * krypteringen av access-/refresh-tokens, och mock-flödet SKRIVER sådana tokens
 * i `BankConsent` via `handleCallback`. Utan nyckeln hade `crypto.encrypt`
 * kastat mitt i callbacken — ett fel som ser ut som ett trasigt samtyckesflöde i
 * stället för en saknad konfiguration.
 *
 * `psd2MockRequested` kastar av sig själv i produktion. Villkoret prövas
 * DESSUTOM av `validateEnv` oberoende av flaggan, så en produktionsmiljö med
 * variabeln satt vägrar starta även när PSD2_ENABLED är av — se
 * `psd2-provider-mode.ts`.
 */
export function psd2ProviderFactory(
  config: ConfigService,
  crypto: BankConsentCryptoService,
): BankDataProvider {
  const enabled = config.get<string>('PSD2_ENABLED') === 'true'
  if (!enabled) return new StubBankDataProvider()

  if (!crypto.configured) {
    throw new Error('[psd2] PSD2_ENABLED=true men PSD2_TOKEN_KEY saknas/ogiltig — fail-fast.')
  }

  // Env läses via ConfigService (samma källa som flaggan ovan) men skickas som
  // ett vanligt objekt: reglerna är RENA funktioner och ska kunna prövas utan
  // att någon rör process.env.
  const env = {
    [PSD2_PROVIDER_VAR]: config.get<string>(PSD2_PROVIDER_VAR),
    [PSD2_MOCK_SCENARIO_VAR]: config.get<string>(PSD2_MOCK_SCENARIO_VAR),
    NODE_ENV: config.get<string>('NODE_ENV'),
  }
  if (psd2MockRequested(env)) {
    return new MockBankDataProvider({ scenario: psd2MockScenario(env) })
  }

  throw new Error(
    '[psd2] PSD2_ENABLED=true men ingen skarp bank-data-adapter är konfigurerad. ' +
      'Enable Banking/Tink-adaptern levereras i P3 (kräver avtal/nycklar).',
  )
}

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
  constructor(config: ConfigService) {
    if (config.get<string>('PSD2_ENABLED') !== 'true') {
      this.logger.log('[psd2] inaktiverat (PSD2_ENABLED != true) — Stub-provider, API-ytan inert.')
    }
  }
}
