import { Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SigningCryptoService } from '../signing/signing-crypto.service'
import { BANKID_PROVIDER } from './bankid.types'
import { StubBankIdProvider } from './providers/stub-bankid.provider'

/**
 * BankID-inloggning. Flaggan `BANKID_ENABLED` känns till på EXAKT ett ställe:
 * BANKID_PROVIDER-factoryn. Inaktiveringen bärs av providern (Stub), inte av
 * spridda flagg-checkar.
 *
 * - `BANKID_ENABLED` != 'true' (default) → StubBankIdProvider (kan strukturellt
 *   inte autentisera någon; hela ytan blir inert med 503).
 * - `BANKID_ENABLED` == 'true' → fail-fast vid uppstart: krypto-nycklar krävs, och
 *   någon skarp adapter levereras först i S3. Går alltså inte att aktivera i S1 —
 *   precis avsikten (redo men inaktivt).
 *
 * Formen är kopierad från `SigningModule` och `Psd2Module`, med flit och rad för
 * rad. Tre moduler som stänger av sig själva på tre olika sätt vore tre saker
 * att läsa; en form som upprepas är en sak att lära sig.
 *
 * ── VARFÖR PORTEN ÄR SKILD FRÅN SigningProvider ────────────────────────────
 *
 * `signing.types.ts` säger det från andra hållet redan: `DocumentSigningProvider`
 * är "EGEN port, skild från en framtida BankIdProvider (inloggning) — de delar
 * bara en intern broker-transport, inte detta interface". De svarar på olika
 * frågor — "signera det HÄR dokumentet av DE HÄR parterna" mot "vem är personen
 * framför skärmen?" — och en gemensam abstraktion hade tvingat inloggningen att
 * bära envelope- och dokumentbegrepp den inte har. Se `bankid.types.ts`.
 *
 * Följden syns här: modulen har en EGEN flagga. `SIGNING_ENABLED` och
 * `BANKID_ENABLED` styr olika funktioner och ska kunna tändas var för sig —
 * inloggning med BankID kräver inget signeringsavtal, och tvärtom.
 *
 * ── VARFÖR SigningCryptoService PROVIDERAS OM I STÄLLET FÖR ATT IMPORTERAS ──
 *
 * Samma val och samma skäl som `PersonalNumberModule` (`common/crypto/`): att
 * importera `SigningModule` hade dragit in dess SIGNING_PROVIDER-factory, som med
 * flit kastar vid boot när `SIGNING_ENABLED=true` utan skarp adapter. Den
 * fail-fasten hör till SIGNERINGEN — den ska inte kunna fälla starten för att
 * någon aktiverat BankID-inloggning. Klassen är samma klass, så nyckel-, pepper-
 * och blindindex-hanteringen är bokstavligen densamma.
 *
 * `PersonalNumberModule` är `@Global` men EXPORTERAR inte `SigningCryptoService`
 * (bara `PersonalNumberService`), så den vägen finns inte att gå.
 */
@Module({
  providers: [
    SigningCryptoService,
    {
      provide: BANKID_PROVIDER,
      useFactory: (config: ConfigService, crypto: SigningCryptoService) => {
        const enabled = config.get<string>('BANKID_ENABLED') === 'true'
        if (!enabled) return new StubBankIdProvider()

        // Fail-closed: flaggan på men förutsättningar saknas → krascha vid boot,
        // aldrig en halvkonfigurerad eller fejkad inloggning i produktion.
        //
        // Krypto-kravet är inte formellt: identitetsbindningen mot BankID-
        // personnumret GÅR genom blind-indexet (HMAC med SIGNING_PII_PEPPER).
        // Utan pepper finns inget att matcha mot, och en inloggning som inte kan
        // matcha är antingen ett fel eller — värre — något som släpper igenom.
        if (!crypto.configured) {
          throw new Error(
            '[bankid] BANKID_ENABLED=true men SIGNING_PII_KEY/SIGNING_PII_PEPPER saknas — fail-fast.',
          )
        }
        throw new Error(
          '[bankid] BANKID_ENABLED=true men ingen skarp BankID-adapter är konfigurerad. ' +
            'Adaptern levereras i S3 (kräver avtal/nycklar).',
        )
      },
      inject: [ConfigService, SigningCryptoService],
    },
  ],
  exports: [BANKID_PROVIDER],
})
export class BankidModule {
  private readonly logger = new Logger(BankidModule.name)
  constructor(config: ConfigService) {
    if (config.get<string>('BANKID_ENABLED') !== 'true') {
      this.logger.log(
        '[bankid] inaktiverat (BANKID_ENABLED != true) — Stub-provider, inloggningsvägen inert.',
      )
    }
  }
}
