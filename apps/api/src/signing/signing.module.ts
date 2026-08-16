import { Module, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SigningController } from './signing.controller'
import { SigningService } from './signing.service'
import { SigningCryptoService } from './signing-crypto.service'
import { SIGNING_PROVIDER } from './signing.types'
import { StubSigningProvider } from './providers/stub-signing.provider'

/**
 * Signeringsmodulen. Flaggan `SIGNING_ENABLED` känns till på EXAKT ett ställe:
 * SIGNING_PROVIDER-factoryn. Inaktiveringen bärs av providern (Stub), inte av
 * spridda flagg-checkar.
 *
 * - `SIGNING_ENABLED` != 'true' (default) → StubSigningProvider (kan strukturellt
 *   inte signera; hela API-ytan blir inert med 503).
 * - `SIGNING_ENABLED` == 'true' → fail-fast vid uppstart: krypto-nycklar krävs, och
 *   någon skarp adapter (Scrive) levereras först i S3. Går alltså inte att aktivera
 *   i S1 — precis avsikten (redo men inaktivt).
 *
 * ATT TÄNDA FLAGGAN BÄR ETT VILLKOR TILL: `PiiCoherenceService`
 * (`common/crypto/pii-coherence.service.ts`) kontrollerar vid uppstart att
 * SIGNING_PII_KEY/SIGNING_PII_PEPPER fortfarande hör ihop med datan, och larmar
 * i dag bara (Sentry). Med `SIGNING_ENABLED=true` bär peppern en aktiv
 * säkerhetsfunktion — identitetsbindningen mot BankID-personnumret går genom
 * blind-indexet — och kontrollen ska då BEFORDRAS TILL FAIL-FAST, i samma
 * grind som nycklarna redan kontrolleras i. Skälet står utskrivet i den filen.
 *
 * VILKA UTFALL SOM SKA FÄLLA när den befordras:
 *  • `MISSMATCHNING` och `KAN_EJ_VERIFIERAS` SKA fälla starten.
 *  • `ROTATION_PAGAR` ska INTE — det är rotationens normaltillstånd, och att
 *    fälla på det tar bort det nedtidsfria fönster #469 byggdes för (#472).
 */
@Module({
  controllers: [SigningController],
  providers: [
    SigningService,
    SigningCryptoService,
    {
      provide: SIGNING_PROVIDER,
      useFactory: (config: ConfigService, crypto: SigningCryptoService) => {
        const enabled = config.get<string>('SIGNING_ENABLED') === 'true'
        if (!enabled) return new StubSigningProvider()

        // Fail-closed: flaggan på men förutsättningar saknas → krascha vid boot,
        // aldrig en halvkonfigurerad/fejkad signering i produktion.
        if (!crypto.configured) {
          throw new Error(
            '[signing] SIGNING_ENABLED=true men SIGNING_PII_KEY/SIGNING_PII_PEPPER saknas — fail-fast.',
          )
        }
        throw new Error(
          '[signing] SIGNING_ENABLED=true men ingen skarp signeringsadapter är konfigurerad. ' +
            'Scrive/Assently-adaptern levereras i S3 (kräver avtal/nycklar).',
        )
      },
      inject: [ConfigService, SigningCryptoService],
    },
  ],
  exports: [SigningService, SigningCryptoService],
})
export class SigningModule {
  private readonly logger = new Logger(SigningModule.name)
  constructor(config: ConfigService) {
    if (config.get<string>('SIGNING_ENABLED') !== 'true') {
      this.logger.log(
        '[signing] inaktiverat (SIGNING_ENABLED != true) — Stub-provider, API-ytan inert.',
      )
    }
  }
}
