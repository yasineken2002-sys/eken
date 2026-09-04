import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'

import { BankidModule } from './bankid.module'
import { BankIdAuthService } from './bankid-auth.service'
import { BankIdController } from './bankid.controller'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'

/**
 * ATT MODULEN GÅR ATT BYGGA — och att CONTROLLERN får sin tjänst.
 *
 * ── VARFÖR CONTROLLERN ÄR MED, OCH INTE BARA TJÄNSTEN ─────────────────────
 *
 * En controller kan bara injicera det som syns i SIN moduls kontext. Det är
 * MÄTT och inte antaget: en minimal reproduktion (controller i modul A, tjänst
 * bara i modul B, ingen modulimport) ger `Nest can't resolve dependencies`.
 *
 * Och `check-module-cycles` ser INTE det felet — den läser `imports:`, och i det
 * läget importerar modulen ingenting alls, så grafen ser ren ut. Felet hade
 * synts först vid boot. Det här provet ställer frågan på en sekund, av samma
 * skäl som `pii-coherence.di.spec.ts` finns (#580: `import type
 * { ConfigService }` gav 32/32 gröna prov medan API:t inte startade).
 *
 * VAD DET INTE KAN SE: att endpointsen gör rätt. Det ägs av
 * `bankid-auth.service.spec.ts`.
 */
describe('BankidModule — påkopplingen', () => {
  it('bygger med flaggan AV, och controllern får sin tjänst', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          // JWT_SECRET krävs av AuthModule:s JwtModule-factory (getOrThrow).
          load: [() => ({ JWT_SECRET: 'x'.repeat(32) })],
        }),
        BankidModule,
      ],
    })
      // Varken databas eller utgående mejl i ett enhetsprov — bara injicerbara.
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(MailService)
      .useValue({})
      .compile()

    expect(moduleRef.get(BankIdAuthService, { strict: false })).toBeInstanceOf(BankIdAuthService)
    expect(moduleRef.get(BankIdController, { strict: false })).toBeInstanceOf(BankIdController)
    await moduleRef.close()
  })
})
