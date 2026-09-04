import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'

import { psd2ProviderFactory } from './psd2-provider.factory'
import { BankConsentCryptoService } from './bank-consent-crypto.service'
import { PSD2_PROVIDER } from './psd2.types'
import { MockBankDataProvider } from './providers/mock-bank-data.provider'
import { StubBankDataProvider } from './providers/stub-bank-data.provider'

/**
 * FLAGGAN VÄLJER PROVIDER — och det är den enda platsen flaggan känns till.
 *
 * ── VARFÖR PROVET GÅR GENOM DI-CONTAINERN OCH INTE ANROPAR FACTORYN DIREKT ──
 *
 * Ett prov som plockar ut `useFactory` och kallar den för hand mäter funktionen,
 * inte påkopplingen: det kan inte se att ett beroende är omöjligt att injicera.
 * Det är inte en farhåga — #580 skrev `import type { ConfigService }`, vilket
 * raderas i runtime, och 32 av 32 prov var gröna medan API:t inte startade alls.
 * Samma resonemang som `bankid.module.spec.ts`, och det är därför en modul byggs
 * här i stället för att factoryn anropas.
 *
 * ── VARFÖR FACTORYN BOR I EN EGEN FIL, OCH INTE I MODULEN ───────────────────
 *
 * `bankIdProviderFactory` står i sin modulfil, och den formen prövades här
 * först. Den gick inte: `psd2.module.ts` importerar `ReconciliationModule`, som
 * drar in `InvoicesModule` → `NotificationsModule` → `StorageService` →
 * `@aws-sdk/client-s3`. UPPMÄTT — specen föll på att jest inte kan parsa
 * aws-sdk:s ESM-utgåva, alltså av ett skäl som inte har med providervalet att
 * göra, och inget prov i sviten importerar den grafen i dag.
 *
 * Factoryn ligger därför i `psd2-provider.factory.ts` och importeras BÅDE av
 * modulen och av det här provet — samma funktion, inte en kopia. Den minimala
 * modulen nedan bygger EXAKT de två beroenden factoryn tar.
 *
 * ── VAD PROVET INTE KAN SE, OCH VAD SOM BÄR DET ─────────────────────────────
 *
 *  1. Att `psd2.module.ts` FAKTISKT kopplar in `psd2ProviderFactory`. Provet
 *     bygger sin egen modul; en modulfil som slutat referera factoryn hade sett
 *     likadan ut härifrån. Det bärs av e2e-provet i PR 2, som bootar hela API:t
 *     med `PSD2_PROVIDER=mock` — väljs Stub där svarar varje endpoint 503, och
 *     specen faller. Samma arbetsfördelning som BankID:s (`bankid.di.spec.ts`
 *     plus CI:s loggkontroll före första spec).
 *  2. Att providern gör RÄTT när den väl valts. Det ägs av
 *     `psd2-provider.spec.ts` (portkontraktet).
 */
@Module({
  providers: [
    BankConsentCryptoService,
    {
      provide: PSD2_PROVIDER,
      useFactory: psd2ProviderFactory,
      inject: [ConfigService, BankConsentCryptoService],
    },
  ],
})
class MinimalPsd2Module {}

/**
 * Nycklarna som fixturen levererar och som därför MÅSTE bort ur `process.env`
 * före bygget (#685).
 *
 * `ignoreEnvFile: true` skyddar mot FILEN apps/api/.env, aldrig mot en variabel
 * som redan står i miljön — och `process.env` VINNER över
 * `ConfigModule.forRoot({ load })`. Utlösaren är inte en utvecklare som körde
 * `set -a; . .env`, utan `@prisma/client`, som laddar filen vid IMPORT via en
 * relativ sökväg inbakad när `prisma generate` kördes. Samma commit, samma
 * katalog, olika utfall före och efter en regenerering.
 *
 * PSD2_MOCK_SCENARIO står med i listan även om `validateEnv` inte läser den:
 * factoryn GÖR det, och en utvecklare som kör dev-miljön med ett scenario satt
 * hade annars sett proven nedan välja ett annat utfall än de valde.
 *
 * NODE_ENV STÅR MED FLIT INTE HÄR. Jest sätter den till 'test', vilket inte är
 * 'production' och därför inte påverkar någon av grenarna nedan. Det ENDA provet
 * som behöver ett annat värde sätter `process.env.NODE_ENV` självt — se
 * kommentaren där.
 */
const FIXTURENS_NYCKLAR = [
  'PSD2_ENABLED',
  'PSD2_PROVIDER',
  'PSD2_MOCK_SCENARIO',
  'PSD2_TOKEN_KEY',
] as const

async function bygg(env: Record<string, string>) {
  const sparade = new Map<string, string | undefined>()
  for (const nyckel of FIXTURENS_NYCKLAR) {
    sparade.set(nyckel, process.env[nyckel])
    delete process.env[nyckel]
  }
  try {
    return await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
        MinimalPsd2Module,
      ],
    }).compile()
  } finally {
    // Tillbaka EXAKT, inklusive fallet "var inte satt".
    for (const [nyckel, varde] of sparade) {
      if (varde === undefined) delete process.env[nyckel]
      else process.env[nyckel] = varde
    }
  }
}

const MED_NYCKEL = { PSD2_ENABLED: 'true', PSD2_TOKEN_KEY: 'b'.repeat(64) }

