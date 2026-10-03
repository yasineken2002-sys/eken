import { Inject, Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaModule } from '../common/prisma/prisma.module'
import { FortnoxController } from './fortnox.controller'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FORTNOX_VOUCHER_DRAFT_BUILDER, FortnoxExportService } from './fortnox-export.service'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FortnoxSendService } from './fortnox-send.service'
import {
  DisabledVoucherWriter,
  FORTNOX_VOUCHER_WRITER,
  MockVoucherWriter,
  RealFortnoxVoucherWriter,
} from './fortnox-voucher-writer'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import {
  MockFortnoxAuthProvider,
  MockFortnoxLedgerReader,
  StubFortnoxAuthProvider,
  StubFortnoxLedgerReader,
  fortnoxMode,
  fortnoxRealConfig,
  fortnoxTestVoucherWritesOptIn,
} from './fortnox-providers'
import { RealFortnoxAuthProvider, RealFortnoxLedgerReader } from './fortnox-real-provider'
import type { FortnoxVoucher } from './fortnox.types'
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
  /** Endast vid uttrycklig opt-in för testföretaget; annars null (ingen skrivförmåga). */
  writeTransport: FortnoxTransport | null
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
  const rateLimiter = new InMemoryFortnoxRateLimiter()
  return {
    oauth: new FortnoxOAuthClient({
      fetch,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      redirectUri: c.redirectUri,
      enabled: true,
    }),
    transport: new FortnoxTransport({ fetch, rateLimiter }),
    writeTransport: fortnoxTestVoucherWritesOptIn(config)
      ? new FortnoxTransport({ fetch, rateLimiter, allowVoucherWrites: true })
      : null,
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
        if (mode !== 'MOCK') return new StubFortnoxLedgerReader()
        const mock = new MockFortnoxLedgerReader()
        // Syntetiskt demoscenario för produktprov (endast Mock, alltså NODE_ENV=test).
        if (config.get<string>('FORTNOX_MOCK_SCENARIO') === 'demo')
          mock.vouchers = mockDemoVouchers()
        return mock
      },
      inject: [ConfigService, FortnoxTokenCryptoService, FORTNOX_REAL_CLIENTS],
    },
    // Förhandskontroll (dry run) med referenser verifierade i Fortnox i samma stund;
    // transformern är den frysta exportkomponenten. Ingen sändning finns.
    { provide: FORTNOX_VOUCHER_DRAFT_BUILDER, useClass: VerifiedVoucherDraftBuilder },
    // Skrivare: Mock (syntetisk, NODE_ENV=test), eller skarp ENDAST i REAL med
    // uttrycklig opt-in och då bara mot den hårdkodade testföretagslistan.
    // Stub och REAL utan opt-in får DisabledVoucherWriter.
    {
      provide: FORTNOX_VOUCHER_WRITER,
      useFactory: (reader: unknown, config: ConfigService, real: RealClients) => {
        // Validerar opt-in-värdet i alla lägen (felstavning stoppar boot).
        fortnoxTestVoucherWritesOptIn(config)
        if (reader instanceof RealFortnoxLedgerReader && real?.writeTransport) {
          return new RealFortnoxVoucherWriter({
            transport: real.writeTransport,
            reader,
            clientId: real.clientId,
          })
        }
        if (!(reader instanceof MockFortnoxLedgerReader)) return new DisabledVoucherWriter()
        const writer = new MockVoucherWriter(reader)
        // Syntetiskt felscenario för produktprov (endast Mock ⇒ NODE_ENV=test):
        // första sändningen skrivs men svaret tappas (okänt utfall).
        if (config.get<string>('FORTNOX_MOCK_WRITE_FAULT') === 'unknown_after_write_once') {
          writer.faults.push('unknown_after_write')
        }
        return writer
      },
      inject: [FORTNOX_LEDGER_READER, ConfigService, FORTNOX_REAL_CLIENTS],
    },
    FortnoxSendService,
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

/** Facit S4a (syntetiskt): 12 000 HUSA, 4 000 HUSA + 2 000 HUSB, 2 000 utan dimension, återföring + ny. */
function mockDemoVouchers(): FortnoxVoucher[] {
  const v = (n: number, date: string, rows: Array<[number, number, number, string?]>) => ({
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: n,
    TransactionDate: date,
    VoucherRows: rows.map(([Account, Debit, Credit, CostCenter]) => ({
      Account,
      Debit,
      Credit,
      Removed: false,
      ...(CostCenter ? { CostCenter } : {}),
    })),
  })
  return [
    v(1, '2026-10-02', [
      [5170, 12000, 0, 'HUSA'],
      [2440, 0, 12000],
    ]),
    v(2, '2026-10-05', [
      [5170, 4000, 0, 'HUSA'],
      [5170, 2000, 0, 'HUSB'],
      [2440, 0, 6000],
    ]),
    v(3, '2026-10-07', [
      [5170, 2000, 0],
      [2440, 0, 2000],
    ]),
    v(4, '2026-10-20', [
      [5170, 0, 12000, 'HUSA'],
      [2440, 12000, 0],
    ]),
    v(5, '2026-10-20', [
      [5170, 15000, 0, 'HUSA'],
      [2440, 0, 15000],
    ]),
  ]
}
