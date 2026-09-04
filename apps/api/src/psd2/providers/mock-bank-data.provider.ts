import type {
  BankDataProvider,
  ProviderAccount,
  ProviderTokens,
  ProviderConsentStatus,
  ProviderRawTx,
} from '../psd2.types'
import type { Psd2MockScenario } from '../psd2-provider-mode'

/**
 * Scenario → den status `getConsentStatus` rapporterar. Mängden är uttömmande
 * över `Psd2MockScenario` (Record, inte partial), så ett nytt scenario utan en
 * status blir ett typfel i stället för ett tyst fall tillbaka på ACTIVE.
 */
const SCENARIO_STATUS: Record<Psd2MockScenario, ProviderConsentStatus> = {
  active: 'ACTIVE',
  expired: 'EXPIRED',
  revoked: 'REVOKED',
  error: 'ERROR',
}

/**
 * Inflödet i dev/e2e. Litet, fast och deterministiskt med flit:
 *
 *  • FASTA `externalId` — en andra synk ska ge `duplicate`, inte nya rader.
 *    Det är idempotensen i `ingestFromApi` som demonstreras, och den syns bara
 *    om id:na är stabila mellan körningar.
 *  • FASTA datum — ett `new Date()` hade gjort utfallet beroende av dagen och
 *    därmed omöjligt att jämföra mellan två körningar.
 *  • `booked: true`, SEK och positiva belopp — annars avvisar `ingestFromApi`
 *    dem (NOT_BOOKED / NON_SEK / NON_POSITIVE) och dev-flödet hade sett trasigt
 *    ut medan det gjorde precis rätt.
 *
 * OCR-numren MATCHAR inte nödvändigtvis någon avi i din databas. Scenariot
 * bevisar INFLÖDET (rader skapas via samma väg som en riktig bank), inte
 * matchningen — den kräver avier med just dessa OCR, och att låta mocken hitta
 * på sådana hade gjort en grön matchning till en fiktion.
 */
const DEV_TRANSAKTIONER: readonly ProviderRawTx[] = [
  {
    externalId: 'mock-tx-1',
    bookingDate: new Date('2026-09-01T09:00:00Z'),
    booked: true,
    currency: 'SEK',
    amount: 8500,
    description: 'Inbetalning hyra september',
    ocr: '00123459',
  },
  {
    externalId: 'mock-tx-2',
    bookingDate: new Date('2026-09-02T09:00:00Z'),
    booked: true,
    currency: 'SEK',
    amount: 12250,
    description: 'Inbetalning hyra september',
    ocr: '00223457',
  },
  {
    externalId: 'mock-tx-3',
    bookingDate: new Date('2026-09-03T09:00:00Z'),
    booked: true,
    currency: 'SEK',
    amount: 4300,
    description: 'Swish inbetalning utan referens',
  },
]

/**
 * Skriptad testdubbel för bank-data-porten. Låter hela kedjan samtycke →
 * callback → sync → ingestFromApi → matchning testas UTAN nycklar/nätverk.
 * In-memory; deterministisk. Aldrig i produktion — DI-factoryn väljer den bara
 * utanför produktion, och `psd2MockRequested` kastar i den kombinationen.
 *
 * ── TVÅ SÄTT ATT SKRIPTA DEN, OCH DE RÖR INTE VARANDRA ──────────────────────
 *
 * 1. JEST — specarna sätter `transactions`, `consentStatus` och `accounts`
 *    DIREKT på instansen, precis som förut. Den vägen är OFÖRÄNDRAD: en
 *    parameterlös `new MockBankDataProvider()` ger exakt de gamla värdena
 *    (tom transaktionslista, ACTIVE, ett konto), och fälten är fortfarande
 *    skrivbara. Inget prov behövde ändras när scenariovägen lades till.
 *
 * 2. ENV — `PSD2_MOCK_SCENARIO` i dev och e2e. Scenariot läses ALDRIG här inne:
 *    `psd2MockScenario` tolkar variabeln i `psd2-provider-mode.ts` och factoryn
 *    skickar in resultatet som ett konstruktorargument. Klassen rör alltså inte
 *    `process.env`, vilket är hela skälet att den går att prova utan att någon
 *    nollställer miljön först (#685-formen).
 *
 * Scenariovägen finns BARA för dev och e2e — den ska göra det möjligt att se
 * bankkopplingens UI i alla fyra statuslägen och att få ett verkligt inflöde
 * genom `ingestFromApi` utan bankavtal. Den är inte en testmekanism för jest,
 * och specar ska inte gå via den: en spec som beskriver sitt eget fall är
 * läsbar, ett scenarionamn är det inte.
 *
 * ── VAD SCENARIOT INTE KAN VISA ─────────────────────────────────────────────
 *
 * `PSD2_MOCK_SCENARIO=error` får `getConsentStatus` att svara `ERROR`, men
 * `Psd2SyncService` skriver `statusCheck.status === 'REVOKED' ? 'REVOKED' :
 * 'EXPIRED'` — alltså landar ERROR som EXPIRED i `BankConsent.status`, och
 * UI:t visar EXPIRED. Statuskoden ERROR finns i schemat och renderas av
 * `BankConsentStatusBadge`, men den är i dag bara nåbar genom en direkt
 * DB-skrivning. Det är ett befintligt beteende i P2:s sync och ändras inte av
 * den här PR:en; det står här för att `error` annars ser ut att vara trasigt.
 */
