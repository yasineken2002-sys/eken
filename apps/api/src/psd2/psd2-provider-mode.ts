/**
 * FÅR MOCK-PROVIDERN VÄLJAS AV EN MILJÖVARIABEL? — PSD2:s svar, i BankID:s form.
 *
 * ── VARFÖR FILEN FINNS ──────────────────────────────────────────────────────
 *
 * `bankid-provider-mode.ts` skrevs i #745 PR 3 och konstaterade i sitt eget
 * huvud att `MockBankDataProvider` konstrueras uteslutande av specar, och att
 * PSD2:s factory bara känner två utfall — Stub eller fail-fast. Det stämde, och
 * konsekvensen var densamma som för BankID: bankkopplingens UI gick inte att
 * köra alls. En utvecklare som startar dev-servern fick en Stub som svarar 503
 * på varje endpoint, och en E2E-spec kunde inte skapa ett samtycke. Att bygga
 * ett gränssnitt mot en yta som strukturellt inte kan svara är att bygga blint.
 *
 * Formen nedan är BankID:s, med flit och rad för rad — samma skäl som
 * `psd2.module.ts` anger för att den kopierade `SigningModule`s form: tre
 * moduler som stänger av sig själva på tre olika sätt vore tre saker att läsa,
 * en form som upprepas är en sak att lära sig.
 *
 * ── VARFÖR INTE BARA "SÄTT PSD2_PROVIDER" ───────────────────────────────────
 *
 * En fri miljövariabel skapar en väg att köra PRODUKTION mot en provider som
 * hittar på bankdata. Felriktningen är värre här än för en inloggning: mocken
 * matar `ingestFromApi`, alltså exakt den väg som skapar `BankTransaction`-rader
 * och kan trigga matchning mot riktiga avier. En felstavad variabel i Railway
 * hade gett påhittade betalningar i en riktig kunds avstämning — och ingenting
 * hade blivit rött.
 *
 * Valet är därför bundet till KÖRNINGSLÄGET, inte till ett värde:
 *
 *   1. Variabeln saknas, är tom eller har ett okänt värde  → INGEN mock. Alltid.
 *      Det finns inget värde som "råkar" välja mocken; bara exakt 'mock'.
 *   2. Variabeln är 'mock' OCH NODE_ENV=production          → KASTAR.
 *      Inte "olämpligt" — omöjligt. Appen vägrar starta.
 *
 * Punkt 2 kontrolleras vid boot av `validateEnv`, alltså före första requesten,
 * och OBEROENDE av `PSD2_ENABLED`. Det är avsiktligt: en produktionsmiljö som
 * bär `PSD2_PROVIDER=mock` är felkonfigurerad även när flaggan råkar vara av,
 * och ska upptäckas när variabeln sätts — inte den dag någon tänder flaggan.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Att någon konstruerar `MockBankDataProvider` direkt någon annanstans än i
 * factoryn eller i ett prov. Den vägen bär `psd2.module.spec.ts` (factoryns fyra
 * utfall), inte den här funktionen.
 */

export const PSD2_PROVIDER_VAR = 'PSD2_PROVIDER'

/** Det enda värdet som väljer mocken. Allt annat — inklusive 'MOCK' — gör det inte. */
export const PSD2_PROVIDER_MOCK = 'mock'

export const PSD2_MOCK_SCENARIO_VAR = 'PSD2_MOCK_SCENARIO'

/**
 * Scenariona mocken kan spela upp i dev/e2e. Ordningen är godtycklig; mängden är
 * inte — den speglar `BankConsentStatus` i schemat, så en ny statuskod utan ett
 * scenario blir synlig här i stället för att bara saknas i UI:t.
 */
export const PSD2_MOCK_SCENARIOS = ['active', 'expired', 'revoked', 'error'] as const
export type Psd2MockScenario = (typeof PSD2_MOCK_SCENARIOS)[number]

export const PSD2_MOCK_SCENARIO_DEFAULT: Psd2MockScenario = 'active'

export class ProductionMockProviderError extends Error {
  constructor() {
    super(
      `[psd2] ${PSD2_PROVIDER_VAR}=${PSD2_PROVIDER_MOCK} är satt samtidigt som ` +
        'NODE_ENV=production. Mock-providern hittar på bankdata och matar den genom ' +
        'ingestFromApi — samma väg som en riktig bank — och får aldrig gälla i ' +
        'produktion. Fail-fast: ta bort variabeln, eller kör inte med ' +
        'NODE_ENV=production.',
    )
  }
}

export class UnknownMockScenarioError extends Error {
  constructor(varde: string) {
    super(
      `[psd2] ${PSD2_MOCK_SCENARIO_VAR}='${varde}' är inget känt scenario. ` +
        `Giltiga: ${PSD2_MOCK_SCENARIOS.join(' | ')} (default ${PSD2_MOCK_SCENARIO_DEFAULT}).`,
    )
  }
}

/**
 * Ren funktion, tar env explicit så den går att prova utan att röra process.env.
 *
 * @throws ProductionMockProviderError om mocken begärs i produktion.
 */
export function psd2MockRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  // Steg 1: allt utom exakt 'mock' ger ingen mock. Saknad, tom, 'MOCK', 'Mock',
  // 'true' — alla faller åt det säkra hållet.
  if (env[PSD2_PROVIDER_VAR] !== PSD2_PROVIDER_MOCK) return false

  // Steg 2: begärd mock i produktion är ett konfigurationsfel, inte ett val.
  // Kasta — anroparen (validateEnv / modul-factoryn) fail-fastar.
  if (env['NODE_ENV'] === 'production') throw new ProductionMockProviderError()

  return true
}

/**
 * Vilket scenario mocken ska spela upp. Läses BARA när mocken faktiskt valts —
 * variabeln är meningslös i alla andra lägen, och `validateEnv` granskar den
 * därför inte. Det är ett medvetet val och inte ett förbiseende: en variabel som
 * bara kan påverka en provider som är omöjlig i produktion kan inte fälla en
 * produktionsboot, och en kontroll som inte kan fälla något hör inte hemma i
 * boot-valideringen.
 *
 * SAKNAD/TOM → default. OKÄNT VÄRDE → KAST, inte tyst default. Skillnaden är
 * hela poängen: en felstavning (`PSD2_MOCK_SCENARIO=expired_`) som tyst gav
 * 'active' hade sett ut som att UI:t inte klarar EXPIRED-fallet, och felsökningen
 * hade riktats mot fel kod. Kastet kan bara nå dev och e2e.
 *
 * @throws UnknownMockScenarioError vid ett värde som inte står i PSD2_MOCK_SCENARIOS.
 */
export function psd2MockScenario(env: NodeJS.ProcessEnv = process.env): Psd2MockScenario {
  const raw = env[PSD2_MOCK_SCENARIO_VAR]
  if (raw === undefined || raw === '') return PSD2_MOCK_SCENARIO_DEFAULT
  const träff = PSD2_MOCK_SCENARIOS.find((s) => s === raw)
  if (!träff) throw new UnknownMockScenarioError(raw)
  return träff
}
