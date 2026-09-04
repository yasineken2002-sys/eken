/**
 * FÅR MOCK-PROVIDERN VÄLJAS AV EN MILJÖVARIABEL? — och varför frågan ställs så här.
 *
 * ── MÄTNINGEN SOM FÖREGICK FILEN ────────────────────────────────────────────
 *
 * Signeringen och PSD2 har samma portmönster som BankID, och båda har en Mock.
 * Ingen av dem har en väg att välja den utanför jest: `MockSigningProvider`,
 * `MockBankDataProvider` och `MockBankIdProvider` konstrueras uteslutande av
 * specar, och de tre factory-funktionerna känner bara två utfall — Stub eller
 * fail-fast. Det finns alltså inget mönster att följa; det här är det första.
 *
 * Konsekvensen var att UI:t mot BankID inte kunde köras alls: en utvecklare som
 * startar dev-servern får en Stub som svarar 503 på varje endpoint, och en
 * E2E-spec kan inte logga in. Att bygga gränssnittet mot en yta som strukturellt
 * inte kan svara är att bygga blint.
 *
 * ── VARFÖR INTE BARA "SÄTT BANKID_PROVIDER" ─────────────────────────────────
 *
 * Samma resonemang som `auth-throttle-mode.ts`, och det är inte en analogi utan
 * samma defektform: en fri miljövariabel skapar en väg att köra PRODUKTION mot
 * en provider som intygar vem som helst. En felstavad variabel i Railway hade
 * gett en inloggning som alltid lyckas som "Test Testsson" — och ingenting hade
 * blivit rött.
 *
 * Valet är därför bundet till KÖRNINGSLÄGET, inte till ett värde:
 *
 *   1. Variabeln saknas, är tom eller har ett okänt värde  → INGEN mock. Alltid.
 *      Det finns inget värde som "råkar" välja mocken; bara exakt 'mock'.
 *   2. Variabeln är 'mock' OCH NODE_ENV=production          → KASTAR.
 *      Inte "olämpligt" — omöjligt. Appen vägrar starta.
 *
 * Punkt 2 kontrolleras vid boot av `validateEnv`, alltså före första requesten,
 * och OBEROENDE av `BANKID_ENABLED`. Det är avsiktligt: en produktionsmiljö som
 * bär `BANKID_PROVIDER=mock` är felkonfigurerad även när flaggan råkar vara av,
 * och ska upptäckas när variabeln sätts — inte den dag någon tänder flaggan.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Att någon konstruerar `MockBankIdProvider` direkt någon annanstans än i
 * factoryn eller i ett prov. Den vägen bär `bankid.module.spec.ts` (factoryns
 * fyra utfall), inte den här funktionen.
 */

export const BANKID_PROVIDER_VAR = 'BANKID_PROVIDER'

/** Det enda värdet som väljer mocken. Allt annat — inklusive 'MOCK' — gör det inte. */
export const BANKID_PROVIDER_MOCK = 'mock'

export class ProductionMockProviderError extends Error {
  constructor() {
    super(
      `[bankid] ${BANKID_PROVIDER_VAR}=${BANKID_PROVIDER_MOCK} är satt samtidigt som ` +
        'NODE_ENV=production. Mock-providern intygar en påhittad identitet utan att någon ' +
        'legitimerar sig och får aldrig gälla i produktion — fail-fast. Ta bort variabeln, ' +
        'eller kör inte med NODE_ENV=production.',
    )
  }
}

/**
 * Ren funktion, tar env explicit så den går att prova utan att röra process.env.
 *
 * @throws ProductionMockProviderError om mocken begärs i produktion.
 */
export function bankIdMockRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  // Steg 1: allt utom exakt 'mock' ger ingen mock. Saknad, tom, 'MOCK', 'Mock',
  // 'true' — alla faller åt det säkra hållet.
  if (env[BANKID_PROVIDER_VAR] !== BANKID_PROVIDER_MOCK) return false

  // Steg 2: begärd mock i produktion är ett konfigurationsfel, inte ett val.
  // Kasta — anroparen (validateEnv / modul-factoryn) fail-fastar.
  if (env['NODE_ENV'] === 'production') throw new ProductionMockProviderError()

  return true
}