export class MockBankDataProvider implements BankDataProvider {
  readonly name = 'MOCK'

  // Skriptas av testet: transaktioner som fetchTransactions returnerar.
  transactions: ProviderRawTx[] = []
  accounts: ProviderAccount[] = [{ accountId: 'acc-1', currency: 'SEK' }]
  consentStatus: ProviderConsentStatus = 'ACTIVE'
  revoked: string[] = []
  fetchCalls: Array<{ accountId: string; since?: string | undefined }> = []

  /**
   * Utan argument: exakt det gamla beteendet (jest-vägen). MED ett scenario:
   * dev/e2e-vägen, och då sätts fälten en gång i konstruktorn — de förblir
   * skrivbara efteråt, så ingen väg stänger den andra.
   */
  constructor(options?: { scenario?: Psd2MockScenario }) {
    const scenario = options?.scenario
    if (!scenario) return
    this.consentStatus = SCENARIO_STATUS[scenario]
    // Bara det aktiva scenariot ger inflöde. De tre andra ska visa ett dött
    // samtycke, och en död koppling som ändå levererar transaktioner vore en
    // fiktion som inte kan uppstå i verkligheten.
    this.transactions = scenario === 'active' ? DEV_TRANSAKTIONER.map((tx) => ({ ...tx })) : []
  }

  async beginConsent(input: {
    organizationId: string
    state: string
    redirectUri: string
  }): Promise<{ consentId: string; authUrl: string }> {
    return {
      consentId: `mock-consent-${input.organizationId}`,
      authUrl: `https://mock-bank.example/auth?state=${input.state}`,
    }
  }

  async exchangeCallback(input: { code: string; state: string }): Promise<ProviderTokens> {
    return {
      consentId: `mock-consent-${input.state}`,
      accessToken: `mock-access-${input.code}`,
      refreshToken: `mock-refresh-${input.code}`,
      scope: 'accounts transactions',
      expiresAt: new Date('2026-10-05T00:00:00Z'),
    }
  }

  async getConsentStatus(_input: {
    consentId: string
    accessToken: string
  }): Promise<{ status: ProviderConsentStatus; expiresAt?: Date }> {
    return { status: this.consentStatus }
  }

  async listAccounts(_input: {
    consentId: string
    accessToken: string
  }): Promise<ProviderAccount[]> {
    return this.accounts
  }

  async fetchTransactions(input: {
    consentId: string
    accessToken: string
    accountId: string
    since?: string | undefined
  }): Promise<{ transactions: ProviderRawTx[]; cursor?: string }> {
    this.fetchCalls.push({ accountId: input.accountId, since: input.since })
    return { transactions: this.transactions, cursor: 'mock-cursor-1' }
  }

  async revokeConsent(input: { consentId: string; accessToken: string }): Promise<void> {
    this.revoked.push(input.consentId)
  }
}
