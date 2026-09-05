/**
 * SCENARIONA — ETT PROV PER VÄRDE, INTE ETT FÖRTROENDE FÖR EN TYP.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * `active` täcktes av e2e (#777) och `expired` av `psd2.module.spec.ts`.
 * `revoked` och `error` täcktes av INGENTING: de vilade på att `SCENARIO_STATUS`
 * i `mock-bank-data.provider.ts` är en uttömmande `Record<Psd2MockScenario, …>`,
 * alltså på typen. Det stod som en känd lucka i `ci.yml`, och den här filen
 * stänger den.
 *
 * En uttömmande Record garanterar att varje scenario HAR en status. Den säger
 * ingenting om att det är RÄTT status: `revoked: 'EXPIRED'` typechecka:r lika
 * bra som `revoked: 'REVOKED'`. Skillnaden syns bara i en körning.
 *
 * ── ARBETSFÖRDELNING ────────────────────────────────────────────────────────
 *
 * Här: de RENA funktionerna (`psd2MockRequested`, `psd2MockScenario`) och vad
 * `MockBankDataProvider` blir av ett scenario. Att FACTORYN läser dem, och att
 * DI-containern kan bygga grafen, ägs av `psd2.module.spec.ts`. Att modulen
 * kopplar in factoryn ägs av e2e-provet.
 *
 * Miljön rörs aldrig: båda funktionerna tar `env` explicit, så inget behöver
 * nollställas (#685-formen).
 */

import {
  PSD2_MOCK_SCENARIOS,
  PSD2_MOCK_SCENARIO_DEFAULT,
  ProductionMockProviderError,
  UnknownMockScenarioError,
  psd2MockRequested,
  psd2MockScenario,
  type Psd2MockScenario,
} from './psd2-provider-mode'
import { MockBankDataProvider } from './providers/mock-bank-data.provider'
import type { ProviderConsentStatus } from './psd2.types'

/**
 * FACIT, skrivet för hand och med flit inte härlett ur `SCENARIO_STATUS`. Ett
 * facit som läser samma tabell som koden är en spegel: den kan bara visa att
 * tabellen är sig lik, aldrig att den är rätt.
 */
const FACIT: Record<Psd2MockScenario, { status: ProviderConsentStatus; inflöde: boolean }> = {
  active: { status: 'ACTIVE', inflöde: true },
  expired: { status: 'EXPIRED', inflöde: false },
  revoked: { status: 'REVOKED', inflöde: false },
  error: { status: 'ERROR', inflöde: false },
}

describe('psd2MockScenario — vilket scenario variabeln väljer', () => {
  it('KANARIEFÅGEL: facit och scenariomängd är lika stora', () => {
    // Utan den här raden kan ett nytt scenario läggas till utan att något prov
    // täcker det — facit är handskrivet, alltså kan det halka efter.
    expect(Object.keys(FACIT).sort()).toEqual([...PSD2_MOCK_SCENARIOS].sort())
  })

  it.each(PSD2_MOCK_SCENARIOS)("'%s' läses som sig självt", (scenario) => {
    expect(psd2MockScenario({ PSD2_MOCK_SCENARIO: scenario })).toBe(scenario)
  })

  it('saknad och tom variabel ger default, inte ett kast', () => {
    expect(psd2MockScenario({})).toBe(PSD2_MOCK_SCENARIO_DEFAULT)
    expect(psd2MockScenario({ PSD2_MOCK_SCENARIO: '' })).toBe(PSD2_MOCK_SCENARIO_DEFAULT)
  })

  it.each(['EXPIRED', 'Active', 'expired_', 'aktiv', 'true', '0'])(
    "okänt värde '%s' KASTAR — faller aldrig tyst tillbaka på default",
    (värde) => {
      // Hela poängen: en felstavning som tyst gav 'active' hade sett ut som att
      // UI:t inte klarar EXPIRED-fallet, och felsökningen riktats mot fel kod.
      expect(() => psd2MockScenario({ PSD2_MOCK_SCENARIO: värde })).toThrow(
        UnknownMockScenarioError,
      )
      expect(() => psd2MockScenario({ PSD2_MOCK_SCENARIO: värde })).toThrow(/inget känt scenario/)
    },
  )
})

describe('MockBankDataProvider — scenariot ger status OCH inflöde', () => {
  it.each(PSD2_MOCK_SCENARIOS)("'%s' ger den status facit kräver", (scenario) => {
    const provider = new MockBankDataProvider({ scenario })
    expect(provider.consentStatus).toBe(FACIT[scenario].status)
  })

  it.each(PSD2_MOCK_SCENARIOS)("'%s' ger inflöde bara när samtycket lever", (scenario) => {
    // Andra halvan av samma påstående, och den som gör provet mer än en
    // avskrift: ett dött samtycke som ändå levererar transaktioner vore en
    // fiktion som inte kan uppstå mot en riktig bank.
    const provider = new MockBankDataProvider({ scenario })
    expect(provider.transactions.length > 0).toBe(FACIT[scenario].inflöde)
  })

  it.each(PSD2_MOCK_SCENARIOS)(
    "'%s' rapporteras av getConsentStatus, inte bara av fältet",
    async (scenario) => {
      // Fältet är skrivbart av jest-vägen; det är METODEN synken anropar. Ett prov
      // på enbart fältet hade inte sett att getConsentStatus slutat läsa det.
      const provider = new MockBankDataProvider({ scenario })
      const svar = await provider.getConsentStatus({ consentId: 'c', accessToken: 't' })
      expect(svar.status).toBe(FACIT[scenario].status)
    },
  )

  it('MOTPROV: utan scenario är jest-vägen oförändrad (ACTIVE, inga transaktioner)', () => {
    // Den parameterlösa konstruktorn används av varje befintlig spec. Skulle
    // scenariovägen ha ändrat den hade proven ovan kunnat vara gröna medan
    // sviten i övrigt mätte något annat än den gjorde före #774.
    const provider = new MockBankDataProvider()
    expect(provider.consentStatus).toBe('ACTIVE')
    expect(provider.transactions).toHaveLength(0)
  })
})

describe('psd2MockRequested — bara exakt "mock", och aldrig i produktion', () => {
  it("exakt 'mock' begär mocken", () => {
    expect(psd2MockRequested({ PSD2_PROVIDER: 'mock' })).toBe(true)
  })

  it.each(['MOCK', 'Mock', 'true', '1', '', 'stub'])(
    "'%s' begär den INTE — allt utom exakt 'mock' faller åt det säkra hållet",
    (värde) => {
      expect(psd2MockRequested({ PSD2_PROVIDER: värde })).toBe(false)
    },
  )

  it('saknad variabel begär den inte', () => {
    expect(psd2MockRequested({})).toBe(false)
  })

  it("'mock' + NODE_ENV=production KASTAR — påhittad bankdata i prod är omöjlig", () => {
    expect(() => psd2MockRequested({ PSD2_PROVIDER: 'mock', NODE_ENV: 'production' })).toThrow(
      ProductionMockProviderError,
    )
  })

  it('MOTPROV: produktion utan variabeln kastar inte', () => {
    // Utan den kan provet ovan vara grönt av att funktionen kastar på NODE_ENV
    // ensamt, alltså av fel skäl.
    expect(() => psd2MockRequested({ NODE_ENV: 'production' })).not.toThrow()
  })
})
