import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'

import { BankidModule } from './bankid.module'
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
 * VAD PROVET INTE KAN SE: att providern gör rätt när den väl valts. Det ägs av
 * `bankid.provider.spec.ts`. De två är olika frågor och ingen duger som den andra.
 */
async function bygg(env: Record<string, string>) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
      BankidModule,
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
