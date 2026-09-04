import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'

import { bankIdProviderFactory } from './bankid.module'
import { SigningCryptoService } from '../signing/signing-crypto.service'
import { BANKID_PROVIDER } from './bankid.types'
import { StubBankIdProvider } from './providers/stub-bankid.provider'

/**
 * FLAGGAN VÄLJER PROVIDER — och det är den enda platsen flaggan känns till.
 *
 * ── VARFÖR PROVET GÅR GENOM DI-CONTAINERN OCH INTE ANROPAR FACTORYN DIREKT ──
 *
 * Ett prov som plockar ut `useFactory` och kallar den för hand mäter funktionen,
 * inte påkopplingen: det kan inte se att ett beroende är omöjligt att injicera.
 * Det är inte en farhåga — #580 skrev `import type { ConfigService }`, vilket
 * raderas i runtime, och 32 av 32 prov var gröna medan API:t inte startade alls.
 * Bara E2E såg det. Samma resonemang som `pii-coherence.di.spec.ts`, och det är
 * därför modulen byggs här i stället för att factoryn anropas.
 *
 * ── VARFÖR EN MINIMAL MODUL OCH INTE HELA BankidModule ───────────────────
 *
 * Sedan PR 2 importerar `BankidModule` även `AuthModule` (för
 * `issueTokensForUser`), och därmed `JwtModule`, `PrismaModule`, `MailModule`
 * och `AccountingModule`. Att bygga hela grafen bara för att fråga "vilken
 * provider väljer flaggan?" gjorde provet beroende av `JWT_SECRET` och en
 * databasattrapp — alltså av saker som inte har med frågan att göra, och som
 * fällde det med `Configuration key "JWT_SECRET" does not exist`.
 *
 * Den här specen bygger därför en minimal modul kring EXAKT de två providers
 * factoryn behöver. Att HELA modulen går att bygga är en annan fråga, och den
 * ställs av `bankid.di.spec.ts` — som också är den enda som kan se att
 * controllern får sin tjänst.
 *
 * Faktorn är utbruten ur modulfilen och delas av båda, så provet inte kan
 * prövas mot en kopia av logiken.
 *
 * VAD PROVET INTE KAN SE: att providern gör rätt när den väl valts. Det ägs av
 * `bankid.provider.spec.ts`. De två är olika frågor och ingen duger som den andra.
 */
@Module({
  providers: [
    SigningCryptoService,
    {
      provide: BANKID_PROVIDER,
      useFactory: bankIdProviderFactory,
      inject: [ConfigService, SigningCryptoService],
    },
  ],
})
class MinimalBankIdModule {}

async function bygg(env: Record<string, string>) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
      MinimalBankIdModule,
    ],
  }).compile()
}

describe('BankidModule — factoryn och påkopplingen', () => {
  it('flaggan AV → Stub, och modulen går att bygga i containern', async () => {
    const mod = await bygg({})
    expect(mod.get(BANKID_PROVIDER, { strict: false })).toBeInstanceOf(StubBankIdProvider)
    await mod.close()
  })

  it("flaggan satt till något annat än 'true' → Stub (fail-closed)", async () => {
    // Strikt likhet med 'true', inte truthiness: '1', 'yes' och 'TRUE' ska INTE
    // aktivera. En flagga som tänds av en slarvig sträng är värre än ingen flagga.
    for (const värde of ['1', 'yes', 'TRUE', 'True', 'false', '']) {
      const mod = await bygg({ BANKID_ENABLED: värde })
      expect(mod.get(BANKID_PROVIDER, { strict: false })).toBeInstanceOf(StubBankIdProvider)
      await mod.close()
    }
  })

  it('flaggan PÅ utan PII-nycklar → kastar vid bygget, om NYCKLARNA', async () => {
    await expect(bygg({ BANKID_ENABLED: 'true' })).rejects.toThrow(
      /SIGNING_PII_KEY\/SIGNING_PII_PEPPER saknas/,
    )
  })

  it('flaggan PÅ MED nycklar → kastar ändå, om den SAKNADE ADAPTERN', async () => {
    // Det andra kastet är hela poängen med S1: funktionen är redo men kan inte
    // tändas. Utan det här provet går det inte att skilja "krypto saknas" från
    // "det finns ingen adapter", och en framtida adapter kan smyga in utan att
    // någon märker att grinden försvann.
    await expect(
      bygg({
        BANKID_ENABLED: 'true',
        SIGNING_PII_KEY: 'a'.repeat(64),
        SIGNING_PII_PEPPER: 'x'.repeat(32),
      }),
    ).rejects.toThrow(/ingen skarp BankID-adapter/)
  })

  it('SIGNING_ENABLED tänder INTE BankID — egna funktioner, egna flaggor', async () => {
    // De delar nycklar men inte livsöde. Vore villkoret hopslaget hade en tänd
    // signering gett en aktiv BankID-väg utan att någon bett om det.
    const mod = await bygg({
      SIGNING_ENABLED: 'true',
      SIGNING_PII_KEY: 'a'.repeat(64),
      SIGNING_PII_PEPPER: 'x'.repeat(32),
    })
    expect(mod.get(BANKID_PROVIDER, { strict: false })).toBeInstanceOf(StubBankIdProvider)
    await mod.close()
  })
})