describe('Psd2Module — factoryn och påkopplingen', () => {
  it('flaggan AV → Stub, och modulen går att bygga i containern', async () => {
    const mod = await bygg({})
    expect(mod.get(PSD2_PROVIDER, { strict: false })).toBeInstanceOf(StubBankDataProvider)
    await mod.close()
  })

  it("flaggan satt till något annat än 'true' → Stub (fail-closed)", async () => {
    // Strikt likhet med 'true', inte truthiness: '1', 'yes' och 'TRUE' ska INTE
    // aktivera. En flagga som tänds av en slarvig sträng är värre än ingen flagga.
    for (const värde of ['1', 'yes', 'TRUE', 'True', 'false', '']) {
      const mod = await bygg({ PSD2_ENABLED: värde })
      expect(mod.get(PSD2_PROVIDER, { strict: false })).toBeInstanceOf(StubBankDataProvider)
      await mod.close()
    }
  })

  it('flaggan PÅ utan PSD2_TOKEN_KEY → kastar vid bygget, om NYCKELN', async () => {
    await expect(bygg({ PSD2_ENABLED: 'true' })).rejects.toThrow(/PSD2_TOKEN_KEY saknas\/ogiltig/)
  })

  it('flaggan PÅ MED nyckel → kastar ändå, om den SAKNADE ADAPTERN', async () => {
    // Det andra kastet är hela poängen med P2: funktionen är redo men kan inte
    // tändas skarpt. Utan det här provet går det inte att skilja "krypto saknas"
    // från "det finns ingen adapter", och en framtida adapter kan smyga in utan
    // att någon märker att grinden försvann.
    await expect(bygg({ ...MED_NYCKEL })).rejects.toThrow(/ingen skarp bank-data-adapter/)
  })

  it("PSD2_PROVIDER='mock' utanför produktion → Mock i stället för kastet", async () => {
    const mod = await bygg({ ...MED_NYCKEL, PSD2_PROVIDER: 'mock' })
    expect(mod.get(PSD2_PROVIDER, { strict: false })).toBeInstanceOf(MockBankDataProvider)
    await mod.close()
  })

  it('mock-vägen ligger EFTER krypto-kontrollen — utan nyckel kastar den ändå', async () => {
    // Ordningen är lastbärande, men av ett ANNAT skäl än BankID:s. Där bar
    // nyckeln identitetsbindningen; här krypterar `PSD2_TOKEN_KEY` de tokens
    // mock-flödet FAKTISKT skriver i BankConsent via handleCallback. En mock som
    // byggdes utan nyckel hade kastat mitt i callbacken i stället för vid boot,
    // och felet hade sett ut som ett trasigt samtyckesflöde.
    await expect(bygg({ PSD2_ENABLED: 'true', PSD2_PROVIDER: 'mock' })).rejects.toThrow(
      /PSD2_TOKEN_KEY saknas\/ogiltig/,
    )
  })

  it('bara exakt "mock" väljer mocken — allt annat kastar som förut', async () => {
    // Kanariefågeln till provet ovan: utan den går det inte att skilja "regeln
    // träffar rätt värde" från "mock-grenen tas alltid".
    for (const värde of ['MOCK', 'Mock', 'true', '1', '']) {
      await expect(bygg({ ...MED_NYCKEL, PSD2_PROVIDER: värde })).rejects.toThrow(
        /ingen skarp bank-data-adapter/,
      )
    }
  })

  it('mock i PRODUKTION → kastar, och om MOCKEN — inte om adaptern', async () => {
    // Meddelandet spelar roll: hade det varit adapter-kastet såg det ut som en
    // vanlig P2-miljö, och den som läser loggen hade inte förstått att någon
    // begärt påhittad bankdata i produktion.
    //
    // NODE_ENV SÄTTS I process.env, INTE VIA `load`. Det är inte en omväg utan
    // hur mekaniken faktiskt fungerar: `process.env` VINNER över
    // `ConfigModule.forRoot({ load })` (#685), så ett `NODE_ENV: 'production'` i
    // fixturen hade tyst förlorat mot jests egna 'test' — och provet hade blivit
    // grönt av att mocken valdes, alltså exakt tvärtemot vad det påstår.
    const sparad = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(bygg({ ...MED_NYCKEL, PSD2_PROVIDER: 'mock' })).rejects.toThrow(
        /PSD2_PROVIDER=mock.*NODE_ENV=production/s,
      )
    } finally {
      if (sparad === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = sparad
    }
  })

  it('scenariot når providern — och ett okänt scenario fäller bygget', async () => {
    // Två riktningar i ett prov, därför att den ena utan den andra är tvetydig:
    // att `expired` ger EXPIRED bevisar att variabeln LÄSES, och att ett
    // trasigt värde kastar bevisar att den inte tyst faller tillbaka på 'active'
    // — vilket hade sett ut som att UI:t inte klarar EXPIRED-fallet.
    const mod = await bygg({ ...MED_NYCKEL, PSD2_PROVIDER: 'mock', PSD2_MOCK_SCENARIO: 'expired' })
    const provider = mod.get<MockBankDataProvider>(PSD2_PROVIDER, { strict: false })
    expect(provider.consentStatus).toBe('EXPIRED')
    expect(provider.transactions).toHaveLength(0)
    await mod.close()

    await expect(
      bygg({ ...MED_NYCKEL, PSD2_PROVIDER: 'mock', PSD2_MOCK_SCENARIO: 'EXPIRED' }),
    ).rejects.toThrow(/inget känt scenario/)
  })
})
