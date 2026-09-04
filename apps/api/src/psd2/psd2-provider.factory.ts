// VÄRDE-import, inte `import type`. Klassen används bara som typ i signaturen
// nedan, så en typ-import hade typechecka:t — men #580 är exakt det misstaget en
// nivå upp (`import type { ConfigService }` i en modul, raderad i runtime, 32 av
// 32 prov gröna medan API:t inte startade). Regeln i CLAUDE.md är att
// Nest-beroenden importeras som värden; att göra ett undantag här därför att just
// den här filen råkar klara sig hade gjort mönstret otydligt för nästa läsare.
import { ConfigService } from '@nestjs/config'

import { BankConsentCryptoService } from './bank-consent-crypto.service'
import type { BankDataProvider } from './psd2.types'
import {
  PSD2_PROVIDER_VAR,
  PSD2_MOCK_SCENARIO_VAR,
  psd2MockRequested,
  psd2MockScenario,
} from './psd2-provider-mode'
import { MockBankDataProvider } from './providers/mock-bank-data.provider'
import { StubBankDataProvider } from './providers/stub-bank-data.provider'

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
