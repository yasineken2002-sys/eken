import { Inject, Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { FortnoxController } from './fortnox.controller'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import {
  FORTNOX_VOUCHER_DRAFT_BUILDER,
  FortnoxExportService,
  PendingVoucherDraftBuilder,
} from './fortnox-export.service'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import {
  MockFortnoxAuthProvider,
  MockFortnoxLedgerReader,
  StubFortnoxAuthProvider,
  StubFortnoxLedgerReader,
  fortnoxMode,
} from './fortnox-providers'
import {
  FORTNOX_AUTH_PROVIDER,
  FORTNOX_LEDGER_READER,
  type FortnoxAuthProvider,
} from './fortnox.types'

/**
 * Fortnox A. INERT som standard (FORTNOX_ENABLED != true → Stub, 503 på anslutning).
 *
 * Registrerar INGEN cron, kö, worker eller hook (K-F2): automationsinventeringen
 * är oförändrad oavsett flagga. Läsning sker endast på uttrycklig begäran.
 * Ingen skarp provider finns: på + ej test-mock → fail-fast vid boot.
 */
@Module({
  imports: [PrismaModule],
  controllers: [FortnoxController],
  providers: [
    FortnoxTokenCryptoService,
    FortnoxConnectionService,
    FortnoxReadbackService,
    FortnoxExportService,
    FortnoxMappingService,
    {
      provide: FORTNOX_AUTH_PROVIDER,
      useFactory: (config: ConfigService, crypto: FortnoxTokenCryptoService) =>
        fortnoxMode(config, crypto) === 'MOCK'
          ? new MockFortnoxAuthProvider()
          : new StubFortnoxAuthProvider(),
      inject: [ConfigService, FortnoxTokenCryptoService],
    },
    {
      provide: FORTNOX_LEDGER_READER,
      useFactory: (config: ConfigService, crypto: FortnoxTokenCryptoService) =>
        fortnoxMode(config, crypto) === 'MOCK'
          ? new MockFortnoxLedgerReader()
          : new StubFortnoxLedgerReader(),
      inject: [ConfigService, FortnoxTokenCryptoService],
    },
    // Transformer-leveransen (export/fortnox-voucher-draft.ts) kräver verifierade
    // konto-/år-/serie-/dimensionsreferenser som ännu inte finns i produkten →
    // förhandskontrollen blockerar uttryckligen tills de finns.
    { provide: FORTNOX_VOUCHER_DRAFT_BUILDER, useClass: PendingVoucherDraftBuilder },
  ],
  exports: [FortnoxReadbackService],
})
export class FortnoxModule {
  private readonly logger = new Logger(FortnoxModule.name)

  constructor(@Inject(FORTNOX_AUTH_PROVIDER) auth: FortnoxAuthProvider) {
    this.logger.log(
      auth.name === 'STUB'
        ? '[fortnox] inaktiverat (FORTNOX_ENABLED != true) — Stub, API-ytan inert.'
        : '[fortnox] MOCK-provider (endast NODE_ENV=test).',
    )
  }
}
