import { Inject, Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AuthModule } from '../auth/auth.module'
import { CronErrorSinkModule } from '../common/cron/cron-error-sink.module'
import { PrismaModule } from '../common/prisma/prisma.module'
import { SigningCryptoService } from '../signing/signing-crypto.service'
import { BankIdAuthService } from './bankid-auth.service'
import { BankIdController } from './bankid.controller'
import { BANKID_PROVIDER, type BankIdProvider } from './bankid.types'
import { BANKID_PROVIDER_VAR, bankIdMockRequested } from './bankid-provider-mode'
import { MockBankIdProvider } from './providers/mock-bankid.provider'
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
/**
 * Providervalet, UTBRUTET ur modulen så att `bankid.module.spec.ts` kan pröva
 * det utan att bygga hela grafen — och pröva SAMMA funktion, inte en kopia.
 *
 * Fail-closed: flaggan på men förutsättningar saknas → krascha vid boot, aldrig
 * en halvkonfigurerad eller fejkad inloggning i produktion.
 *
 * Krypto-kravet är inte formellt: identitetsbindningen mot BankID-personnumret
 * GÅR genom blind-indexet (HMAC med SIGNING_PII_PEPPER). Utan pepper finns
 * inget att matcha mot, och en inloggning som inte kan matcha är antingen ett
 * fel eller — värre — något som släpper igenom.
 *
 * ── FYRA UTFALL, INTE TRE ───────────────────────────────────────────────────
 *
 *   flaggan av                                   → Stub (inert, 503)
 *   flaggan på, krypto saknas                    → kastar, om NYCKLARNA
 *   flaggan på, krypto finns, BANKID_PROVIDER=mock och NODE_ENV != production
 *                                                → Mock (dev och E2E)
 *   flaggan på, krypto finns, i övrigt           → kastar, om den SAKNADE ADAPTERN
 *
 * Mock-grenen ligger EFTER krypto-kontrollen med flit: mocken används just för
 * att pröva identitetsbindningen, och den kan inte blindindexera utan pepper.
 * En mock som "fungerade" utan nycklar hade gett ett grönt flöde som saknar
 * exakt den mekanism flödet finns för.
 *
 * `bankIdMockRequested` kastar av sig själv i produktion. Villkoret prövas
 * DESSUTOM av `validateEnv` oberoende av flaggan, så en produktionsmiljö med
 * variabeln satt vägrar starta även när BANKID_ENABLED är av — se
 * `bankid-provider-mode.ts`.
 */
export function bankIdProviderFactory(
  config: ConfigService,
  crypto: SigningCryptoService,
): BankIdProvider {
  const enabled = config.get<string>('BANKID_ENABLED') === 'true'
  if (!enabled) return new StubBankIdProvider()

  if (!crypto.configured) {
    throw new Error(
      '[bankid] BANKID_ENABLED=true men SIGNING_PII_KEY/SIGNING_PII_PEPPER saknas — fail-fast.',
    )
  }

  // Env läses via ConfigService (samma källa som flaggan ovan) men skickas som
  // ett vanligt objekt: regeln är en REN funktion och ska kunna prövas utan att
  // någon rör process.env.
  const mock = bankIdMockRequested({
    [BANKID_PROVIDER_VAR]: config.get<string>(BANKID_PROVIDER_VAR),
    NODE_ENV: config.get<string>('NODE_ENV'),
  })
  if (mock) return new MockBankIdProvider({ orderRefPrefix: 'dev' })

  throw new Error(
    '[bankid] BANKID_ENABLED=true men ingen skarp BankID-adapter är konfigurerad. ' +
      'Adaptern levereras i S3 (kräver avtal/nycklar).',
  )
}

@Module({
  // AuthModule för `issueAuthResponseForUser` — BankID-vägen ska sluta i EXAKT samma
  // tokenutfärdande som lösenordsinloggningen, inte i ett parallellt.
  // CronErrorSinkModule importerar bara PrismaModule och kan inte sluta en cykel.
  imports: [PrismaModule, CronErrorSinkModule, AuthModule],
  controllers: [BankIdController],
  providers: [
    SigningCryptoService,
    BankIdAuthService,
    {
      provide: BANKID_PROVIDER,
      useFactory: bankIdProviderFactory,
      inject: [ConfigService, SigningCryptoService],
    },
  ],
  exports: [BANKID_PROVIDER, BankIdAuthService],
})
export class BankidModule {
  private readonly logger = new Logger(BankidModule.name)

  /**
   * Boot-raden skriver ut VILKEN provider som valdes, inte bara om flaggan är av.
   *
   * Skälet är E2E: jobbet sätter `BANKID_PROVIDER=mock` i sin `env`, och en
   * variabel som inte når API-processen hade gett 503 på varje anrop — alltså
   * ett fel som ser ut som en trasig spec och inte som en trasig konfiguration.
   * Samma läxa och samma åtgärd som `E2E_RELAX_AUTH_THROTTLE` (#454): CI
   * kontrollerar raden i loggen INNAN en enda spec körs.
   *
   * Providern injiceras i stället för att härledas om — då är raden ett svar om
   * det som faktiskt byggdes, inte en andra uträkning som kan säga något annat.
   */
  constructor(config: ConfigService, @Inject(BANKID_PROVIDER) provider: BankIdProvider) {
    if (config.get<string>('BANKID_ENABLED') !== 'true') {
      this.logger.log(
        '[bankid] inaktiverat (BANKID_ENABLED != true) — Stub-provider, inloggningsvägen inert.',
      )
      return
    }
    this.logger.log(`[bankid] aktivt — provider ${provider.name}.`)
  }
}
