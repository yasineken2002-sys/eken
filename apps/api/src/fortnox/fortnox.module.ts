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
  fortnoxRealConfig,
} from './fortnox-providers'
import { RealFortnoxAuthProvider, RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxOAuthClient, type FortnoxOAuthScope } from './provider/fortnox-oauth-client'
import { FortnoxTransport } from './provider/fortnox-transport'
import { InMemoryFortnoxRateLimiter } from './provider/fortnox-rate-limiter'

/**
 * Minsta använda scope-mängd: företagsbindning, huvudbok/år/konton, kostnadsställen
 * och projekt (katalogen läser projekt). Inga leverantörs-/fakturascope.
 */
export const FORTNOX_SCOPES: readonly FortnoxOAuthScope[] = [
  'companyinformation',
  'bookkeeping',
  'costcenter',
  'project',
]

const FORTNOX_REAL_CLIENTS = Symbol('FORTNOX_REAL_CLIENTS')
type RealClients = {
  oauth: FortnoxOAuthClient
  transport: FortnoxTransport
  clientId: string
  redirectUri: string
} | null

/**
 * Singletons för den skarpa vägen (en OAuth-klient, en transport, EN processlokal
 * limiter). Skapas bara i REAL-läge; fetch injiceras uttryckligen här och ingen
 * annanstans. Limitern är inte distribuerad — flera processer kräver global limiter.
 */
export function realClients(config: ConfigService, crypto: FortnoxTokenCryptoService): RealClients {
  if (fortnoxMode(config, crypto) !== 'REAL') return null
  const c = fortnoxRealConfig(config)
  const fetch = globalThis.fetch.bind(globalThis)
  return {
    oauth: new FortnoxOAuthClient({
      fetch,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      redirectUri: c.redirectUri,
      enabled: true,
    }),
    transport: new FortnoxTransport({ fetch, rateLimiter: new InMemoryFortnoxRateLimiter() }),
    clientId: c.clientId,
    redirectUri: c.redirectUri,
  }
}
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
 * Skarp provider endast vid uttryckligt FORTNOX_PROVIDER=real med komplett
 * konfiguration; annars på → fail-fast vid boot.
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
      provide: FORTNOX_REAL_CLIENTS,
      useFactory: realClients,
      inject: [ConfigService, FortnoxTokenCryptoService],
    },
    {
      provide: FORTNOX_AUTH_PROVIDER,
      useFactory: (config: ConfigService, crypto: FortnoxTokenCryptoService, real: RealClients) => {
        const mode = fortnoxMode(config, crypto)
        if (mode === 'REAL' && real) {
          return new RealFortnoxAuthProvider({
            client: real.oauth,
            redirectUri: real.redirectUri,
            scopes: FORTNOX_SCOPES,
            enabled: true,
          })
        }
        return mode === 'MOCK' ? new MockFortnoxAuthProvider() : new StubFortnoxAuthProvider()
      },
      inject: [ConfigService, FortnoxTokenCryptoService, FORTNOX_REAL_CLIENTS],
    },
    {
      provide: FORTNOX_LEDGER_READER,
      useFactory: (config: ConfigService, crypto: FortnoxTokenCryptoService, real: RealClients) => {
        const mode = fortnoxMode(config, crypto)
        if (mode === 'REAL' && real) {
          return new RealFortnoxLedgerReader({
            transport: real.transport,
            clientId: real.clientId,
            enabled: true,
          })
        }
        return mode === 'MOCK' ? new MockFortnoxLedgerReader() : new StubFortnoxLedgerReader()
      },
      inject: [ConfigService, FortnoxTokenCryptoService, FORTNOX_REAL_CLIENTS],
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
        : auth.name === 'MOCK'
          ? '[fortnox] MOCK-provider (endast NODE_ENV=test).'
          : '[fortnox] SKARP provider uttryckligen konfigurerad.',
    )
  }
}
